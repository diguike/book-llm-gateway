// UsageRecord 写入 / 查询的辅助工具
//
// preConsume / postConsume / refund 的 INSERT / UPDATE 已经在 calculator.ts 完成,
// 这里集中放只读查询: 按 trace_id 反查、按 keyId 列出最近 N 条等.
//
// 三个聚合查询 (按用户 / 按模型 / 按天) 直接以 SQL 写, drizzle 提供 sql 模板.
// Ch5 配套 README 有完整的 SQL recipe.

import { desc, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { usageRecords, type UsageRecord } from '../db/schema.js';

/** trace_id 反查整行 */
export function findByTraceId(traceId: string): UsageRecord | null {
  const db = getDb();
  const rows = db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.traceId, traceId))
    .limit(1)
    .all();
  return rows.length > 0 ? rows[0]! : null;
}

/** 按 keyId 列最近 N 条 (用于 admin /admin/usage?keyId=...) */
export function listByKey(keyId: number, limit = 50): UsageRecord[] {
  const db = getDb();
  return db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.keyId, keyId))
    .orderBy(desc(usageRecords.createdAt))
    .limit(limit)
    .all();
}

/** 按 userId 列最近 N 条 */
export function listByUser(userId: number, limit = 50): UsageRecord[] {
  const db = getDb();
  return db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.userId, userId))
    .orderBy(desc(usageRecords.createdAt))
    .limit(limit)
    .all();
}

export { type UsageRecord };
