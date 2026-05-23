// TPM 预扣 (内存实现)
//
// 工作模型 (类比 Ch5 的 preConsume / postConsume 两阶段计费):
//
//   1. reserve(key, tokens, limit)
//        - 用「估算的 input + max_tokens」按 token 预算扣一份额度;
//        - 当前桶 + 待预扣 > limit, 拒;
//        - 不然桶累加预扣额度.
//
//   2. commit(key, reserved, actualTokens)
//        - 拿到真实 usage 后, 实结 = actualTokens;
//        - 调整桶 = 桶 - reserved + actual (= 桶 - (reserved - actual));
//        - 实际效果: 把多扣的 (reserved - actual) 退回, 或者把少扣的 (actual - reserved)
//          继续扣下去 (流式 token 超出 max_tokens 估算时会出现).
//
//   3. release(key, reserved)
//        - 上游失败 / 网络错时, 整笔预扣退回;
//        - 等价于 commit(key, reserved, 0).
//
// 窗口算法: 60s 滚动桶 (rolling minute bucket).
//   每个 key 一个 (windowStartMs, tokenCount) 二元组. 当 now - windowStartMs >= 60s
//   时, 重置 windowStart 到 now, tokenCount 归零.
//   这是「固定时间窗口」的简化版, 与 QPS 用的「滑动窗口」不同 - TPM 通常不需要那么精细
//   的边界控制 (上游本身的 TPM 限额也是「分钟级软限制」), 实现复杂度低很多.
//
// 与滑动窗口的对照:
//   - QPS 维度: 请求是离散事件, 请求间隔很短 (毫秒级), 边界 2x burst 影响很明显, 必须滑窗;
//   - TPM 维度: token 是连续配额, 即使发生 2x burst 也不会立刻打爆上游 (上游本身有
//     burst tolerance), 固定窗口够用, 实现简单 50%.
//
// 与 Ch5 计费的关系: TPM 与 Ch5 的余额扣减是「两套并行的两阶段控制」.
//   余额管「钱够不够」(401/402); TPM 管「频率够不够」(429). 都失败时余额会比 TPM 先扣
//   (preConsume 顺序), 但 release / refund 互不影响. 这种正交分层是 Portkey / one-api
//   都采用的设计.

import type { LimitKey, TpmReserveResult } from './types.js';

/** 默认 TPM 窗口 = 60s. */
const DEFAULT_WINDOW_MS = 60_000;

interface Bucket {
  windowStartMs: number;
  tokenCount: number;
}

export class TpmReservationLimiter {
  private readonly store = new Map<LimitKey, Bucket>();
  private readonly windowMs: number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * 预扣 tokens. limit = 0 视为不限.
   */
  reserve(key: LimitKey, tokens: number, limit: number): TpmReserveResult {
    if (limit <= 0) {
      return {
        ok: true,
        retryAfterMs: 0,
        currentTokens: 0,
        limit: 0,
        reservedTokens: tokens,
      };
    }
    const now = Date.now();
    let bucket = this.store.get(key);
    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      // 新窗口
      bucket = { windowStartMs: now, tokenCount: 0 };
      this.store.set(key, bucket);
    }

    if (bucket.tokenCount + tokens > limit) {
      // 拒绝, 等到窗口结束才有新名额
      const retryAfterMs = Math.max(1, bucket.windowStartMs + this.windowMs - now);
      return {
        ok: false,
        retryAfterMs,
        currentTokens: bucket.tokenCount,
        limit,
        reservedTokens: 0,
      };
    }
    bucket.tokenCount += tokens;
    return {
      ok: true,
      retryAfterMs: 0,
      currentTokens: bucket.tokenCount,
      limit,
      reservedTokens: tokens,
    };
  }

  /**
   * 实结: 用真实 usage 替换之前的预扣.
   *   净占用 = actual (不是 reserved)
   *   bucket.tokenCount += (actual - reserved)
   *     actual < reserved 时是退回 (减法)
   *     actual > reserved 时是继续扣 (流式超出 max_tokens 时)
   * 如果桶在两阶段之间过期了 (窗口已经滚动), 直接把净占用记到当前桶,
   * 不去回写老桶 (老窗口已不存在).
   */
  commit(key: LimitKey, reservedTokens: number, actualTokens: number): void {
    const delta = actualTokens - reservedTokens;
    if (delta === 0) return;

    const bucket = this.store.get(key);
    const now = Date.now();
    if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
      // 桶已过期或不存在: 净占用 actual 直接落到新桶
      // (退回的情况下 delta < 0, 也是「新桶 tokenCount = 0」, 没必要写)
      if (actualTokens > 0) {
        this.store.set(key, { windowStartMs: now, tokenCount: actualTokens });
      }
      return;
    }
    bucket.tokenCount = Math.max(0, bucket.tokenCount + delta);
  }

  /**
   * 全额释放预扣 (上游失败时调). 等价于 commit(key, reserved, 0).
   */
  release(key: LimitKey, reservedTokens: number): void {
    this.commit(key, reservedTokens, 0);
  }

  inspectTokens(key: LimitKey): number {
    const bucket = this.store.get(key);
    if (!bucket) return 0;
    const now = Date.now();
    if (now - bucket.windowStartMs >= this.windowMs) return 0;
    return bucket.tokenCount;
  }

  reset(): void {
    this.store.clear();
  }
}
