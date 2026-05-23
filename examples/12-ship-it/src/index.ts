// 第 12 章 v1.0: 一键上线最小原型
//
// 相对 v0.11 的核心变化:
//   1. 新增 src/config/env.ts: 用 zod 校验所有环境变量, 启动时一次性检查.
//      错误时打印缺失字段并 process.exit(1). 业务代码不再 process.env.X 散读.
//   2. 新增 src/health/ 子系统:
//        - liveness.ts  : /healthz 探针 (k8s liveness, 失败重启 pod)
//        - readiness.ts : /readyz 探针 (k8s readiness, 失败摘流; 跑 DB ping +
//                         channel 数 + wallets 表健康度三项检查).
//   3. 新增 drizzle/0008_v1_release.sql 标识 v1.0 版本 (无 schema 变更, 仅元数据);
//      0001-0007 全部保留, 让从 v0.4 一路跟过来的读者也能 npm run migrate 跑通.
//   4. 新增 Dockerfile (多阶段构建) + docker-compose.yml (gateway + mock-upstream +
//      mock-payment-platform 三个服务一起拉起).
//   5. 新增 scripts/e2e-smoke.ts (端到端冒烟: 鉴权 → 路由 → 计费 → 渠道切换 → 流式 →
//      看板可见 一次完整请求生命周期) 与 scripts/stress.ts (autocannon 压测).
//
// 与 v0.11 的能力一致, 这一章不增加业务功能, 只做「孤岛缝合 + 上线」的工程整合.
// 9 项核心能力 (路由 / 协议转换 / 鉴权 / 计费 / 限流 / 渠道 / 流式 / 可观测性 /
// 成本优化) 全部继承自 v0.11.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { runMigrations } from './db/migrate.js';
import { requireGatewayKey } from './auth/middleware.js';
import { createAdminRouter } from './admin/routes.js';
import { createDashboardRouter } from './dashboard/routes.js';
import {
  preConsume,
  postConsume,
  postConsumeStream,
  refundReservation,
  markFailed,
  recordObservability,
  InsufficientBalanceError,
  WalletMissingError,
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
import { traceMiddleware, type TraceVariables } from './log/middleware.js';
import { getRootLogger } from './log/logger.js';
import {
  pickCheapestChannel,
  extractCacheUsageFromOpenAI,
  enqueueBatchRequest,
} from './optimization/index.js';
import { bootstrapPaymentAdaptors } from './payment/registry.js';
import { createPaymentRouter } from './admin/payment-routes.js';
import { loadEnv } from './config/env.js';
import { createLivenessRouter } from './health/liveness.js';
import { createReadinessRouter } from './health/readiness.js';

// v1.0: 启动时一次性校验所有 env. 失败直接 process.exit(1).
const env = loadEnv();
const bootLogger = getRootLogger();
bootLogger.info({ node_env: env.NODE_ENV, port: env.PORT }, 'env_validated');

// ============================================================
// 启动前: migration + 默认价格灌库 + 默认 channel 灌库
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  bootLogger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}
const seedResult = seedDefaultPricesIfEmpty();
if (seedResult.inserted > 0) {
  bootLogger.info({ inserted: seedResult.inserted }, 'default_prices_seeded');
}
const channelSeed = seedDefaultChannelsIfEmpty();
if (channelSeed.inserted > 0) {
  bootLogger.info({ inserted: channelSeed.inserted }, 'default_channels_seeded');
}

// 首次访问触发 rebuild
getChannelRegistry();

// v1.0: 所有 env 已经在 loadEnv() 校验过, 这里直接用强类型 env.
bootstrapPaymentAdaptors({
  mock: {
    baseUrl: env.MOCK_PAY_BASE_URL,
    notifyUrl: `${env.PAYMENT_NOTIFY_BASE}/payment/notify/mock`,
    secret: env.MOCK_PAY_SECRET,
  },
});
bootLogger.info(
  { mock_pay_base: env.MOCK_PAY_BASE_URL, notify_base: env.PAYMENT_NOTIFY_BASE },
  'payment_adaptors_bootstrapped',
);

const DEFAULT_MAX_TOKENS = env.DEFAULT_MAX_TOKENS;
const GLOBAL_QPS_LIMIT = env.GLOBAL_QPS_LIMIT;
const GLOBAL_TPM_LIMIT = env.GLOBAL_TPM_LIMIT;
const PER_MODEL_QPS_LIMIT = env.PER_MODEL_QPS_LIMIT;
const PER_MODEL_TPM_LIMIT = env.PER_MODEL_TPM_LIMIT;
const SSE_HEARTBEAT_MS = env.SSE_HEARTBEAT_MS;
const DEFAULT_GROUP = env.DEFAULT_GROUP;
const MAX_CHANNEL_ATTEMPTS = env.MAX_CHANNEL_ATTEMPTS;
const HEALTH_CHECK_INTERVAL_MS = env.HEALTH_CHECK_INTERVAL_MS;

startHealthChecker({ intervalMs: HEALTH_CHECK_INTERVAL_MS });

// v0.9: trace_id middleware 在最外层挂载, 所有路由 (包括 admin / dashboard / chat) 都拿到 trace_id
type AppVariables = TraceVariables & LimitVariables;
const app = new Hono<{ Variables: AppVariables }>();
app.use('*', traceMiddleware);

// dashboard 必须挂在 /admin 之前 (Hono 按注册顺序匹配前缀):
// /admin/dashboard/* 走看板专用鉴权 (query string token), 不进 admin 的 Bearer middleware.
app.route('/admin/dashboard', createDashboardRouter());
app.route('/admin', createAdminRouter());

// v0.11: 支付平台异步回调. 不经 admin Bearer 鉴权 (平台拿不到 token), 凭 PaymentAdaptor 验签.
app.route('/payment', createPaymentRouter());

// v1.0: 健康检查端点. 不走任何 middleware (trace 除外, 但 trace 是无副作用的).
// /healthz: liveness, k8s 失败重启 pod;
// /readyz : readiness, k8s 失败摘流, 跑 DB + channels + wallets_table 三项检查.
app.route('/healthz', createLivenessRouter());
app.route('/readyz', createReadinessRouter({ requireWallet: env.READINESS_REQUIRE_WALLET }));

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
  const logger = c.get('logger');
  const traceId = c.get('trace_id');
  const auth = c.get('auth');
  const limitCtx = c.get('limit');

  // 把 user_id / key_id 也 bind 进 logger, 后续所有 log 都自动带这两个
  const reqLogger = logger.child({ user_id: auth.userId, key_id: auth.keyId, org_id: auth.orgId });

  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    releaseTpmReservations(limitCtx.tpmReservations);
    reqLogger.warn({ error_code: 'invalid_request' }, 'invalid_request');
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  // v0.10: 主选 channel 改用成本路由 (cost_priority asc 优先).
  // priority='low' 的请求会走 batch 异步通道 (在主体逻辑后单独分支).
  const isBatch = ir.priority === 'low';
  const firstPick = pickCheapestChannel(DEFAULT_GROUP, ir.model, {
    requireBatch: isBatch,
  });
  if (!firstPick) {
    releaseTpmReservations(limitCtx.tpmReservations);
    reqLogger.warn(
      { model: ir.model, batch: isBatch, error_code: 'no_active_channel' },
      'no_active_channel',
    );
    return c.json(
      {
        error: {
          message: `no active channel for model: ${ir.model}${isBatch ? ' (batch)' : ''}`,
          group: DEFAULT_GROUP,
        },
      },
      503,
    );
  }

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
      reqLogger.warn(
        {
          model: ir.model,
          required: err.required,
          available: err.available,
          error_code: 'insufficient_quota',
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
    if (err instanceof WalletMissingError) {
      reqLogger.error(
        { user_id: err.userId, error_code: 'wallet_missing' },
        'wallet_missing_for_user',
      );
      return c.json(
        {
          error: {
            type: 'wallet_missing',
            message: 'wallet not initialized for this user. run admin/wallets/seed to create one.',
            user_id: err.userId,
          },
        },
        409,
      );
    }
    if (err instanceof PriceNotFoundError) {
      reqLogger.error({ error_code: 'price_not_configured', err: err.message }, 'price_not_configured');
      return c.json({ error: { type: 'price_not_configured', message: err.message } }, 400);
    }
    throw err;
  }

  // ----- 月度配额检查 (沿用 Ch6) -----
  const quota = checkMonthlyQuota(auth.keyId, reservation.preReservedCost);
  if (!quota.ok) {
    refundReservation(reservation.recordId, 'monthly_quota_exceeded');
    releaseTpmReservations(limitCtx.tpmReservations);
    reqLogger.warn(
      {
        model: ir.model,
        used: quota.used,
        limit: quota.limit,
        error_code: 'monthly_quota_exceeded',
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

  reqLogger.info(
    {
      record_id: reservation.recordId,
      model: ir.model,
      first_channel_id: firstPick.channel.id,
      first_channel_name: firstPick.channel.name,
      first_channel_cost_priority: firstPick.channel.costPriority,
      is_stream: !!ir.stream,
      batch_mode: isBatch,
      est_prompt_tokens: reservation.estimatedPromptTokens,
      pre_reserved_micro_cny: reservation.preReservedCost,
    },
    'billing_pre_consumed',
  );

  // ============================================================
  // 故障转移主循环
  // ============================================================
  const excludeIds = new Set<number>();
  const attemptedChannels: number[] = [];

  for (let attempt = 0; attempt < MAX_CHANNEL_ATTEMPTS; attempt++) {
    const picked =
      attempt === 0
        ? firstPick
        : pickCheapestChannel(DEFAULT_GROUP, ir.model, {
            excludeIds,
            requireBatch: isBatch,
          });
    if (!picked) {
      refundReservation(reservation.recordId, 'all_channels_failed');
      releaseTpmReservations(limitCtx.tpmReservations);
      recordObservability({
        recordId: reservation.recordId,
        channelId: null,
        upstreamLatencyMs: null,
        attemptedChannels,
      });
      reqLogger.error(
        {
          model: ir.model,
          attempted_channels: attemptedChannels,
          error_code: 'all_channels_failed',
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
    const upstreamStart = Date.now();

    if (ir.stream) {
      // ----- 流式分支: tryConnectStream 首字节前可重试 -----
      const result = await tryConnectStream(picked.adaptor, ir);

      if (result.kind === 'failed') {
        const cls = result.classification;
        reqLogger.warn(
          {
            attempt,
            channel_id: picked.channel.id,
            channel_name: picked.channel.name,
            provider: picked.adaptor.name,
            status: result.status,
            class: cls.class,
            reason: cls.reason,
            upstream_latency_ms: Date.now() - upstreamStart,
            error_code: `upstream_${cls.class}`,
          },
          'stream_upstream_failed_pre_byte',
        );

        if (cls.class === 'transparent') {
          refundReservation(reservation.recordId, `transparent_${result.status}`);
          releaseTpmReservations(limitCtx.tpmReservations);
          recordObservability({
            recordId: reservation.recordId,
            channelId: picked.channel.id,
            upstreamLatencyMs: Date.now() - upstreamStart,
            attemptedChannels,
          });
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

      reqLogger.info(
        {
          attempt,
          channel_id: picked.channel.id,
          channel_name: picked.channel.name,
          provider: picked.adaptor.name,
          attempted_channels: attemptedChannels,
          upstream_latency_ms: Date.now() - upstreamStart,
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
        startedAt: upstreamStart,
        onFinalize: async (fin) => {
          if (fin.upstreamStatus === null) {
            refundReservation(reservation.recordId, 'stream_upstream_unreachable');
            releaseTpmReservations(limitCtx.tpmReservations);
            recordObservability({
              recordId: reservation.recordId,
              channelId: picked.channel.id,
              upstreamLatencyMs: fin.durationMs,
              attemptedChannels,
            });
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
              // v0.10: 流式场景下的 cache 命中需要从上游 SSE message_start / event 抽取,
              // 教学版简化: 流式不解析 cached_input_tokens (主要在非流式 demo 看效果).
              // 真实实现把 cache 字段加进 StreamingTokenCounter, 一起累加.
              batchMode: isBatch,
              terminalStatus: terminal,
            });
            commitTpmReservations(
              limitCtx.tpmReservations,
              fin.promptTokens + fin.completionTokens,
            );
            commitMonthlyUsage(auth.keyId, settle.finalCost);
            recordObservability({
              recordId: reservation.recordId,
              channelId: picked.channel.id,
              upstreamLatencyMs: fin.durationMs,
              attemptedChannels,
            });
            reqLogger.info(
              {
                record_id: reservation.recordId,
                channel_id: picked.channel.id,
                channel_name: picked.channel.name,
                model: ir.model,
                provider: picked.adaptor.name,
                terminal_status: terminal,
                prompt_tokens: fin.promptTokens,
                completion_tokens: fin.completionTokens,
                final_cost_micro_cny: settle.finalCost,
                attempted_channels: attemptedChannels,
                upstream_latency_ms: fin.durationMs,
              },
              'stream_settled',
            );
          } catch (err) {
            markFailed(
              reservation.recordId,
              `stream_postConsume_error: ${(err as Error).message}`,
            );
            releaseTpmReservations(limitCtx.tpmReservations);
            reqLogger.error(
              { err: (err as Error).message, error_code: 'stream_postConsume_error' },
              'stream_postConsume_error',
            );
          }
        },
      });
    }

    // ----- 非流式分支 -----
    const nonStreamResp = await tryNonStreamUpstream(picked.adaptor, ir);
    const upstreamLatencyMs = Date.now() - upstreamStart;
    if (nonStreamResp.kind === 'success') {
      const usage = nonStreamResp.response.usage;
      try {
        if (usage) {
          // v0.10: 从 usage 里抽 cached_input_tokens (OpenAI / DeepSeek 兼容字段),
          // postConsume 会按 cache 单价单独计费这部分.
          const cacheUsage = extractCacheUsageFromOpenAI(usage);
          const settle = postConsume({
            recordId: reservation.recordId,
            userId: auth.userId,
            model: ir.model,
            provider: picked.adaptor.name,
            realPromptTokens: usage.prompt_tokens,
            realCompletionTokens: usage.completion_tokens,
            cachedInputTokens: cacheUsage.cachedInputTokens,
            batchMode: isBatch,
          });
          commitTpmReservations(
            limitCtx.tpmReservations,
            usage.prompt_tokens + usage.completion_tokens,
          );
          commitMonthlyUsage(auth.keyId, settle.finalCost);
          recordObservability({
            recordId: reservation.recordId,
            channelId: picked.channel.id,
            upstreamLatencyMs,
            attemptedChannels,
          });
          reqLogger.info(
            {
              record_id: reservation.recordId,
              channel_id: picked.channel.id,
              channel_name: picked.channel.name,
              model: ir.model,
              provider: picked.adaptor.name,
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              cached_input_tokens: cacheUsage.cachedInputTokens,
              cache_cost_micro_cny: settle.cacheCost ?? 0,
              batch_mode: isBatch,
              final_cost_micro_cny: settle.finalCost,
              attempted_channels: attemptedChannels,
              upstream_latency_ms: upstreamLatencyMs,
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
          recordObservability({
            recordId: reservation.recordId,
            channelId: picked.channel.id,
            upstreamLatencyMs,
            attemptedChannels,
          });
        }
      } catch (err) {
        markFailed(reservation.recordId, `postConsume_error: ${(err as Error).message}`);
        releaseTpmReservations(limitCtx.tpmReservations);
        reqLogger.error(
          { err: (err as Error).message, error_code: 'postConsume_error' },
          'postConsume_error',
        );
      }
      return c.json(nonStreamResp.response, 200);
    }

    // 非流式失败 -> 错误分类决定换不换
    const cls = nonStreamResp.classification;
    reqLogger.warn(
      {
        attempt,
        channel_id: picked.channel.id,
        channel_name: picked.channel.name,
        provider: picked.adaptor.name,
        status: nonStreamResp.status,
        class: cls.class,
        reason: cls.reason,
        upstream_latency_ms: upstreamLatencyMs,
        error_code: `upstream_${cls.class}`,
      },
      'non_stream_upstream_failed',
    );
    if (cls.class === 'transparent') {
      refundReservation(reservation.recordId, `transparent_${nonStreamResp.status}`);
      releaseTpmReservations(limitCtx.tpmReservations);
      recordObservability({
        recordId: reservation.recordId,
        channelId: picked.channel.id,
        upstreamLatencyMs,
        attemptedChannels,
      });
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
  recordObservability({
    recordId: reservation.recordId,
    channelId: null,
    upstreamLatencyMs: null,
    attemptedChannels,
  });
  reqLogger.error(
    {
      model: ir.model,
      attempted_channels: attemptedChannels,
      error_code: 'max_attempts_exceeded',
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
  const logger = c.get('logger');
  const auth = c.get('auth');
  const reqLogger = logger.child({ user_id: auth.userId, key_id: auth.keyId });

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
      reqLogger.warn(
        {
          route: '/v1/messages',
          err: (err as Error).message,
          error_code: 'anthropic_stream_upstream_failed',
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
    reqLogger.error(
      {
        route: '/v1/messages',
        err: (err as Error).message,
        error_code: 'upstream_network_error',
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const respText = await upstreamResp.text();
  reqLogger.info(
    {
      route: '/v1/messages',
      status: upstreamResp.status,
      upstream_latency_ms: Date.now() - start,
    },
    'relay_messages_passthrough',
  );

  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

// /admin/info: v1.0 状态总览 (替代旧的 /healthz inline view)
app.get('/admin/info', (c) => {
  const registry = getChannelRegistry();
  const snap = registry.snapshot();
  return c.json({
    ok: true,
    version: 'v1.0',
    node_env: env.NODE_ENV,
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

const port = env.PORT;
serve({ fetch: app.fetch, port });
bootLogger.info({ port, version: 'v1.0' }, 'gateway_listening');
