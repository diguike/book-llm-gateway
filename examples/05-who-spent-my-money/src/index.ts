// 第 5 章 v0.5: 两阶段计费 + UsageRecord 落账
//
// 相对 v0.4 的核心变化:
//   1. 新增 prices / usage_records 表 + users 表加 balance_micro / user_multiplier
//      (见 drizzle/0002_billing.sql);
//   2. /v1/chat/completions 主路径接入 preConsume -> 调上游 -> postConsume / refund;
//   3. 启动时灌入默认价格 (DB 为空时), 避免冷启 prices 表为空导致请求 400;
//   4. tiktoken 估算与上游 usage 双路对账, 流式计数器 API 就位 (Ch7 接入).
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 不限流, 单把 Key 可以打爆上游配额 (Ch6)
//   - 流式仍未做 (Ch7); /v1/messages 旁路本章先不接入计费 (Ch7 再做)
//   - 渠道池, 故障转移 (Ch8)
//   - 结构化日志, 看板 (Ch9)

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
import { requireGatewayKey, type AuthVariables } from './auth/middleware.js';
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

// ============================================================
// 装配上游 adaptor (与 v0.4 一致, 上游 Key 仍走环境变量)
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

const app = new Hono<{ Variables: AuthVariables }>();

app.route('/admin', createAdminRouter());

// ============================================================
// 主路径: /v1/chat/completions
//   v0.5 新增: 两阶段计费
//     preConsume -> 调上游 -> postConsume (成功)
//                          -> refundReservation (上游错 / 网络错)
//                          -> markFailed (postConsume 自身抛错)
// ============================================================
app.post('/v1/chat/completions', requireGatewayKey, async (c) => {
  const auth = c.get('auth');

  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  if (ir.stream) {
    return c.json(
      { error: { message: 'streaming is not supported in v0.5; will be added in Ch7' } },
      400,
    );
  }

  const adaptor = router.resolve(ir.model);
  if (!adaptor) {
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

  // 一次请求一个 trace_id, 落账 + 后续 Ch9 看板按它反查全链路
  const traceId = randomBytes(16).toString('hex');
  const maxOutputTokens =
    typeof ir.max_tokens === 'number' && ir.max_tokens > 0 ? ir.max_tokens : DEFAULT_MAX_TOKENS;

  // ----- preConsume: 预扣 + 写 reserved 行 -----
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
        {
          error: {
            type: 'price_not_configured',
            message: err.message,
          },
        },
        400,
      );
    }
    throw err;
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
    // 网络错: refund 全额, 不计费
    refundReservation(reservation.recordId, `network_error: ${(err as Error).message}`);
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
    // 上游业务错: refund 全额 (本次请求没真正消耗上游 token), 透传上游错误
    refundReservation(
      reservation.recordId,
      `upstream_${upstreamResp.status}: ${rawBody.slice(0, 200)}`,
    );
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

  // ----- postConsume: 拿 usage 实结 -----
  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  const usage = irResponse.usage;
  if (!usage) {
    // 上游没返 usage: fallback 用本地估算
    //   prompt: 用 preConsume 阶段算出的 estimatedPromptTokens
    //   completion: 对 message.content 跑一次 tiktoken
    const fallbackCompletionText =
      typeof irResponse.choices?.[0]?.message?.content === 'string'
        ? (irResponse.choices[0].message.content as string)
        : '';
    try {
      const settle = postConsume({
        recordId: reservation.recordId,
        userId: auth.userId,
        model: ir.model,
        provider: adaptor.name,
        realPromptTokens: reservation.estimatedPromptTokens,
        realCompletionTokens: estimateCompletionTokens(fallbackCompletionText, ir.model),
      });
      logger.warn(
        { trace_id: traceId, record_id: reservation.recordId, settle },
        'billing_settled_no_upstream_usage',
      );
    } catch (err) {
      markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
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
    }
  }

  return c.json(irResponse, 200);
});

// ============================================================
// 旁路: /v1/messages
//   本章保持 v0.4 的行为, 仍套鉴权, 但暂不接入计费.
//   Ch7 流式透传章接入计费时一并处理 (Anthropic 原生协议下 usage 字段在流式末尾才出现).
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
            '/v1/messages streaming passthrough is not implemented in v0.5, will be added in Ch7',
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

// 健康检查 (不鉴权, 方便外部探活)
app.get('/healthz', (c) =>
  c.json({
    ok: true,
    version: 'v0.5',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.5 listening on http://localhost:${port}`);
