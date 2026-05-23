// 第 4 章: 三层数据模型 (Org -> User -> Key)
//
// 设计参考: one-api 的 model/user.go 与 model/token.go.
// 改造点:
//   1. 引入 Org 一层. 企业基建场景下「部门 / 业务线」, 对外卖 token 场景下「客户公司」
//      都对应这一层; one-api 把这层省掉了, 直接 user 顶到底, 后续做团队隔离时再加.
//      本书在 Ch4 就把这层留出来, 后续 Ch5 的账单按 org 聚合就直接能用.
//   2. Key 仅存哈希 (sha256), 不存明文. 明文只在创建时返回一次给调用方,
//      后续从数据库取永远只看哈希. 这与 GitHub PAT / Stripe API Key / one-api token
//      的存储策略一致 (one-api 例外: 它存的是明文, 后续靠 Redis 缓存做加速,
//      生产上一旦 DB 泄露所有 token 立刻失效, 不安全, 本书不沿用).
//   3. 时间戳全部用 unix milliseconds (number), 不依赖具体 DB 的 datetime 类型.
//      跨 SQLite / Postgres 一致.
//
// 注: 一份 schema 同时给 drizzle-kit 与运行时使用. schema 改动后:
//   - 运行时类型自动跟随推导 (typeof users.$inferSelect 等);
//   - 数据库结构必须靠 migration 文件同步, schema 自身不会改 DB.
//   后续章节加新表时, 用 `npm run drizzle:generate` 生成下一份 0002_xxx.sql.

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

// ============================================================
// orgs: 组织 / 业务线
//   - 企业基建场景: 一个部门 / 业务线 = 一个 org
//   - 对外卖 token 场景: 一个付费客户 = 一个 org
// 一个 org 下可以有多个 user, 一个 user 下可以有多个 key.
// ============================================================
export const orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** 启用 / 禁用. 禁用后所有下属 user 的 key 不能再用 (即时生效) */
  disabledAt: integer('disabled_at'), // null = 启用, 非 null = 被禁的时间戳
  createdAt: integer('created_at').notNull(),
});

// ============================================================
// users: 用户
//   - 企业基建场景: 一名员工 = 一个 user
//   - 对外卖 token 场景: 一个开发者账号 = 一个 user
// ============================================================
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id')
      .notNull()
      .references(() => orgs.id),
    /** 显示名, 仅供 UI / 日志归因, 不参与鉴权 */
    name: text('name').notNull(),
    /** 邮箱, 用于通知与去重 (本章不接邮件, 留出字段) */
    email: text('email'),
    disabledAt: integer('disabled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    /** 同一 org 下 email 唯一; null 不参与去重 (SQLite 行为) */
    emailIdx: uniqueIndex('users_org_email_idx').on(table.orgId, table.email),
  }),
);

// ============================================================
// keys: 内部 API Key
//   - 仅存 sha256 哈希 + 前缀 + 「最后 4 位」便于在 UI 上识别 (例: sk-gw-...x9k2)
//   - 明文从不入库, 只在 issueKey() 返回值里出现一次
//   - 元数据:
//     - name: 用户自取的标签 ("CI Bot Key" / "Production")
//     - scopes: 逗号分隔的字符串, 例 "chat,embeddings"; 留作后续章节扩展
//     - expiresAt: null 表示永不过期; 非 null 的过期 key 鉴权时直接拒
//     - disabledAt: 即时吊销标记; 与 expiresAt 互补 (一个被动一个主动)
//     - lastUsedAt: 仅作展示用, 不参与鉴权; 每次成功调用刷新
// ============================================================
export const keys = sqliteTable(
  'keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * sk-gw-<random 43 chars> 的 sha256 hex 形态, 长 64.
     * 加 uniqueIndex 既能避免重复, 又让鉴权查询走 B-tree.
     */
    keyHash: text('key_hash').notNull(),
    /** 显示用前缀, 例: sk-gw-...x9k2. 不参与鉴权, 不必唯一 */
    keyPreview: text('key_preview').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').notNull().default('chat'),
    /** unix ms, null 表示永不过期 */
    expiresAt: integer('expires_at'),
    /** unix ms, null 表示未吊销; 非 null 即「即时吊销」生效时间 */
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
// 运行时类型. Drizzle 从 schema 推导, 不需要手写 interface.
// ============================================================
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Key = typeof keys.$inferSelect;
export type NewKey = typeof keys.$inferInsert;
