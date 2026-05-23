// ChannelRegistry: 启动时把 channels 表全量加载到内存
//
// 设计与 one-api model/cache.go::CacheGetRandomSatisfiedChannel 完全同构:
//   - 启动时一次性把 channels + abilities 全表加载到内存;
//   - admin API 改了 channel 之后通过 invalidate() 触发重建;
//   - 运行时选 channel 只读内存 Map, 不查 DB.
//
// 为什么不直接在选 channel 时查 DB:
//   1. 选 channel 是热路径, 每个请求至少跑一次. SQLite 同步查询单次 < 100us, 但 N 个请求
//      在写入路径上 (例如 lastUsedAt 更新) 会跟它抢锁;
//   2. abilities 反范式后总行数也不大 (假设 100 个 channel × 20 个 model = 2000 行),
//      全部塞内存 ~ 200KB, 不构成压力;
//   3. 内存 Map 选 channel 是 O(1), DB 查询带索引也是 O(log N) + 网络/锁, 一个数量级差距.
//
// 内存结构:
//   group2model2channels: Map<group, Map<model, ChannelEntry[]>>
//
//   每次按 (group, model) 拿出 ChannelEntry[] 数组, 已按 priority desc 排序.
//   故障转移: 先取 priority 最大那一档的所有 channel 加权选一个; 都挂了再降一档.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { channels, abilities, type Channel, type NewAbility } from '../db/schema.js';

export interface ChannelEntry {
  id: number;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  priority: number;
  weight: number;
  channelMultiplier: number;
  status: 'active' | 'disabled' | 'probing';
  enabledModels: string[];
  groupName: string;
  // ----- v0.10 -----
  /** 成本档位, 越小越便宜. 默认 100. 主路径成本路由按这个字段升序选 */
  costPriority: number;
  /** 是否支持 batch API. priority=low 走它 */
  supportsBatch: boolean;
}

/** 内存里按 (group, model) 索引出来的可用 channel 列表 */
type GroupIndex = Map<string, Map<string, ChannelEntry[]>>;

/**
 * 全进程共享一个 ChannelRegistry. 单例.
 * 出于教学清晰, 不做 module-level 即时实例化, 用 ensure() 显式触发首次加载.
 */
let _instance: ChannelRegistry | null = null;

export class ChannelRegistry {
  /** model -> channel 索引. 内存里所有 active channel 都在这 */
  private groupIndex: GroupIndex = new Map();
  /** 全部 channel 的快照 (含 disabled / probing), admin API 查询用 */
  private allChannels: ChannelEntry[] = [];

  constructor() {
    this.rebuild();
  }

  /**
   * 全量重建索引. 从 abilities 表读 (group, model, channel_id) 联表 channels.
   * admin API 增删改 channel 后调一次.
   */
  rebuild(): void {
    const db = getDb();
    const rows = db.select().from(channels).all();

    this.allChannels = rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      priority: r.priority,
      weight: r.weight,
      channelMultiplier: r.channelMultiplier,
      status: r.status as ChannelEntry['status'],
      enabledModels: safeParseJsonArray(r.enabledModels),
      groupName: r.groupName,
      costPriority: r.costPriority,
      supportsBatch: r.supportsBatch,
    }));

    // 拿 abilities (只取 enabled=true 的)
    const abilityRows = db.select().from(abilities).where(eq(abilities.enabled, true)).all();

    const next: GroupIndex = new Map();
    const channelById = new Map(this.allChannels.map((c) => [c.id, c]));

    for (const ab of abilityRows) {
      const ch = channelById.get(ab.channelId);
      if (!ch) continue;
      // 双重防御: ability 行存在但 channel 已经被禁 / 删除, 跳过
      if (ch.status !== 'active') continue;

      let modelMap = next.get(ab.groupName);
      if (!modelMap) {
        modelMap = new Map();
        next.set(ab.groupName, modelMap);
      }
      let list = modelMap.get(ab.model);
      if (!list) {
        list = [];
        modelMap.set(ab.model, list);
      }
      list.push(ch);
    }

    // 每个 (group, model) 列表按 priority desc 排好序, 给 router/picker 直接用
    for (const modelMap of next.values()) {
      for (const list of modelMap.values()) {
        list.sort((a, b) => b.priority - a.priority);
      }
    }

    this.groupIndex = next;
  }

  /** 按 (group, model) 拿可用 channel 列表. 不可变, 调用方不要 mutate */
  lookup(group: string, model: string): ChannelEntry[] {
    return this.groupIndex.get(group)?.get(model) ?? [];
  }

  /** 全量快照, admin API 列表用 */
  snapshot(): ChannelEntry[] {
    return [...this.allChannels];
  }

  /** 单个 channel 详情, admin / health-checker 用 */
  get(channelId: number): ChannelEntry | undefined {
    return this.allChannels.find((c) => c.id === channelId);
  }
}

/** 全进程单例访问. 第一次调用时触发 rebuild() */
export function getChannelRegistry(): ChannelRegistry {
  if (!_instance) _instance = new ChannelRegistry();
  return _instance;
}

/** admin API 增删改 channel 后调, 强制下次 lookup 重建 */
export function invalidateChannelRegistry(): void {
  if (_instance) _instance.rebuild();
}

// ============================================================
// abilities 双写: 由 admin API / health-checker 调
//
// 设计参考: one-api model/ability.go::AddAbilities + DeleteAbilities + UpdateAbilities.
//   - 新增 channel: 解析 enabled_models JSON 数组, 每个 model 写一行 ability;
//   - 改 channel: 先 delete all by channel_id 再 add (one-api 的 quick and dirty);
//   - 删 channel: delete all by channel_id;
//   - 改 status: 不删 ability 行, 只翻 enabled 字段.
// ============================================================

/** 把 channel 的 (group × enabled_models) 笛卡儿积写进 abilities 表 */
export function addAbilitiesForChannel(channel: Channel): void {
  const db = getDb();
  const models = safeParseJsonArray(channel.enabledModels);
  if (models.length === 0) return;
  const rows: NewAbility[] = models.map((m) => ({
    groupName: channel.groupName,
    model: m,
    channelId: channel.id,
    priority: channel.priority,
    weight: channel.weight,
    enabled: channel.status === 'active',
  }));
  db.insert(abilities).values(rows).run();
}

/** 删该 channel 的全部 ability 行 (channel delete 或 update 时先调) */
export function deleteAbilitiesForChannel(channelId: number): void {
  const db = getDb();
  db.delete(abilities).where(eq(abilities.channelId, channelId)).run();
}

/** 单字段更新: channel 状态变化时翻 ability.enabled (不删行, 不重建) */
export function updateAbilityEnabledByChannel(channelId: number, enabled: boolean): void {
  const db = getDb();
  db.update(abilities).set({ enabled }).where(eq(abilities.channelId, channelId)).run();
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((s) => typeof s === 'string');
  } catch {
    /* ignore */
  }
  return [];
}
