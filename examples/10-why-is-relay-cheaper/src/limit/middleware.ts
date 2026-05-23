// 限流中间件 (Hono)
//
// 位置: auth middleware 之后, preConsume 之前.
//   auth: 知道 keyId / userId / orgId, 但未读 keys 表的 qps_limit / tpm_limit;
//   limit: 读 keys 表的限流配置, 做 QPS / TPM 检查, 通过则把 limitToken (TPM 预扣的
//          回滚句柄) 注入 ctx 供主路径在 postConsume / refund 时回调;
//   preConsume: Ch5 的余额预扣.
//
// 分层维度 (本章实现 key + model 两层, 预留 user / org / global):
//   - 全局: 进程内总 QPS, 用 key="global" (默认 0 = 不限)
//   - 按 Key: key=`key:${keyId}`, 配置存在 keys.qpsLimit / tpmLimit
//   - 按 Model: key=`model:${ir.model}`, 配置走环境变量 PER_MODEL_QPS_DEFAULT / PER_MODEL_TPM_DEFAULT
//
// 为什么分层? 不同维度防御不同攻击面:
//   - 按 Key 限流: 防单个客户端死循环打爆;
//   - 按 Model 限流: 防热门模型挤占其他模型的上游配额 (例如 gpt-4o 突发流量挤掉 gpt-4o-mini);
//   - 全局限流: 防整个网关把上游账户日内总配额一次性吃光.
//
// 一次请求会触发 1~3 个 check, 任意一个失败就拒, 失败时把已经成功的 reserveTpm 释放回去
// (避免「按 Key 通过、按 Model 失败」时, Key 那笔 TPM 一直占着).

import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { keys } from '../db/schema.js';
import { estimatePromptTokens } from '../billing/tokenizer.js';
import type { IRChatRequest } from '../types/ir.js';
import type { AuthVariables } from '../auth/middleware.js';
import { getSharedLimiter } from './memory-limiter.js';
import type { RateLimiter } from './types.js';

/** 已成功预扣的 TPM 句柄. 主路径在 postConsume / refund 时拿它做实结 / 释放. */
export interface TpmReservationHandle {
  /** 限流 key (key:42 / model:gpt-4o-mini / global) */
  limitKey: string;
  /** 预扣的 token 数 */
  reservedTokens: number;
}

export interface LimitContext {
  /** 本次请求由 limit middleware 预扣的 TPM 句柄列表 (按维度) */
  tpmReservations: TpmReservationHandle[];
  /** 估算的 prompt tokens (限流期间已经算过一次, 不让 preConsume 重复算) */
  estimatedPromptTokens: number;
}

export type LimitVariables = AuthVariables & { limit: LimitContext };

/**
 * 限流 + TPM 预扣中间件.
 *
 * 行为:
 *   1. 从 ctx 取 auth (keyId / userId), 联查 keys 表拿 qps_limit / tpm_limit;
 *   2. 解析 body 拿到 ir 估算 prompt tokens + max_tokens (默认 DEFAULT_MAX_TOKENS);
 *   3. 依次做 QPS check (按 key / 按 model / 全局), 任一失败立即 429;
 *   4. 依次做 TPM reserve (按 key / 按 model / 全局), 任一失败把已成功的释放掉后 429;
 *   5. 通过则把 LimitContext 注入 ctx, next().
 *
 * 注意: 这里要 read body, Hono 的 c.req.json() 会消费 stream, 所以下游 handler
 * 必须用 c.get('limit').estimatedPromptTokens 直接拿到结果, 同时用 c.req.json()
 * 再次读出来 (Hono 内部对 json() 做了缓存, 第二次读取直接返回 cached).
 */
export function rateLimitMiddleware(opts?: {
  limiter?: RateLimiter;
  defaultMaxTokens?: number;
  globalQpsLimit?: number;
  globalTpmLimit?: number;
  perModelQpsLimit?: number;
  perModelTpmLimit?: number;
}): MiddlewareHandler<{ Variables: LimitVariables }> {
  const limiter = opts?.limiter ?? getSharedLimiter();
  const defaultMaxTokens = opts?.defaultMaxTokens ?? 4096;
  const globalQpsLimit = opts?.globalQpsLimit ?? 0;
  const globalTpmLimit = opts?.globalTpmLimit ?? 0;
  const perModelQpsLimit = opts?.perModelQpsLimit ?? 0;
  const perModelTpmLimit = opts?.perModelTpmLimit ?? 0;

  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) {
      // 应该在 auth middleware 之后才挂载本中间件; 安全起见兜底
      return c.json({ error: { message: 'auth required before rate limit' } }, 401);
    }

    // ----- 读 body -----
    //   IRChatRequestSchema 的 zod 校验留给主 handler, 这里只做最浅度解析,
    //   失败时直接 400 (不进上游).
    let body: IRChatRequest;
    try {
      body = (await c.req.json()) as IRChatRequest;
    } catch {
      return c.json({ error: { message: 'invalid_request: body must be JSON' } }, 400);
    }
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return c.json({ error: { message: 'invalid_request: model/messages required' } }, 400);
    }

    // ----- 读 keys 行配置 -----
    const db = getDb();
    const rows = db
      .select({
        qpsLimit: keys.qpsLimit,
        tpmLimit: keys.tpmLimit,
      })
      .from(keys)
      .where(eq(keys.id, auth.keyId))
      .all();
    const cfg = rows[0] ?? { qpsLimit: 0, tpmLimit: 0 };

    // ----- 估算 prompt tokens (用于 TPM 预扣) -----
    const estimatedPromptTokens = estimatePromptTokens(body.messages, body.model);
    const maxOutputTokens =
      typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : defaultMaxTokens;
    const tpmReserveAmount = estimatedPromptTokens + maxOutputTokens;

    // ----- QPS 检查 (按 Key / 按 Model / 全局) -----
    const keyLimitKey = `key:${auth.keyId}`;
    const modelLimitKey = `model:${body.model}`;
    const globalLimitKey = 'global';

    const qpsChecks: Array<{ key: string; limit: number; label: string }> = [
      { key: keyLimitKey, limit: cfg.qpsLimit, label: 'key' },
      { key: modelLimitKey, limit: perModelQpsLimit, label: 'model' },
      { key: globalLimitKey, limit: globalQpsLimit, label: 'global' },
    ];

    for (const ch of qpsChecks) {
      const r = limiter.checkQps(ch.key, ch.limit);
      if (!r.ok) {
        return rateLimitResponse(c, {
          dimension: ch.label,
          kind: 'qps',
          limitKey: ch.key,
          limit: r.limit,
          current: r.currentCount,
          retryAfterMs: r.retryAfterMs,
        });
      }
    }

    // ----- TPM 预扣 (按 Key / 按 Model / 全局), 失败时释放已成功的 -----
    const tpmReservations: TpmReservationHandle[] = [];
    const tpmChecks: Array<{ key: string; limit: number; label: string }> = [
      { key: keyLimitKey, limit: cfg.tpmLimit, label: 'key' },
      { key: modelLimitKey, limit: perModelTpmLimit, label: 'model' },
      { key: globalLimitKey, limit: globalTpmLimit, label: 'global' },
    ];
    for (const ch of tpmChecks) {
      if (ch.limit <= 0) {
        // 不限制维度不入 tpmReservations, 后续 postConsume 也不去 commit (省一次空操作)
        continue;
      }
      const r = limiter.reserveTpm(ch.key, tpmReserveAmount, ch.limit);
      if (!r.ok) {
        // 回滚之前已经成功的 TPM 预扣, 不让客户端的「下一次按 Key 检查」吃这次失败的额度
        for (const handle of tpmReservations) {
          limiter.releaseTpm(handle.limitKey, handle.reservedTokens);
        }
        return rateLimitResponse(c, {
          dimension: ch.label,
          kind: 'tpm',
          limitKey: ch.key,
          limit: r.limit,
          current: r.currentTokens,
          retryAfterMs: r.retryAfterMs,
        });
      }
      tpmReservations.push({ limitKey: ch.key, reservedTokens: r.reservedTokens });
    }

    // ----- 通过, 把限流上下文注入 ctx -----
    c.set('limit', { tpmReservations, estimatedPromptTokens });
    await next();
  };
}

/** 统一的 429 响应. 必带 Retry-After 头 (HTTP 语义: 秒数). */
function rateLimitResponse(
  c: Parameters<MiddlewareHandler>[0],
  detail: {
    dimension: string;
    kind: 'qps' | 'tpm';
    limitKey: string;
    limit: number;
    current: number;
    retryAfterMs: number;
  },
) {
  const retryAfterSec = Math.max(1, Math.ceil(detail.retryAfterMs / 1000));
  c.header('Retry-After', String(retryAfterSec));
  return c.json(
    {
      error: {
        type: 'rate_limit_exceeded',
        message: `${detail.kind} limit exceeded on dimension=${detail.dimension}`,
        dimension: detail.dimension,
        kind: detail.kind,
        limit_key: detail.limitKey,
        limit: detail.limit,
        current: detail.current,
        retry_after_ms: detail.retryAfterMs,
      },
    },
    429,
  );
}

/**
 * 主路径在 postConsume 成功 / refund 时调.
 * - postConsume: 用真实 (prompt + completion) tokens 实结 TPM (多退少补)
 * - refund:      上游失败, 整笔预扣释放回去 (actualTotal = 0)
 */
export function commitTpmReservations(
  reservations: TpmReservationHandle[],
  actualTotalTokens: number,
  limiter: RateLimiter = getSharedLimiter(),
): void {
  for (const handle of reservations) {
    limiter.commitTpm(handle.limitKey, handle.reservedTokens, actualTotalTokens);
  }
}

export function releaseTpmReservations(
  reservations: TpmReservationHandle[],
  limiter: RateLimiter = getSharedLimiter(),
): void {
  for (const handle of reservations) {
    limiter.releaseTpm(handle.limitKey, handle.reservedTokens);
  }
}
