// 第 7 章 v0.7: SSE 流式透传 + 反向取消 + 流式计费闭环
//
// 相对 v0.6 的核心变化:
//   1. 新增 src/streaming/ 子系统:
//        - sse-proxy.ts          : SSE 透传主循环 + AbortController 反向取消 + 心跳
//        - event-normalizer.ts   : OpenAI / Anthropic chunk 统一接口 (extract / encode)
//        - counter.ts            : re-export Ch5 的 StreamingTokenCounter
//        - anthropic-events.ts   : 沿用 Ch3 的归一化器
//   2. adaptors/base.ts 加 3 个流式钩子: buildStreamRequest / newStreamState / parseStreamChunk;
//        - openai.ts: stream_options.include_usage 自动注入
//        - anthropic.ts: 流式状态用 AnthropicEventNormalizer 实例
//        - deepseek.ts: 继承自 openai, 无需改
//   3. 主路径 /v1/chat/completions: 检测 stream:true -> proxySSE 分支, 非流式分支不动;
//   4. 流式 finalize 路径: postConsumeStream (status=finalized / canceled / partial 三态)
//        + commitTpmReservations + commitMonthlyUsage 全闭环;
//   5. /v1/messages: 同样接通流式透传, 通过同一份 sse-proxy 主循环 (Anthropic 原生协议
//        透传到客户端; 内部仍走 AnthropicAdaptor 的 parseStreamChunk 抽 usage 给计费).
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 单一上游 Key; 风控 / 5xx 抖动时所有流式被中断, 无自动恢复 (Ch8 Channel 池)
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
  postConsumeStream,
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
import { proxySSE } from './streaming/sse-proxy.js';

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
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15000);

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
  // mock 上游: 仅在 stream-test 演示中使用, 接 scripts/mock-upstream.ts
  {
    prefix: 'mock-',
    adaptor: new OpenAIAdaptor({
      name: 'mock',
      baseURL: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
      apiKey: 'mock',
    }),
  },
]);

const app = new Hono<{ Variables: LimitVariables }>();

app.route('/admin', createAdminRouter());

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
      isStream: !!ir.stream,
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
      is_stream: !!ir.stream,
      est_prompt_tokens: reservation.estimatedPromptTokens,
      pre_reserved_micro_cny: reservation.preReservedCost,
      tpm_reservations: limitCtx.tpmReservations.length,
    },
    'billing_pre_consumed',
  );

  // ============================================================
  // 流式分支: 走 sse-proxy 主循环
  // ============================================================
  if (ir.stream) {
    return proxySSE({
      c,
      adaptor,
      ir,
      heartbeatMs: SSE_HEARTBEAT_MS,
      fallbackPromptTokens: reservation.estimatedPromptTokens,
      onFinalize: async (fin) => {
        // 四种路径:
        //   A) 上游未建立连接 (DNS / 401 / TCP RST 等, upstreamStatus = null
        //      或上游 ok=false). proxySSE 已经直接返响应给客户端, 这里走 refund;
        //   B) 上游正常 [DONE] / message_stop, 客户端没断          -> finalized;
        //   C) 客户端中途断开 (Ctrl+C / 关浏览器 tab)               -> canceled;
        //   D) 流读到中途上游断 (TCP 错 / 上游异常关连接)          -> partial.

        // A) 上游根本没建立: completionTokens 必然 0, prompt_tokens 来自 fallback,
        //    fin.upstreamStatus === null 是判定锚点.
        if (fin.upstreamStatus === null) {
          refundReservation(reservation.recordId, 'stream_upstream_unreachable');
          releaseTpmReservations(limitCtx.tpmReservations);
          logger.warn(
            {
              trace_id: traceId,
              record_id: reservation.recordId,
              upstream_status: fin.upstreamStatus,
              duration_ms: fin.durationMs,
            },
            'stream_refunded_no_output',
          );
          return;
        }

        // B/C/D 三种状态都进入 postConsumeStream, 区别仅在 terminalStatus
        const terminal: 'finalized' | 'canceled' | 'partial' = fin.upstreamFailed
          ? 'partial'
          : fin.abortedByClient
            ? 'canceled'
            : 'finalized';

        try {
          const settle = postConsumeStream({
            recordId: reservation.recordId,
            userId: auth.userId,
            model: ir.model,
            provider: adaptor.name,
            realPromptTokens: fin.promptTokens,
            realCompletionTokens: fin.completionTokens,
            terminalStatus: terminal,
          });
          commitTpmReservations(
            limitCtx.tpmReservations,
            fin.promptTokens + fin.completionTokens,
          );
          commitMonthlyUsage(auth.keyId, settle.finalCost);
          logger.info(
            {
              trace_id: traceId,
              record_id: reservation.recordId,
              provider: adaptor.name,
              model: ir.model,
              terminal_status: terminal,
              prompt_tokens: fin.promptTokens,
              completion_tokens: fin.completionTokens,
              final_cost_micro_cny: settle.finalCost,
              balance_delta_micro_cny: settle.balanceDelta,
              duration_ms: fin.durationMs,
            },
            'stream_settled',
          );
        } catch (err) {
          markFailed(reservation.recordId, `stream_postConsume_error: ${(err as Error).message}`);
          releaseTpmReservations(limitCtx.tpmReservations);
        }
      },
    });
  }

  // ============================================================
  // 非流式分支: 沿用 v0.6 主路径
  // ============================================================
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
// 旁路: /v1/messages (Anthropic 原生)
//   非流式: 透传请求, 透传响应
//   流式  : 走同一份 sse-proxy 主循环, 但下游协议保持 Anthropic 原生格式
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

  const isStream = /"stream"\s*:\s*true/.test(rawBody);

  const start = Date.now();

  // 流式: 直接把上游 Anthropic SSE 字节流透传给客户端, 不走 OpenAI 归一化.
  //       计费 / TPM 走简化路径 (v0.7 范围内: 仅记录 traceId + 日志, 不接 limit middleware
  //       因为本路由没经过 rateLimit). 详细的 /v1/messages 流式计费在 Ch8 渠道接入时一起做.
  if (isStream) {
    const ctrl = new AbortController();
    const clientSignal = c.req.raw.signal;
    if (clientSignal) {
      clientSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream' },
        body: rawBody,
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      logger.warn(
        {
          key_id: auth.keyId,
          user_id: auth.userId,
          route: '/v1/messages',
          aborted,
          err: (err as Error).message,
        },
        'anthropic_stream_upstream_failed',
      );
      return c.json({ error: { message: 'upstream stream error' } }, 502);
    }

    c.header('Content-Type', upstreamResp.headers.get('content-type') ?? 'text/event-stream');
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');

    // 把上游 SSE 字节流直接 pipe 给下游
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: {
        'Content-Type': upstreamResp.headers.get('content-type') ?? 'text/event-stream',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache',
      },
    });
  }

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
    version: 'v0.7',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
    streaming: {
      sse: true,
      heartbeat_ms: SSE_HEARTBEAT_MS,
    },
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
logger.info(`Gateway v0.7 listening on http://localhost:${port}`);
