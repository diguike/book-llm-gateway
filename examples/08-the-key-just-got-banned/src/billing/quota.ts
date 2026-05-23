// 月度配额管理
//
// 与 Ch5 计费的关系: monthly_quota 是「按 Key 的累加上限」, 不是「按 user 的余额」.
//   - users.balance_micro: Ch5 已有, 是用户钱包余额, 用一笔扣一笔 (preConsume 单原子);
//   - keys.monthly_quota_micro: v0.6 新增, 是按 Key 在「自然月」内的累积上限;
//   - 两个限制同时生效: 余额够、Key 月配额没满, 才放行. 都失败时余额先拦 (preConsume 阶段).
//
// 为什么单独按 Key 配月度配额? 一个公司可能给同一 user 签多把 Key, 用途不同 (生产 / 测试 /
// CI), 每把 Key 应当能独立设月度配额上限, 防止某把 CI Key 失控时把整个公司的额度吃光.
// one-api 的 model/token.go 同样在 Token 级别 (类比本书的 Key) 维护 RemainQuota.
//
// 跨月重置: 拿 quota_reset_at 与「now 的月份起点」比较, 落后则 monthly_used = 0,
// quota_reset_at = now. 用 SQL 一条 UPDATE 完成, 不让 application 算月份起点
// (避免时区误差).

import { eq, sql } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { keys } from '../db/schema.js';

/** 月度配额检查结果 */
export interface QuotaCheckResult {
  ok: boolean;
  /** 配额上限 (微元). 0 = 不限. */
  limit: number;
  /** 已用 (微元) - 检查时即时刷新过 (跨月清零) */
  used: number;
  /** 本次请求即将占用的金额 (preReservedCost) */
  reserving: number;
}

/**
 * 检查 Key 的月度配额. 在 preConsume 成功之后调.
 *
 * 设计:
 *   - limit = 0 视为不限, 直接 ok;
 *   - 已用 (used) 在 postConsume 阶段累加, 跨月时归零;
 *   - 这里只查 + 判断, 不写 - 写 (used += finalCost) 留给 postConsume.
 *
 * 跨月检测: 比较 quota_reset_at 与「当前自然月的起点」. 落后则归零并更新 reset_at.
 * 用单条 SQL 实现 (CASE WHEN) 避免读改回写竞态.
 */
export function checkMonthlyQuota(keyId: number, reservingMicro: number): QuotaCheckResult {
  const db = getDb();
  const now = Date.now();
  const monthStart = startOfCurrentMonth(now);

  // 跨月时一并归零: 一条 UPDATE, 让 SQLite 用 CASE WHEN 内置判断
  //   IF quota_reset_at < monthStart THEN monthly_used = 0, quota_reset_at = now
  db.update(keys)
    .set({
      monthlyUsedMicro: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN 0 ELSE ${keys.monthlyUsedMicro} END`,
      quotaResetAt: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN ${now} ELSE ${keys.quotaResetAt} END`,
    })
    .where(eq(keys.id, keyId))
    .run();

  const rows = db
    .select({
      monthlyQuotaMicro: keys.monthlyQuotaMicro,
      monthlyUsedMicro: keys.monthlyUsedMicro,
    })
    .from(keys)
    .where(eq(keys.id, keyId))
    .all();
  if (rows.length === 0) {
    return { ok: false, limit: 0, used: 0, reserving: reservingMicro };
  }
  const { monthlyQuotaMicro: limit, monthlyUsedMicro: used } = rows[0]!;
  if (limit <= 0) {
    return { ok: true, limit: 0, used, reserving: reservingMicro };
  }
  const ok = used + reservingMicro <= limit;
  return { ok, limit, used, reserving: reservingMicro };
}

/**
 * postConsume 成功后累加 monthly_used. 仅在 finalCost > 0 时调.
 * 用 SQL 一条 UPDATE 完成, 与 Ch5 的乐观锁余额扣减同样的范式.
 */
export function commitMonthlyUsage(keyId: number, finalCostMicro: number): void {
  if (finalCostMicro <= 0) return;
  const db = getDb();
  db.update(keys)
    .set({ monthlyUsedMicro: sql`${keys.monthlyUsedMicro} + ${finalCostMicro}` })
    .where(eq(keys.id, keyId))
    .run();
}

/**
 * 当前时区下「这个月 1 号 0 点」的 unix ms.
 *
 * 跨月归零的判定边界. 用 UTC 月份避免本地时区漂移 (生产建议固定到 UTC 或 server 时区).
 */
export function startOfCurrentMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
