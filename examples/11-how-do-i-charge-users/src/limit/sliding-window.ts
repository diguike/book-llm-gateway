// QPS 滑动窗口 (内存实现)
//
// 算法:
//   - 每个 key 一个时间戳双端队列;
//   - 检查时把窗口外 (now - windowMs 之前) 的时间戳 shift 掉;
//   - 队列长度 < limit, 通过, push 当前时间戳;
//   - 队列长度 >= limit, 拒绝, retryAfterMs = (队头时间戳 + windowMs) - now,
//     即等队头那条出窗就有新名额.
//
// 与「固定窗口」(每秒清零) 的区别: 固定窗口在窗口切换瞬间, 两个窗口的边界处可能放过
// 2x limit 的流量 (上一窗末尾的 limit + 下一窗开头的 limit). 滑动窗口避免这个边界效应,
// 任意 1 秒内的请求数严格 <= limit.
//
// 性能: 每个 key 的队列长度上限 = limit (因为超限就拒了), 时间戳 shift / push 都是
// O(1) (使用 Array 的 shift 在 V8 优化下 < 1us). 对教学场景 (limit < 1000) 完全够用.
//
// 内存清理: 定时 GC 任务每分钟扫一遍 store, 删除最后一条时间戳过期 60s 以上的 key.
// 避免长期不调用的 key 一直占内存. 不开 GC 也不会泄漏 - 大量 cold key 在重启时被释放.
//
// 蓝本: one-api/common/rate-limit.go::InMemoryRateLimiter (Go 版的滑动窗口).

import type { LimitKey, QpsCheckResult } from './types.js';

/** 默认窗口 = 1s. QPS 直观定义就是「每秒最多多少请求」 */
const DEFAULT_WINDOW_MS = 1000;

/** GC 任务的清理间隔: 60s. */
const GC_INTERVAL_MS = 60_000;
/** key 多久没动就清掉: 60s. */
const GC_IDLE_MS = 60_000;

export class SlidingWindowQpsLimiter {
  private readonly store = new Map<LimitKey, number[]>();
  private readonly windowMs: number;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * 检查并消费一次. 滑动窗口的核心算法.
   *
   * 重要: limit = 0 视为不限, 直接 ok 但不消费时间戳 (避免无意义占内存).
   */
  check(key: LimitKey, limit: number): QpsCheckResult {
    if (limit <= 0) {
      return { ok: true, retryAfterMs: 0, currentCount: 0, limit: 0 };
    }
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let queue = this.store.get(key);
    if (!queue) {
      queue = [];
      this.store.set(key, queue);
    }

    // 把窗口外的时间戳 shift 掉.
    //   队列在 push 时按时间序追加, 头部就是最早的时间戳.
    //   循环 shift, 直到头部不再过期, 或队列为空.
    while (queue.length > 0 && queue[0]! <= cutoff) {
      queue.shift();
    }

    const currentCount = queue.length;
    if (currentCount >= limit) {
      // 拒绝: 等头部那条时间戳 + windowMs 到来, 就有新名额.
      const retryAfterMs = Math.max(1, queue[0]! + this.windowMs - now);
      return { ok: false, retryAfterMs, currentCount, limit };
    }

    queue.push(now);
    return { ok: true, retryAfterMs: 0, currentCount: currentCount + 1, limit };
  }

  /** 调试: 取当前 key 窗口内的请求数. */
  inspectCount(key: LimitKey): number {
    const queue = this.store.get(key);
    if (!queue) return 0;
    const cutoff = Date.now() - this.windowMs;
    while (queue.length > 0 && queue[0]! <= cutoff) queue.shift();
    return queue.length;
  }

  /**
   * 启动后台 GC. 进程退出时调 stopGc() 释放定时器, 否则 jest / pm2 优雅退出会卡.
   */
  startGc(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gcOnce(), GC_INTERVAL_MS);
    // unref: 不阻止 Node.js 进程退出 (主循环退出时 GC 跟着退出, 不卡)
    this.gcTimer.unref?.();
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  private gcOnce(): void {
    const idleCutoff = Date.now() - GC_IDLE_MS;
    for (const [key, queue] of this.store.entries()) {
      const last = queue[queue.length - 1];
      if (last === undefined || last < idleCutoff) {
        this.store.delete(key);
      }
    }
  }

  /** 测试用: 清空所有窗口 */
  reset(): void {
    this.store.clear();
  }
}
