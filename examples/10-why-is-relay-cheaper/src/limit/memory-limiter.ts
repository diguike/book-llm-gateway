// 内存版 RateLimiter: 把 sliding-window (QPS) 与 tpm-reservation (TPM) 组合起来,
// 对外暴露统一的 RateLimiter 接口.
//
// 选择 in-memory 实现的工程理由:
//   1. 单进程教学场景 (本书目标), 内存数据足够;
//   2. 主进程主线程同步, Node.js 单线程模型天然原子 (不存在多线程 race);
//   3. 重启时窗口数据丢失没关系 - 实际生产里限流的「最坏 1 秒漏过 limit 倍流量」
//      在重启瞬间出现, 不影响 SLA.
//
// 替换 Redis adapter 的入口: 实现同一份 RateLimiter 接口即可, 上层中间件不动.
// Redis 版关键改动:
//   - sliding-window: 用 Redis ZSET, ZADD 时间戳, ZREMRANGEBYSCORE 删过期, ZCARD 取长度,
//     用 Lua 脚本保证原子;
//   - tpm-reservation: 用 INCRBY + EXPIRE 60s, 或 token bucket Lua 脚本.
// Portkey 的实现见 src/shared/services/cache/utils/rateLimiter.ts (Redis + Lua).

import { SlidingWindowQpsLimiter } from './sliding-window.js';
import { TpmReservationLimiter } from './tpm-reservation.js';
import type {
  LimitKey,
  QpsCheckResult,
  RateLimiter,
  TpmReserveResult,
} from './types.js';

export class MemoryRateLimiter implements RateLimiter {
  private readonly qps = new SlidingWindowQpsLimiter();
  private readonly tpm = new TpmReservationLimiter();

  constructor() {
    this.qps.startGc();
  }

  checkQps(key: LimitKey, limit: number): QpsCheckResult {
    return this.qps.check(key, limit);
  }

  reserveTpm(key: LimitKey, tokens: number, limit: number): TpmReserveResult {
    return this.tpm.reserve(key, tokens, limit);
  }

  commitTpm(key: LimitKey, reservedTokens: number, actualTokens: number): void {
    this.tpm.commit(key, reservedTokens, actualTokens);
  }

  releaseTpm(key: LimitKey, reservedTokens: number): void {
    this.tpm.release(key, reservedTokens);
  }

  inspect(key: LimitKey): { qpsCount: number; tpmTokens: number } | null {
    const qpsCount = this.qps.inspectCount(key);
    const tpmTokens = this.tpm.inspectTokens(key);
    if (qpsCount === 0 && tpmTokens === 0) return null;
    return { qpsCount, tpmTokens };
  }

  /** 测试 / 关闭进程时调. */
  dispose(): void {
    this.qps.stopGc();
    this.qps.reset();
    this.tpm.reset();
  }
}

// 进程内单例. 中间件、admin 路由都通过这个 getter 拿同一实例.
let _shared: MemoryRateLimiter | null = null;

export function getSharedLimiter(): MemoryRateLimiter {
  if (!_shared) _shared = new MemoryRateLimiter();
  return _shared;
}

/** 测试用: 替换全局 limiter (例如想换 Redis adapter) */
export function setSharedLimiter(limiter: MemoryRateLimiter): void {
  _shared = limiter;
}
