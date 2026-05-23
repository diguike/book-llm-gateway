// channels 表的 CRUD + 状态变更原子操作
//
// 这一层和 ChannelRegistry 解耦:
//   - store.ts:    DB 层. 不持有内存状态, 只负责把 channels + abilities 两张表写对.
//   - registry.ts: 内存层. 启动时从 store 全量读, 之后只在 admin / health-checker
//                  改完状态后 invalidateChannelRegistry() 触发重建.
//
// 每个写操作都通过 better-sqlite3 的 transaction 包起来, 保证 channels 主表与
// abilities 索引表的双写要么一起成功要么一起回滚.

import { eq, and } from 'drizzle-orm';
import { getDb, getRawSqlite } from '../db/client.js';
import { channels, abilities, type Channel } from '../db/schema.js';
import {
  addAbilitiesForChannel,
  deleteAbilitiesForChannel,
  updateAbilityEnabledByChannel,
  invalidateChannelRegistry,
} from './registry.js';

export interface CreateChannelInput {
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  /** 支持的模型清单, 例: ['gpt-4o-mini','gpt-4o'] */
  enabledModels: string[];
  groupName?: string;
  priority?: number;
  weight?: number;
  /** 渠道倍率 (浮点, 内部换算为千分位 integer) */
  channelMultiplier?: number;
  // ----- v0.10 新增 -----
  /** 成本档位, 越小越便宜. 默认 100 = 中位 */
  costPriority?: number;
  /** 是否支持 batch API (priority=low 时只走这类 channel) */
  supportsBatch?: boolean;
}

/**
 * 创建一个 channel, 同时把它的 (group × enabled_models) 笛卡儿积写进 abilities.
 * 两张表的双写包在一个事务里, 任一失败回滚.
 */
export function createChannel(input: CreateChannelInput): Channel {
  const db = getDb();
  const sqlite = getRawSqlite();
  const now = Date.now();
  let inserted: Channel | undefined;
  const tx = sqlite.transaction(() => {
    const rows = db
      .insert(channels)
      .values({
        name: input.name,
        provider: input.provider,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        enabledModels: JSON.stringify(input.enabledModels),
        groupName: input.groupName ?? 'default',
        priority: input.priority ?? 0,
        weight: input.weight ?? 1,
        channelMultiplier: Math.round((input.channelMultiplier ?? 1.0) * 1000),
        costPriority: input.costPriority ?? 100,
        supportsBatch: input.supportsBatch === true,
        status: 'active',
        createdAt: now,
      })
      .returning()
      .all();
    inserted = rows[0];
    if (inserted) addAbilitiesForChannel(inserted);
  });
  tx();
  if (!inserted) throw new Error('channel insert failed');
  invalidateChannelRegistry();
  return inserted;
}

/**
 * 修改 channel: 先删该 channel 的全部 ability, 再按新配置 add.
 * one-api 同样是「quick and dirty」: 删后重建.
 * 在事务里跑, 中间状态不可见.
 */
export function updateChannel(id: number, patch: Partial<CreateChannelInput>): Channel | null {
  const db = getDb();
  const sqlite = getRawSqlite();
  let updated: Channel | undefined;
  const tx = sqlite.transaction(() => {
    const cur = db.select().from(channels).where(eq(channels.id, id)).all();
    if (cur.length === 0) return;
    const setMap: Partial<Channel> = {};
    if (patch.name !== undefined) setMap.name = patch.name;
    if (patch.provider !== undefined) setMap.provider = patch.provider;
    if (patch.apiKey !== undefined) setMap.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) setMap.baseUrl = patch.baseUrl.replace(/\/+$/, '');
    if (patch.enabledModels !== undefined)
      setMap.enabledModels = JSON.stringify(patch.enabledModels);
    if (patch.groupName !== undefined) setMap.groupName = patch.groupName;
    if (patch.priority !== undefined) setMap.priority = patch.priority;
    if (patch.weight !== undefined) setMap.weight = patch.weight;
    if (patch.channelMultiplier !== undefined)
      setMap.channelMultiplier = Math.round(patch.channelMultiplier * 1000);
    if (patch.costPriority !== undefined) setMap.costPriority = patch.costPriority;
    if (patch.supportsBatch !== undefined) setMap.supportsBatch = patch.supportsBatch;

    if (Object.keys(setMap).length > 0) {
      db.update(channels).set(setMap).where(eq(channels.id, id)).run();
    }
    const after = db.select().from(channels).where(eq(channels.id, id)).all();
    updated = after[0];
    if (updated) {
      deleteAbilitiesForChannel(id);
      addAbilitiesForChannel(updated);
    }
  });
  tx();
  if (!updated) return null;
  invalidateChannelRegistry();
  return updated;
}

/** 删 channel + 它名下所有 ability */
export function deleteChannel(id: number): boolean {
  const sqlite = getRawSqlite();
  const db = getDb();
  let ok = false;
  const tx = sqlite.transaction(() => {
    const r = db.delete(channels).where(eq(channels.id, id)).returning().all();
    if (r.length === 0) return;
    db.delete(abilities).where(eq(abilities.channelId, id)).run();
    ok = true;
  });
  tx();
  if (ok) invalidateChannelRegistry();
  return ok;
}

/**
 * 把 channel 标为 disabled (或 throttle, 落到同一字段, 用 reason 区分).
 * abilities 不删, 只翻 enabled=false. 恢复时再翻回 true.
 */
export function markChannelDisabled(channelId: number, reason: string): void {
  const sqlite = getRawSqlite();
  const db = getDb();
  const tx = sqlite.transaction(() => {
    // 幂等: 已经 disabled 的不再写一次 (避免 disabledAt 被反复刷新)
    const cur = db.select().from(channels).where(eq(channels.id, channelId)).all();
    if (cur.length === 0) return;
    if (cur[0]!.status === 'disabled') return;

    db.update(channels)
      .set({
        status: 'disabled',
        disabledAt: Date.now(),
        disabledReason: reason,
      })
      .where(eq(channels.id, channelId))
      .run();
    updateAbilityEnabledByChannel(channelId, false);
  });
  tx();
  invalidateChannelRegistry();
}

/** health-checker 把 channel 切到 probing (中间过渡, abilities 仍然 enabled=false) */
export function markChannelProbing(channelId: number): void {
  const db = getDb();
  db.update(channels)
    .set({ status: 'probing', lastProbedAt: Date.now() })
    .where(and(eq(channels.id, channelId), eq(channels.status, 'disabled')))
    .run();
  invalidateChannelRegistry();
}

/** health-checker 探活成功, 恢复 channel */
export function markChannelActive(channelId: number): void {
  const sqlite = getRawSqlite();
  const db = getDb();
  const tx = sqlite.transaction(() => {
    db.update(channels)
      .set({
        status: 'active',
        disabledAt: null,
        disabledReason: null,
      })
      .where(eq(channels.id, channelId))
      .run();
    updateAbilityEnabledByChannel(channelId, true);
  });
  tx();
  invalidateChannelRegistry();
}

/** health-checker 探活失败: 回到 disabled, 留 reason 记录 */
export function markChannelDisabledAfterProbe(channelId: number, reason: string): void {
  const sqlite = getRawSqlite();
  const db = getDb();
  const tx = sqlite.transaction(() => {
    db.update(channels)
      .set({
        status: 'disabled',
        disabledReason: reason,
        lastProbedAt: Date.now(),
      })
      .where(eq(channels.id, channelId))
      .run();
    updateAbilityEnabledByChannel(channelId, false);
  });
  tx();
  invalidateChannelRegistry();
}

/** 拿所有 disabled 的 channel (含 reason / disabledAt), health-checker 扫这个清单 */
export function listDisabledChannels(): Channel[] {
  const db = getDb();
  return db.select().from(channels).where(eq(channels.status, 'disabled')).all();
}
