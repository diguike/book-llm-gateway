// 第 5 章: 在 Ch4 的 orgs / users / keys 之上, 新增计费相关表
//
// 新增字段 / 表:
//   - users.balanceMicro            : 余额 (单位 1e-6 元, 即「微元」). 用 integer 存,
//                                     避免浮点数累加误差; 1 元 = 1_000_000 微元.
//   - users.userMultiplier          : 用户折扣 (千分位 integer).
//                                     基线 1.0 = 1000 (折扣单位 1/1000).
//   - prices                        : 价格表 (model × provider × 时间窗). 热加载.
//   - usage_records                 : 每次请求的账单, trace_id / status / cost 全字段落账.
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
// keys: 沿用 Ch4
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
  },
  (table) => ({
    traceIdx: uniqueIndex('usage_records_trace_idx').on(table.traceId),
    userTimeIdx: index('usage_records_user_time_idx').on(table.userId, table.createdAt),
    keyTimeIdx: index('usage_records_key_time_idx').on(table.keyId, table.createdAt),
    modelTimeIdx: index('usage_records_model_time_idx').on(table.model, table.createdAt),
    statusIdx: index('usage_records_status_idx').on(table.status),
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
