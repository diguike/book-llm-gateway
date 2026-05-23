// 第 8 章 v0.8: 渠道池 + 故障转移
//
// 相对 v0.7 的核心变化:
//   1. 新增 src/channels/ 子系统:
//        - classifier.ts       : 错误分类 (transparent / retryable / disable / throttle)
//        - registry.ts         : ChannelRegistry, 启动时全量从 DB 加载到内存
//        - weighted-picker.ts  : priority 分层 + 同层 weight 随机
//        - router.ts           : pickChannelForModel + buildAdaptorForChannel
//        - store.ts            : channels / abilities 双表 CRUD
//        - health-checker.ts   : 后台 worker, 每 60s 扫 disabled 探活恢复
//   2. 新增 drizzle/0004_channels.sql: channels + abilities 两张表
//   3. db/schema.ts 增 channels + abilities + 关联类型
//   4. 新增 src/streaming/sse-connect.ts: 把流式上游的「fetch + 状态判定」抽出来,
//      让主路径能在首字节前换 channel; sse-proxy.ts 改成接受「已连接的 Response」.
//   5. 主路径 /v1/chat/completions 改成 attemptWithFailover() 包一层:
//        - 非流式: fetch 失败 / status 触发 disable/throttle/retryable -> 换 channel
//        - 流式  : tryConnectStream 失败 (首字节前) -> 换 channel; 一旦 streamFromConnected
//                  开始 enqueue 就不再换
//   6. admin 新增 /admin/channels CRUD + /admin/channels/probe-now
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 日志是非结构化 console.log + pino 默认格式, 按 trace_id 反查全链路靠 grep (Ch9)
//   - 渠道倍率没接进计费快照 (multiplier_snapshot 还是 user × model 两路, Ch10 接成本优化时补)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
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
import { streamFromConnected } from './streaming/sse-proxy.js';
import { tryConnectStream } from './streaming/sse-connect.js';
import {
  pickChannelForModel,
  classifyError,
  markChannelDisabled,
  startHealthChecker,
  getChannelRegistry,
  type ChannelEntry,
} from './channels/index.js';
import type { ProviderAdaptor } from './adaptors/base.js';
import type { IRChatRequest, IRChatResponse } from './types/ir.js';
import { seedDefaultChannelsIfEmpty } from './channels/seed.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ============================================================
// 启动前: migration + 默认价格灌库 + 默认 channel 灌库
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  logger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}
const seedResult = seedDefaultPricesIfEmpty();
if (seedResult.inserted > 0) {
  logger.info({ inserted: seedResult.inserted }, 'default_prices_seeded');
}
const channelSeed = seedDefaultChannelsIfEmpty();
if (channelSeed.inserted > 0) {
  logger.info({ inserted: channelSeed.inserted }, 'default_channels_seeded');
}

// 首次访问触发 rebuild
getChannelRegistry();

const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 4096);
const GLOBAL_QPS_LIMIT = Number(process.env.GLOBAL_QPS_LIMIT ?? 0);
const GLOBAL_TPM_LIMIT = Number(process.env.GLOBAL_TPM_LIMIT ?? 0);
const PER_MODEL_QPS_LIMIT = Number(process.env.PER_MODEL_QPS_LIMIT ?? 0);
const PER_MODEL_TPM_LIMIT = Number(process.env.PER_MODEL_TPM_LIMIT ?? 0);
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 15000);
const DEFAULT_GROUP = process.env.DEFAULT_GROUP ?? 'default';
const MAX_CHANNEL_ATTEMPTS = Number(process.env.MAX_CHANNEL_ATTEMPTS ?? 3);
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 60_000);

// 启动后台 health-checker
startHealthChecker({ intervalMs: HEALTH_CHECK_INTERVAL_MS });

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

  // 选第一个 channel 用于 preConsume (主要拿 provider 算 multiplier);
  // 后续如果换 channel, multiplier_snapshot 不再变 (本章简化, Ch10 再细化).
  const firstPick = pickChannelForModel(DEFAULT_GROUP, ir.model);
  if (!firstPick) {
    releaseTpmReservations(limitCtx.tpmReservations);
    return c.json(
      {
        error: {
          message: `no active channel for model: ${ir.model}`,
          group: DEFAULT_GROUP,
        },
      },
      503,
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
      provider: firstPick.adaptor.name,
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
      return c.json({ error: { type: 'price_not_configured', message: err.message } }, 400);
    }
    throw err;
  }

  // ----- 月度配额检查 (沿用 Ch6) -----
  const quota = checkMonthlyQuota(auth.keyId, reservation.preReservedCost);
  if (!quota.ok) {
    refundReservation(reservation.recordId, 'monthly_quota_exceeded');
    releaseTpmReservations(limitCtx.tpmReservations);
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
      first_channel_id: firstPick.channel.id,
      is_stream: !!ir.stream,
      est_prompt_tokens: reservation.estimatedPromptTokens,
      pre_reserved_micro_cny: reservation.preReservedCost,
    },
    'billing_pre_consumed',
  );

  // ============================================================
  // 故障转移主循环
  //   按 priority 分层 + weight 加权选 channel, 失败按 classifier 决定换不换:
  //     - transparent: 透传给客户端, 不重试, 退预扣
  //     - retryable  : 换 channel 重试 (累加 excludeIds)
  //     - disable    : markChannelDisabled, 换 channel 重试
  //     - throttle   : markChannelDisabled (短期, health-checker 5 分钟后探活), 换 channel
  // ============================================================
  const excludeIds = new Set<number>();
  const attemptedChannels: number[] = [];

  for (let attempt = 0; attempt < MAX_CHANNEL_ATTEMPTS; attempt++) {
    const picked =
      attempt === 0 ? firstPick : pickChannelForModel(DEFAULT_GROUP, ir.model, excludeIds);
    if (!picked) {
      refundReservation(reservation.recordId, 'all_channels_failed');
      releaseTpmReservations(limitCtx.tpmReservations);
      logger.error(
        {
          trace_id: traceId,
          model: ir.model,
          attempted_channels: attemptedChannels,
        },
        'no_more_channels',
      );
      return c.json(
        {
          error: {
            type: 'all_channels_failed',
            message: 'all channels for this model have been tried and failed',
            attempted_channels: attemptedChannels,
          },
        },
        502,
      );
    }
    attemptedChannels.push(picked.channel.id);

    if (ir.stream) {
      // ----- 流式分支: tryConnectStream 首字节前可重试 -----
      const start = Date.now();
      const result = await tryConnectStream(picked.adaptor, ir);

      if (result.kind === 'failed') {
        const cls = result.classification;
        logger.warn(
          {
            trace_id: traceId,
            attempt,
            channel_id: picked.channel.id,
            channel_name: picked.channel.name,
            status: result.status,
            class: cls.class,
            reason: cls.reason,
          },
          'stream_upstream_failed_pre_byte',
        );

        if (cls.class === 'transparent') {
          refundReservation(reservation.recordId, `transparent_${result.status}`);
          releaseTpmReservations(limitCtx.tpmReservations);
          return new Response(result.body, {
            status: result.status ?? 502,
            headers: { 'Content-Type': result.contentType ?? 'application/json' },
          });
        }

        if (cls.class === 'disable' || cls.class === 'throttle') {
          markChannelDisabled(picked.channel.id, cls.reason);
        }
        excludeIds.add(picked.channel.id);
        continue;
      }

      // 连接成功 -> 进入「首字节后」, 不再切 channel
      logger.info(
        {
          trace_id: traceId,
          attempt,
          channel_id: picked.channel.id,
          attempted: attemptedChannels,
        },
        'stream_upstream_connected',
      );
      return streamFromConnected({
        c,
        upstreamResp: result.upstreamResp,
        upstreamCtrl: result.upstreamCtrl,
        adaptor: picked.adaptor,
        ir,
        heartbeatMs: SSE_HEARTBEAT_MS,
        fallbackPromptTokens: reservation.estimatedPromptTokens,
        startedAt: start,
        onFinalize: async (fin) => {
          if (fin.upstreamStatus === null) {
            refundReservation(reservation.recordId, 'stream_upstream_unreachable');
            releaseTpmReservations(limitCtx.tpmReservations);
            return;
          }
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
              provider: picked.adaptor.name,
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
                channel_id: picked.channel.id,
                terminal_status: terminal,
                prompt_tokens: fin.promptTokens,
                completion_tokens: fin.completionTokens,
                final_cost_micro_cny: settle.finalCost,
                attempted_channels: attemptedChannels,
                duration_ms: fin.durationMs,
              },
              'stream_settled',
            );
          } catch (err) {
            markFailed(
              reservation.recordId,
              `stream_postConsume_error: ${(err as Error).message}`,
            );
            releaseTpmReservations(limitCtx.tpmReservations);
          }
        },
      });
    }

    // ----- 非流式分支 -----
    const nonStreamResp = await tryNonStreamUpstream(picked.adaptor, ir);
    if (nonStreamResp.kind === 'success') {
      const usage = nonStreamResp.response.usage;
      try {
        if (usage) {
          const settle = postConsume({
            recordId: reservation.recordId,
            userId: auth.userId,
            model: ir.model,
            provider: picked.adaptor.name,
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
              channel_id: picked.channel.id,
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              final_cost_micro_cny: settle.finalCost,
              attempted_channels: attemptedChannels,
            },
            'billing_settled',
          );
        } else {
          const text =
            typeof nonStreamResp.response.choices?.[0]?.message?.content === 'string'
              ? (nonStreamResp.response.choices[0].message.content as string)
              : '';
          const realCompletionTokens = estimateCompletionTokens(text, ir.model);
          const settle = postConsume({
            recordId: reservation.recordId,
            userId: auth.userId,
            model: ir.model,
            provider: picked.adaptor.name,
            realPromptTokens: reservation.estimatedPromptTokens,
            realCompletionTokens,
          });
          commitTpmReservations(
            limitCtx.tpmReservations,
            reservation.estimatedPromptTokens + realCompletionTokens,
          );
          commitMonthlyUsage(auth.keyId, settle.finalCost);
        }
      } catch (err) {
        markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
        releaseTpmReservations(limitCtx.tpmReservations);
      }
      return c.json(nonStreamResp.response, 200);
    }

    // 非流式失败 -> 错误分类决定换不换
    const cls = nonStreamResp.classification;
    logger.warn(
      {
        trace_id: traceId,
        attempt,
        channel_id: picked.channel.id,
        status: nonStreamResp.status,
        class: cls.class,
        reason: cls.reason,
      },
      'non_stream_upstream_failed',
    );
    if (cls.class === 'transparent') {
      refundReservation(reservation.recordId, `transparent_${nonStreamResp.status}`);
      releaseTpmReservations(limitCtx.tpmReservations);
      return new Response(nonStreamResp.body, {
        status: nonStreamResp.status ?? 502,
        headers: { 'Content-Type': nonStreamResp.contentType ?? 'application/json' },
      });
    }
    if (cls.class === 'disable' || cls.class === 'throttle') {
      markChannelDisabled(picked.channel.id, cls.reason);
    }
    excludeIds.add(picked.channel.id);
  }

  refundReservation(reservation.recordId, 'max_attempts_exceeded');
  releaseTpmReservations(limitCtx.tpmReservations);
  logger.error(
    {
      trace_id: traceId,
      model: ir.model,
      attempted_channels: attemptedChannels,
    },
    'max_attempts_exceeded',
  );
  return c.json(
    {
      error: {
        type: 'max_attempts_exceeded',
        message: 'gateway tried multiple channels but all failed',
        attempted_channels: attemptedChannels,
      },
    },
    502,
  );
});

// ============================================================
// 非流式上游请求 + 错误分类
// ============================================================
type NonStreamResult =
  | { kind: 'success'; response: IRChatResponse }
  | {
      kind: 'failed';
      classification: ReturnType<typeof classifyError>;
      status: number | null;
      body: string;
      contentType: string | null;
    };

async function tryNonStreamUpstream(
  adaptor: ProviderAdaptor,
  ir: IRChatRequest,
): Promise<NonStreamResult> {
  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);
  let resp: Response;
  try {
    resp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    return {
      kind: 'failed',
      classification: classifyError({ status: null, networkError: err as Error }),
      status: null,
      body: (err as Error).message,
      contentType: null,
    };
  }
  const rawBody = await resp.text();
  if (!resp.ok) {
    return {
      kind: 'failed',
      classification: classifyError({ status: resp.status, body: rawBody }),
      status: resp.status,
      body: rawBody,
      contentType: resp.headers.get('content-type'),
    };
  }
  // 即使 200 也扫一遍 body, 有些 OpenAI 兼容上游用 200 + error.body 表达鉴权失败
  const cls = classifyError({ status: resp.status, body: rawBody });
  if (cls.class === 'disable' || cls.class === 'throttle') {
    return {
      kind: 'failed',
      classification: cls,
      status: resp.status,
      body: rawBody,
      contentType: resp.headers.get('content-type'),
    };
  }
  try {
    const parsed = await adaptor.parseResponse(resp, rawBody);
    return { kind: 'success', response: parsed };
  } catch (err) {
    return {
      kind: 'failed',
      classification: classifyError({
        status: resp.status,
        body: `parse_error: ${(err as Error).message}`,
      }),
      status: resp.status,
      body: rawBody,
      contentType: resp.headers.get('content-type'),
    };
  }
}

// ============================================================
// /v1/messages: Anthropic 原生入站 (沿用 v0.7, 不接渠道池)
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
      logger.warn(
        {
          key_id: auth.keyId,
          user_id: auth.userId,
          route: '/v1/messages',
          err: (err as Error).message,
        },
        'anthropic_stream_upstream_failed',
      );
      return c.json({ error: { message: 'upstream stream error' } }, 502);
    }

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

app.get('/healthz', (c) => {
  const registry = getChannelRegistry();
  const snap = registry.snapshot();
  return c.json({
    ok: true,
    version: 'v0.8',
    channels: {
      total: snap.length,
      active: snap.filter((s: ChannelEntry) => s.status === 'active').length,
      disabled: snap.filter((s: ChannelEntry) => s.status === 'disabled').length,
      probing: snap.filter((s: ChannelEntry) => s.status === 'probing').length,
    },
    streaming: {
      sse: true,
      heartbeat_ms: SSE_HEARTBEAT_MS,
      max_channel_attempts: MAX_CHANNEL_ATTEMPTS,
    },
    health_checker: {
      interval_ms: HEALTH_CHECK_INTERVAL_MS,
    },
    limits: {
      global_qps: GLOBAL_QPS_LIMIT,
      global_tpm: GLOBAL_TPM_LIMIT,
      per_model_qps: PER_MODEL_QPS_LIMIT,
      per_model_tpm: PER_MODEL_TPM_LIMIT,
    },
  });
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.8 listening on http://localhost:${port}`);
