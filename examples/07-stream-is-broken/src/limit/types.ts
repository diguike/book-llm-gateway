// RateLimiter 接口
//
// 定位: 把「限流策略」从「存储 / 算法实现」里抽出来, 留两套接口契约:
//   1. checkQps   - 检查 QPS, 不通过返回 retryAfterMs;
//   2. reserveTpm - 预扣 TPM (token 预算), 类比 Ch5 的 preConsume;
//      releaseTpm - 释放预扣 (上游失败时调);
//      commitTpm  - 实结 TPM (用真实 usage 替换掉预扣值, 多退少补).
//
// 为什么 TPM 要做「预扣 + 实结」, 而不是请求结束后一次性扣:
//   - 一次请求可能消耗几千 token, 在响应到达前网关并不知道精确数值;
//   - 必须按 max_tokens 上限「先扣后调」, 否则同一把 Key 在余额边界附近会出现
//     「短时间打爆 TPM 配额、上游继续放过」的 race, 跟 Ch5 计费的两阶段思路一致.
//   - postConsume 拿到真实 usage 后, releaseTpm(预扣 - 真实) 回填多扣的.
//
// 默认提供进程内存实现 (sliding-window + 60s 滚动 TPM 桶), 接口允许后续替换 Redis
// 适配器. Redis 版的关键差异是: 滑动窗口与 TPM 桶都改成 Redis ZSET + Lua 原子脚本.
// 本章不实现 Redis 版本, 只在 README 说明替换点.
//
// 与 Portkey 的对照:
//   - portkey-gateway/src/shared/services/cache/utils/rateLimiter.ts 是 Redis + Lua
//     脚本的「令牌桶」算法: tokens / lastRefill 两个 key, 一次 evalsha 完成 check + consume.
//     本书内存版退化成 「sliding window 双端队列 + TPM 累计计数器」, 在单机教学场景下
//     足够, 同时保留接口契约让 Redis 版本能无缝替换.
//
// 与 one-api 的对照:
//   - one-api/common/rate-limit.go::InMemoryRateLimiter 是基于「定长队列 + 时间戳头尾对比」
//     的滑动窗口实现 (本书 sliding-window 的算法蓝本), 但 one-api 只做 QPS 维度,
//     TPM 是空白 - 因为它的 TPM 等价物在 Ch5 计费两阶段里, 没单独抽出来.

/** 一个限流维度的 key. 形如 "key:42" / "user:1" / "model:gpt-4o-mini" / "global" */
export type LimitKey = string;

/** QPS 检查结果 */
export interface QpsCheckResult {
  ok: boolean;
  /** ok = false 时, 客户端最少需要等多少 ms 再重试 */
  retryAfterMs: number;
  /** 当前窗口已用请求数 (调试 / observability 用) */
  currentCount: number;
  /** 上限 */
  limit: number;
}

/** TPM 预扣结果 */
export interface TpmReserveResult {
  ok: boolean;
  /** ok = false 时, 最少需要等多少 ms (本桶过期到下一秒还有多远) */
  retryAfterMs: number;
  /** 当前窗口已预占 + 已确认的 token 总和 */
  currentTokens: number;
  /** 上限 */
  limit: number;
  /** ok = true 时的预扣额度; 失败时为 0. 供 release / commit 用 */
  reservedTokens: number;
}

/**
 * RateLimiter 接口契约
 *
 * 实现要求:
 *   - 所有方法必须是「本进程内同步」或「分布式原子」, 不允许出现「check 后还能被
 *     另一并发悄悄改」的窗口 (sliding-window 内存版用 JS 单线程天然原子,
 *     Redis 版用 Lua 脚本保证).
 *   - limit = 0 视为「不限制」, 直接 ok.
 */
export interface RateLimiter {
  /**
   * 检查 QPS, 如果未超限则消费一次 (push 时间戳).
   * limit = 0 视为不限.
   */
  checkQps(key: LimitKey, limit: number): QpsCheckResult;

  /**
   * 预扣 TPM. 类比 Ch5 的 preConsume: 用 max_tokens 上限占用一份额度.
   * limit = 0 视为不限, 返回 ok 且 reservedTokens = tokens.
   */
  reserveTpm(key: LimitKey, tokens: number, limit: number): TpmReserveResult;

  /**
   * 实结 TPM: 用真实 token 数替换之前的预扣值 (多退少补).
   *   预扣 = reserved, 真实 = actual
   *   净占用 = actual; 已经扣的多余部分 = reserved - actual, 直接释放.
   *
   * 注意: actual 可能大于 reserved (流式 token 比 max_tokens 估算的多), 此时直接
   * 把超出部分追加到当前桶中 - 不阻塞当前请求, 但下一次 reserveTpm 会受影响.
   */
  commitTpm(key: LimitKey, reservedTokens: number, actualTokens: number): void;

  /**
   * 释放预扣 (整笔退回, 用于上游失败 / 网络错时). 等价于 commitTpm(key, reserved, 0).
   */
  releaseTpm(key: LimitKey, reservedTokens: number): void;

  /**
   * 调试 / observability: 查询当前 (key) 维度的窗口状态.
   * 返回 null 表示该 key 还没被建立过窗口.
   */
  inspect(key: LimitKey): {
    qpsCount: number;
    tpmTokens: number;
  } | null;
}
