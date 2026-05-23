// 第 6 章 v0.6: 分层限流 + 月度配额
//
// 相对 v0.5 的核心变化:
//   1. 新增 0003_quota.sql: keys 表加 qps_limit / tpm_limit / monthly_quota_micro
//      / monthly_used_micro / quota_reset_at 五列;
//   2. 新增 src/limit/ 目录: RateLimiter 接口 + sliding-window (QPS) +
//      tpm-reservation (TPM 预扣) + memory-limiter (组合) + middleware (Hono);
//   3. 主路径在 auth middleware 之后接入 rateLimit middleware:
//        auth -> rateLimit (QPS check + TPM reserve) -> preConsume (余额预扣) -> 月度配额检查
//             -> 调上游
//             -> postConsume + commitTpm + commitMonthlyUsage
//             -> refund + releaseTpm (上游失败 / 配额不足时)
//   4. admin 接口加 /admin/keys/:id/limits (设置) 和 /admin/keys/:id/usage-window (查窗口).
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 流式仍未做 (Ch7); 限流的 TPM 维度在 stream=true 上要等 streaming-counter 接入;
//   - 渠道池 / 故障转移 (Ch8)
//   - 结构化日志 / 看板 (Ch9)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { OpenAIAdaptor } from './adaptors/openai.js';
import { DeepSeekAdaptor } from './adaptors/deepseek.js';
import { AnthropicAdaptor } from './adaptors/anthropic.js';
import { ModelRouter } from './router.js';
import { runMigrations } from './db/migrate.js';
import { requireGatewayKey } from './auth/middleware.js';
import { createAdminRouter } from './admin/routes.js';
import {
  preConsume,
  postConsume,
  refundReservation,
  markFailed,
  InsufficientBalanceError,
  PriceNotFoundError,
} from './billing/calculator.js';
import { seedDefaultPricesIfEmpty } from './billing/prices.js';
import { estimateCompletionTokens } from './billing/tokenizer.js';
import { checkMonthlyQuota, commitMonthlyUsage } from './billing/quota.js';
import {
  rateLimitMiddleware,
  commitTpmReservations,
  releaseTpmReservations,
  type LimitVariables,
} from './limit/middleware.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ============================================================
// 启动前: migration + 默认价格灌库
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  logger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}
const seedResult = seedDefaultPricesIfEmpty();
if (seedResult.inserted > 0) {
  logger.info({ inserted: seedResult.inserted }, 'default_prices_seeded');
}

const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 4096);
const GLOBAL_QPS_LIMIT = Number(process.env.GLOBAL_QPS_LIMIT ?? 0);
const GLOBAL_TPM_LIMIT = Number(process.env.GLOBAL_TPM_LIMIT ?? 0);
const PER_MODEL_QPS_LIMIT = Number(process.env.PER_MODEL_QPS_LIMIT ?? 0);
const PER_MODEL_TPM_LIMIT = Number(process.env.PER_MODEL_TPM_LIMIT ?? 0);

// ============================================================
// 装配上游 adaptor
// ============================================================
const anthropicAdaptor = new AnthropicAdaptor({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? '2023-06-01',
});

const router = new ModelRouter([
  {
    prefix: 'deepseek-',
    adaptor: new DeepSeekAdaptor({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    }),
  },
  {
    prefix: 'claude-',
    adaptor: anthropicAdaptor,
  },
  {
    prefix: 'gpt-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o1-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o3-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
]);

const app = new Hono<{ Variables: LimitVariables }>();

app.route('/admin', createAdminRouter());

// 限流 middleware 实例
const rateLimit = rateLimitMiddleware({
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  globalQpsLimit: GLOBAL_QPS_LIMIT,
  globalTpmLimit: GLOBAL_TPM_LIMIT,
  perModelQpsLimit: PER_MODEL_QPS_LIMIT,
  perModelTpmLimit: PER_MODEL_TPM_LIMIT,
});

// ============================================================
// 主路径: /v1/chat/completions
// ============================================================
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
  const auth = c.get('auth');
  const limitCtx = c.get('limit');

  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    releaseTpmReservations(limitCtx.tpmReservations);
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  if (ir.stream) {
    releaseTpmReservations(limitCtx.tpmReservations);
    return c.json(
      { error: { message: 'streaming is not supported in v0.6; will be added in Ch7' } },
      400,
    );
  }

  const adaptor = router.resolve(ir.model);
  if (!adaptor) {
    releaseTpmReservations(limitCtx.tpmReservations);
    return c.json(
      {
        error: {
          message: `no provider matched for model: ${ir.model}`,
          available: router.describe(),
        },
      },
      400,
    );
  }

  const traceId = randomBytes(16).toString('hex');
  const maxOutputTokens =
    typeof ir.max_tokens === 'number' && ir.max_tokens > 0 ? ir.max_tokens : DEFAULT_MAX_TOKENS;

  // ----- preConsume: 余额预扣 + 写 reserved 行 -----
  let reservation;
  try {
    reservation = preConsume({
      traceId,
      userId: auth.userId,
      orgId: auth.orgId,
      keyId: auth.keyId,
      model: ir.model,
      provider: adaptor.name,
      messages: ir.messages,
      maxOutputTokens,
      isStream: false,
    });
  } catch (err) {
    releaseTpmReservations(limitCtx.tpmReservations);
    if (err instanceof InsufficientBalanceError) {
      logger.warn(
        {
          trace_id: traceId,
          user_id: auth.userId,
          required: err.required,
          available: err.available,
        },
        'insufficient_balance',
      );
      return c.json(
        {
          error: {
            type: 'insufficient_quota',
            message: 'balance is not enough to cover the reservation',
            required_micro_cny: err.required,
            available_micro_cny: err.available,
          },
        },
        402,
      );
    }
    if (err instanceof PriceNotFoundError) {
      return c.json(
        { error: { type: 'price_not_configured', message: err.message } },
        400,
      );
    }
    throw err;
  }

  // ----- v0.6: 月度配额检查 -----
  const quota = checkMonthlyQuota(auth.keyId, reservation.preReservedCost);
  if (!quota.ok) {
    refundReservation(reservation.recordId, 'monthly_quota_exceeded');
    releaseTpmReservations(limitCtx.tpmReservations);
    logger.warn(
      {
        trace_id: traceId,
        key_id: auth.keyId,
        used: quota.used,
        limit: quota.limit,
        reserving: quota.reserving,
      },
      'monthly_quota_exceeded',
    );
    return c.json(
      {
        error: {
          type: 'monthly_quota_exceeded',
          message: 'monthly quota for this key has been exhausted',
          used_micro_cny: quota.used,
          limit_micro_cny: quota.limit,
          reserving_micro_cny: quota.reserving,
        },
      },
      402,
    );
  }

  logger.info(
    {
      trace_id: traceId,
      record_id: reservation.recordId,
      user_id: auth.userId,
      key_id: auth.keyId,
      model: ir.model,
      provider: adaptor.name,
      est_prompt_tokens: reservation.estimatedPromptTokens,
      pre_reserved_micro_cny: reservation.preReservedCost,
      tpm_reservations: limitCtx.tpmReservations.length,
    },
    'billing_pre_consumed',
  );

  // ----- 调上游 -----
  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);

  let upstreamResp: Response;
  const start = Date.now();
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    refundReservation(reservation.recordId, `network_error: ${(err as Error).message}`);
    releaseTpmReservations(limitCtx.tpmReservations);
    logger.error(
      {
        trace_id: traceId,
        record_id: reservation.recordId,
        provider: adaptor.name,
        model: ir.model,
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();
  const latencyMs = Date.now() - start;

  if (!upstreamResp.ok) {
    refundReservation(
      reservation.recordId,
      `upstream_${upstreamResp.status}: ${rawBody.slice(0, 200)}`,
    );
    releaseTpmReservations(limitCtx.tpmReservations);
    logger.warn(
      {
        trace_id: traceId,
        record_id: reservation.recordId,
        provider: adaptor.name,
        model: ir.model,
        status: upstreamResp.status,
        latency_ms: latencyMs,
      },
      'upstream_error_refunded',
    );
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ----- postConsume: 拿 usage 实结 + 实结 TPM + 累加月度已用 -----
  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  const usage = irResponse.usage;
  if (!usage) {
    const fallbackCompletionText =
      typeof irResponse.choices?.[0]?.message?.content === 'string'
        ? (irResponse.choices[0].message.content as string)
        : '';
    const realPromptTokens = reservation.estimatedPromptTokens;
    const realCompletionTokens = estimateCompletionTokens(fallbackCompletionText, ir.model);
    try {
      const settle = postConsume({
        recordId: reservation.recordId,
        userId: auth.userId,
        model: ir.model,
        provider: adaptor.name,
        realPromptTokens,
        realCompletionTokens,
      });
      commitTpmReservations(limitCtx.tpmReservations, realPromptTokens + realCompletionTokens);
      commitMonthlyUsage(auth.keyId, settle.finalCost);
      logger.warn(
        { trace_id: traceId, record_id: reservation.recordId, settle },
        'billing_settled_no_upstream_usage',
      );
    } catch (err) {
      markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
      releaseTpmReservations(limitCtx.tpmReservations);
    }
  } else {
    try {
      const settle = postConsume({
        recordId: reservation.recordId,
        userId: auth.userId,
        model: ir.model,
        provider: adaptor.name,
        realPromptTokens: usage.prompt_tokens,
        realCompletionTokens: usage.completion_tokens,
      });
      commitTpmReservations(
        limitCtx.tpmReservations,
        usage.prompt_tokens + usage.completion_tokens,
      );
      commitMonthlyUsage(auth.keyId, settle.finalCost);
      logger.info(
        {
          trace_id: traceId,
          record_id: reservation.recordId,
          provider: adaptor.name,
          model: ir.model,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          est_prompt_tokens: reservation.estimatedPromptTokens,
          token_diff: usage.prompt_tokens - reservation.estimatedPromptTokens,
          final_cost_micro_cny: settle.finalCost,
          balance_delta_micro_cny: settle.balanceDelta,
          latency_ms: latencyMs,
        },
        'billing_settled',
      );
    } catch (err) {
      markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
      releaseTpmReservations(limitCtx.tpmReservations);
    }
  }

  return c.json(irResponse, 200);
});

// ============================================================
// 旁路: /v1/messages (Anthropic 原生, Ch7 接入流式 + 限流)
// ============================================================
app.post('/v1/messages', requireGatewayKey, async (c) => {
  const auth = c.get('auth');
  const rawBody = await c.req.text();
  const baseURL = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );

  const clientVersion =
    c.req.header('anthropic-version') ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const clientBeta = c.req.header('anthropic-beta');

  const headers: Record<string, string> = {
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': clientVersion,
    'Content-Type': 'application/json',
  };
  if (clientBeta) headers['anthropic-beta'] = clientBeta;

  if (rawBody.includes('"stream":true') || rawBody.includes('"stream" : true')) {
    return c.json(
      {
        error: {
          message:
            '/v1/messages streaming passthrough is not implemented in v0.6, will be added in Ch7',
        },
      },
      400,
    );
  }

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
  } catch (err) {
    logger.error(
      {
        key_id: auth.keyId,
        user_id: auth.userId,
        route: '/v1/messages',
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const respText = await upstreamResp.text();
  logger.info(
    {
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
      route: '/v1/messages',
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay_messages_passthrough',
  );

  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    version: 'v0.6',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
    limits: {
      global_qps: GLOBAL_QPS_LIMIT,
      global_tpm: GLOBAL_TPM_LIMIT,
      per_model_qps: PER_MODEL_QPS_LIMIT,
      per_model_tpm: PER_MODEL_TPM_LIMIT,
    },
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.6 listening on http://localhost:${port}`);
