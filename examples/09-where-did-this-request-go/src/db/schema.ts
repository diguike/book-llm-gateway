// 第 6 章 schema: Ch5 的 orgs / users / keys / prices / usage_records 之上,
// 仅给 keys 表加 5 个限流 + 月度配额字段 (见 0003_quota.sql).
//
// 不动 users / orgs / prices / usage_records 表: 限流是新维度,
// QPS 数据放进程内存 (滑动窗口), TPM 预扣放进程内存 (60s 滚动窗口),
// 月度配额上限是按 Key 的累计累加 - 只需要持久化「配额上限 + 累计已用」两列,
// QPS/TPM 这些秒/分钟级窗口的状态本身不入库 (重启重置, 单进程内存即可).
//
// 历史字段保留:
//   - users.balanceMicro / userMultiplier : Ch5 已有
//   - prices / usage_records              : Ch5 已有
//
// 设计参考:
//   - one-api model/log.go (单维度的 Log 表) -> 本书拆得更细: input/output 分列价 + 分列 cost
//   - new-api pkg/billingexpr/expr.md (表达式计费) -> 本书 v0.5 用「硬编码三个倍率」简化,
//     不引入 AST 求值; 但 prices 表的 schema 已经预留了「按时间窗热加载」, Ch10 接成本
//     优化时可以无缝换成表达式计费.
//
// 关键设计:
//   1. 所有金额字段都用 integer (微元), 不用 real/float. SQLite 的 REAL 是 IEEE 754
//      双精度, 0.1 + 0.2 != 0.3 这种坑在累加月账单时会被放大;
//   2. 价格表行的 effective_from / effective_to 是 unix ms, 用来精确卡时间窗.
//      上游官方调价或运营改价都新插一行而不是 UPDATE 老行, 历史 usage_records 反查
//      永远是「当时的价格」;
//   3. usage_records.status 字段贯穿生命周期: reserved -> finalized / refunded / failed.
//      reserved 行写入即代表预扣发生; finalized 是 postConsume 完成的终态.

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

// ============================================================
// orgs: 沿用 Ch4
// ============================================================
export const orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** 启用 / 禁用. 禁用后所有下属 user 的 key 不能再用 (即时生效) */
  disabledAt: integer('disabled_at'),
  createdAt: integer('created_at').notNull(),
});

// ============================================================
// users: Ch4 基础上新增 balanceMicro + userMultiplier
//
//   balanceMicro: 余额, 单位 1e-6 元. 1 元 = 1_000_000 微元.
//                 预扣时 -= cost; 实结后 += (preReserved - actualCost) 补差.
//
//   userMultiplier: 用户倍率 (千分位 integer). 1000 = 1.0x (基线),
//                   800  = 0.8x (打 8 折),
//                   1500 = 1.5x (高价档).
//                   final_cost = base × user_multiplier × channel_multiplier × model_multiplier.
// ============================================================
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    email: text('email'),
    disabledAt: integer('disabled_at'),
    createdAt: integer('created_at').notNull(),

    // ----- v0.5 新增 -----
    /** 余额, 单位 1e-6 元. 默认 INITIAL_BALANCE_CNY × 1_000_000. */
    balanceMicro: integer('balance_micro').notNull().default(0),
    /** 用户倍率 (千分位 integer). 默认 1000 = 1.0x. */
    userMultiplier: integer('user_multiplier').notNull().default(1000),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_org_email_idx').on(table.orgId, table.email),
  }),
);

// ============================================================
// keys: Ch4 基础上, v0.6 新增限流 + 月度配额五个字段
//
//   qps_limit              每秒最多请求 (滑动窗口判定). 0 = 不限.
//   tpm_limit              每分钟最多 token 数 (input + output 之和). 0 = 不限.
//                          TPM 走「预扣 + 实结」两阶段, 复用 Ch5 的计费思路.
//   monthly_quota_micro    月度配额上限 (微元). 0 = 不限.
//   monthly_used_micro     当月累计已用金额 (微元). postConsume 时累加.
//   quota_reset_at         上次重置 monthly_used 的 unix ms. 跨月触发归零.
// ============================================================
export const keys = sqliteTable(
  'keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    keyHash: text('key_hash').notNull(),
    keyPreview: text('key_preview').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').notNull().default('chat'),
    expiresAt: integer('expires_at'),
    disabledAt: integer('disabled_at'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),

    // ----- v0.6 新增 -----
    /** 每秒最多请求数 (滑动窗口判定). 0 = 不限. */
    qpsLimit: integer('qps_limit').notNull().default(0),
    /** 每分钟最多 token 数 (input + output 之和). 0 = 不限. */
    tpmLimit: integer('tpm_limit').notNull().default(0),
    /** 月度配额上限, 单位微元. 0 = 不限. 超过返 402. */
    monthlyQuotaMicro: integer('monthly_quota_micro').notNull().default(0),
    /** 当月累计已用金额, 单位微元. postConsume 时累加, 跨月时归零. */
    monthlyUsedMicro: integer('monthly_used_micro').notNull().default(0),
    /** 上次重置 monthly_used 的 unix ms. 0 = 从未重置. */
    quotaResetAt: integer('quota_reset_at').notNull().default(0),
  },
  (table) => ({
    keyHashIdx: uniqueIndex('keys_key_hash_idx').on(table.keyHash),
    userIdx: index('keys_user_idx').on(table.userId),
  }),
);

// ============================================================
// prices: 价格表
//
//   一行 = (model, provider, 有效时间窗) 三元组下的「输入 + 输出」两路单价.
//   新调价时插入新行而不是 UPDATE 老行, 老行的 effective_to 置为新行的 effective_from.
//   单价单位: 元 / 1M tokens (主流厂商对外公布的写法), 缩放成 micro CNY / 1M tokens 存:
//     1 元 = 1_000_000 微元; 单价 inputPriceMicroPer1M = 元 × 1_000_000.
//     例: gpt-4o-mini input 公开价折人民币约 1.05 元 / 1M -> 存 1_050_000.
//
//   时间窗: effective_to 为 null 表示「截至今天仍有效」.
// ============================================================
export const prices = sqliteTable(
  'prices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** model 字面值 (例: gpt-4o-mini / claude-3-5-sonnet-20241022). 与请求体的 model 字段对齐 */
    model: text('model').notNull(),
    /** provider 标识 (例: openai / anthropic / deepseek). 配合 model 唯一确定一行 */
    provider: text('provider').notNull(),
    /** input 单价: 微元 / 1M tokens. */
    inputPriceMicroPer1M: integer('input_price_micro_per_1m').notNull(),
    /** output 单价: 微元 / 1M tokens. 通常 = input × 3 ~ 5 */
    outputPriceMicroPer1M: integer('output_price_micro_per_1m').notNull(),
    /** 模型本身的倍率 (千分位). 比如某模型被运营定为基线 1.2x, 这里写 1200 */
    modelMultiplier: integer('model_multiplier').notNull().default(1000),
    /** 价格生效起始时间 (unix ms) */
    effectiveFrom: integer('effective_from').notNull(),
    /** 价格失效时间 (unix ms); null 表示一直有效 */
    effectiveTo: integer('effective_to'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    /** 高频查询: 按 (model, provider) 查当前有效价格 */
    modelProviderIdx: index('prices_model_provider_idx').on(table.model, table.provider),
  }),
);

// ============================================================
// usage_records: 每次请求的账单
//
//   生命周期 (status 字段):
//     reserved  -> preConsume 完成, 已预扣余额, 等待上游响应
//     finalized -> postConsume 完成, 真实 usage 已结算, 补差完毕
//     refunded  -> 上游失败或拒绝, 预扣全额退回, 不计费
//     failed    -> postConsume 阶段出现异常, 但预扣已扣 (留待人工对账)
//
//   关键字段:
//     trace_id          : 贯穿请求全链路, 后续 Ch9 看板按它反查
//     pre_reserved_cost : preConsume 实际扣掉的余额 (微元)
//     final_cost        : postConsume 算出的真实成本 (微元); 流式中途断开时
//                         反映「已收到的 token 对应的实结金额」
//     prompt_cost / completion_cost : 拆开记, 便于后续按维度审计
//     prompt_tokens / completion_tokens : 真实 token (上游 usage 返回的; 流式累加得到)
//     estimated_prompt_tokens : tiktoken 本地估算的 input token, 与上游 usage 对账用
//     multiplier_snapshot : 当次请求生效的「user × channel × model」三合一倍率快照
//                           (整数乘积; 不能存指针, 后续运营改倍率不能改写历史账单)
// ============================================================
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** 链路追踪 ID, 一次请求一个. hex(16) 32 字符 */
    traceId: text('trace_id').notNull(),

    /** 归因维度 */
    userId: integer('user_id').notNull(),
    orgId: integer('org_id').notNull(),
    keyId: integer('key_id').notNull(),

    /** 模型 / 渠道 */
    model: text('model').notNull(),
    provider: text('provider').notNull(),

    /** 真实 token 数 (上游 usage 返回的; 流式累加得到) */
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),

    /** 本地 tiktoken 估算的 input token (对账用) */
    estimatedPromptTokens: integer('estimated_prompt_tokens').notNull().default(0),

    /** 成本拆解 (微元) */
    promptCost: integer('prompt_cost').notNull().default(0),
    completionCost: integer('completion_cost').notNull().default(0),
    finalCost: integer('final_cost').notNull().default(0),

    /** 预扣金额 (微元), 用于 postConsume 时算 delta */
    preReservedCost: integer('pre_reserved_cost').notNull().default(0),

    /** 三合一倍率快照 (user × channel × model 三个千分位整数的乘积). 1_000_000_000 = 1.0x */
    multiplierSnapshot: integer('multiplier_snapshot').notNull().default(1_000_000_000),

    /** 状态机: reserved / finalized / refunded / failed */
    status: text('status').notNull().default('reserved'),

    /** 流式? 用于 Ch7 流式计费闭环对账 */
    isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),

    /** 错误信息 (status = failed 时填) */
    errorMessage: text('error_message'),

    createdAt: integer('created_at').notNull(),
    /** 实结时间 (unix ms). status 从 reserved -> finalized 那一刻 */
    finalizedAt: integer('finalized_at'),

    // ----- v0.9 新增 (可观测性) -----
    /** 本次请求实际命中的上游 channel id. 故障转移时记最后一次成功的那个 */
    channelId: integer('channel_id'),
    /** 上游 fetch 起到 first byte / parse 完成的耗时, 毫秒. 看板按 channel 算 P50/P95 */
    upstreamLatencyMs: integer('upstream_latency_ms'),
    /** 本次请求试过的 channel id 列表, JSON 数组字符串. 例: "[2,1]" */
    attemptedChannels: text('attempted_channels'),
  },
  (table) => ({
    traceIdx: uniqueIndex('usage_records_trace_idx').on(table.traceId),
    userTimeIdx: index('usage_records_user_time_idx').on(table.userId, table.createdAt),
    keyTimeIdx: index('usage_records_key_time_idx').on(table.keyId, table.createdAt),
    modelTimeIdx: index('usage_records_model_time_idx').on(table.model, table.createdAt),
    statusIdx: index('usage_records_status_idx').on(table.status),
    channelTimeIdx: index('usage_records_channel_time_idx').on(table.channelId, table.createdAt),
  }),
);

// ============================================================
// v0.8 新增: channels + abilities (渠道池 + 反范式索引表)
//
// 设计参考:
//   - one-api model/channel.go::Channel
//   - one-api model/ability.go::Ability + AddAbilities
//   - one-api model/cache.go::CacheGetRandomSatisfiedChannel
//   - one-api monitor/manage.go::ShouldDisableChannel
//
// 关键设计:
//   1. channels.enabled_models 是 JSON 字符串, 不参与运行时选渠道查询;
//      每次 CRUD 时由 ChannelRegistry 解析并刷新 abilities;
//   2. abilities 是 (group, model, channel_id) 三元组联合主键的反范式索引表,
//      运行时按 (group, model) 一次 lookup 即得所有可用 channel;
//   3. channels.status 三态: active / disabled / probing. health-checker
//      定期扫 disabled, 通过探活恢复成 active.
// ============================================================
export const channels = sqliteTable(
  'channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** provider 标识, 决定使用哪个 ProviderAdaptor: openai / deepseek / anthropic / mock */
    provider: text('provider').notNull(),
    /** 上游真实 API Key. 教学场景明文存; 生产应加密 (留待 Ch12) */
    apiKey: text('api_key').notNull(),
    /** 上游 base URL, 不含 /v1 路径 */
    baseUrl: text('base_url').notNull(),
    /** 支持的模型 JSON 数组字符串, 例: ["gpt-4o","gpt-4o-mini"] */
    enabledModels: text('enabled_models').notNull().default('[]'),
    /** 用户分组. 简化为单 group, 默认 default */
    groupName: text('group_name').notNull().default('default'),
    /** 优先级, 越大越优先 */
    priority: integer('priority').notNull().default(0),
    /** 同 priority 内的加权随机权重. 0 = 不参与, >0 按累加权重命中 */
    weight: integer('weight').notNull().default(1),
    /** 渠道倍率 (千分位). 1000 = 1.0x */
    channelMultiplier: integer('channel_multiplier').notNull().default(1000),
    /** 状态机: active / disabled / probing */
    status: text('status').notNull().default('active'),
    /** 上次被禁用的时间 (unix ms), health-checker 据此决定冷却时间 */
    disabledAt: integer('disabled_at'),
    /** 禁用原因: upstream_401 / upstream_429 / upstream_5xx_streak / manual ... */
    disabledReason: text('disabled_reason'),
    /** 最近一次探活时间 (unix ms), 控制最小探活间隔 */
    lastProbedAt: integer('last_probed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    statusIdx: index('channels_status_idx').on(table.status),
    providerIdx: index('channels_provider_idx').on(table.provider),
  }),
);

/**
 * abilities: (group, model, channel_id) 联合主键的反范式索引表.
 *
 * 选渠道的热路径只读这一张表:
 *   SELECT channel_id, priority, weight FROM abilities
 *   WHERE group_name = ? AND model = ? AND enabled = 1
 *   ORDER BY priority DESC;
 *
 * CRUD 时由 ChannelRegistry 同步刷新 (channels.enabled_models JSON 数组的笛卡儿积展开).
 */
export const abilities = sqliteTable(
  'abilities',
  {
    groupName: text('group_name').notNull(),
    model: text('model').notNull(),
    channelId: integer('channel_id').notNull(),
    /** 冗余 priority, 与 channels.priority 保持同步 */
    priority: integer('priority').notNull().default(0),
    /** 冗余 weight, 与 channels.weight 保持同步 */
    weight: integer('weight').notNull().default(1),
    /** channel.status != 'active' 时, 这一行 enabled 置 false */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => ({
    lookupIdx: index('abilities_lookup_idx').on(
      table.groupName,
      table.model,
      table.enabled,
      table.priority,
    ),
  }),
);

// ============================================================
// 运行时类型
// ============================================================
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Key = typeof keys.$inferSelect;
export type NewKey = typeof keys.$inferInsert;
export type Price = typeof prices.$inferSelect;
export type NewPrice = typeof prices.$inferInsert;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Ability = typeof abilities.$inferSelect;
export type NewAbility = typeof abilities.$inferInsert;
