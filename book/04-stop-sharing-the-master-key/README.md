---
title: 第 4 章 不再共享主 Key
feishu_url: "https://www.feishu.cn/wiki/CclbwHiSVixs0LkfRcmcCVfHnpg"
last_synced: "2026-05-16T18:28:40"
---

## 4.1 一个无鉴权的网关是什么状态

v0.3 跑起来之后, 把 `http://localhost:3000` 这个地址发给任何同事都能立刻用——这是它最容易让人忽略的特性, 也是它最致命的缺陷。请求体里没有 Authorization, 网关也不会检查 Authorization。任何拿到 URL 的客户端发一发 `/v1/chat/completions`, 上游的额度就一点点被消耗掉。

这种状态在两种场景下都不可接受。企业基建场景下, 上游 Key 实际相当于被泄露给了整个内网——某个新来的实习生写了个死循环, 一个月的 OpenAI 账单可能多出一万美元, 而账单上看不到是哪台机器、哪个人发的。对外卖 token 场景下情况更糟: base URL 一旦被爬虫扫到, 接下来几小时上游配额就会被白嫖光, 业务直接停摆。

要给网关加鉴权, 直观的做法是「让所有客户端共用上游 Key」: 客户端的 Authorization header 里直接挂 OpenAI 那把 `sk-...`, 网关把它原样转发给上游就好。这条路有两个不可接受的后果。其一, 上游 Key 通过客户端代码扩散出去, 一旦泄露要全员换 Key, 而 OpenAI 不允许同一组织无限制签发 Key, 换 Key 本身就是一个生产事故级别的动作。其二, 上游 Key 没有「按用户归因」的能力——OpenAI 给你的账单只能精确到组织, 网关层若不自己签发独立 Key, 谁用了多少永远是一笔糊涂账。

正确做法是引入「内部 Key」: 网关自己签发一套带前缀的 Key (例如 `sk-gw-...`) 发给客户端, 客户端用这把 Key 调网关; 网关在中间用 OpenAI / Anthropic / DeepSeek 各自的「外部 Key」去调上游。这两套 Key 在网关里有完全不同的生命周期、存储位置与吊销机制, **必须分两套体系管理**。one-api 把这两套 Key 叫做 `Token` (内部, `model/token.go`) 与 `Channel.Key` (外部, `model/channel.go`); 本书沿用这一拆分, 但表名取得更直白: 内部 Key 进 `keys` 表, 外部上游 Key 在本章仍走环境变量, 等 Ch8 引入渠道池时再迁到 `channels` 表。

本章要落地的能力清单:

- 给每位用户 / 每条业务线签发独立的内部 Key, 客户端用这把 Key 调网关。
- 每把 Key 带元数据: 名字 (便于 UI 识别)、scope (留作扩展)、过期时间、即时吊销标记、最后使用时间。
- Hono middleware 在每个 LLM 调用前做 Bearer Token 鉴权, 验证失败直接 401。
- 一组 admin HTTP API + 一个命令行工具, 用来创建用户、签发 Key、列 Key、吊销 Key。

落地这些能力会撞上一件 v0.1 ~ v0.3 一直回避的事: 持久化。Key 元数据、过期时间、吊销标记都是「跨请求保持的状态」, 必须落盘, 否则进程一重启就丢。这是本书第一次引入数据库。

## 4.2 持久层为什么留到第 4 章才出现

把数据库的引入延后到第 4 章, 不是为了凑章节, 而是工程意义上的必要节奏。Ch1 的 30 行 Hono 透传不需要任何状态, Ch2 的 Adaptor 抽象与 Ch3 的协议翻译都是「同一份请求转一道、响应转回去」的纯过程, 整条链路没有任何「下一次请求要看上次发生了什么」的需求。前 3 章每次启动都是从零的状态, 写代码与跑代码都不需要数据库。

到 v0.4 才出现真正的状态需求: 客户端 A 持有的 Key 在请求 12:00 时是「有效」, 在 12:05 被运维吊销之后所有后续请求必须立即 401——这个「吊销标记」必须存在某个跨请求的地方。把它放进进程内存里就行了? 不行, 因为进程一重启状态就丢; 而且 Key 元数据 (名字、过期时间) 是运维要在 UI 上看的, 不可能每次重启都丢失。所以 Ch4 是工程上「不得不引入持久层」的第一个章节。

具体选 SQLite + Drizzle ORM 的理由在 `research/ts-stack-selection.md` 已经讲清楚, 这里复述要点。SQLite 通过 `better-sqlite3` 这个 native module 拿到, 单文件数据库, 零额外服务依赖——读者 `npm install` 完即可跑, 不用先装 Postgres。better-sqlite3 给的是**同步 API** (区别于 `node:sqlite` 与 `sqlite3` 的异步接口), 代码读起来不用到处 `await`, 教学价值更高; 同步并不意味着会卡 Node 事件循环, 因为单次 SQL 在 SQLite 上的耗时在亚毫秒级, 远低于网络抖动。

ORM 选 Drizzle 而不是 Prisma, 三条理由叠加: 第一, Drizzle 的 schema 直接写在 TypeScript 文件里 (zod 风格), 类型自动从 schema 推导出来, 不需要 `prisma generate` 这一步; 第二, Drizzle 生成的 SQL 可见, 教学上没有黑盒; 第三, Prisma 的 query engine 是 Rust 二进制, 部署 Cloudflare Workers 时跑不起来, 与本书后续章节的「跨 runtime」承诺冲突。Drizzle 配合 better-sqlite3 的连接器, 类型推导贯穿 select / insert / update / delete, IDE 自动补全友好, 配合 zod 校验输入, 整个数据访问链路类型闭合。

不引入 Postgres 的理由也要明确说一下。生产部署当然可以切 Postgres, Drizzle 的 schema 文件几乎不用改, 只换 driver——Ch12 的部署章节会演示这条切换路径。但 Ch4 的目标是「读者跟着跑通最小可用版本」, 多引入一个 Docker 服务会把章节的关注点稀释掉。SQLite 单机可承受的 QPS 取决于读写比例: 内部 Key 体系读多写少 (鉴权是高频读, 签发 / 吊销是低频写), 实测在 WAL 模式下单机过千 QPS 没有压力。这本来就不是网关瓶颈所在, 瓶颈在上游 LLM 服务的响应延迟。

## 4.3 三层数据模型: Org / User / Key

数据模型最小化但保留扩展空间。三张表的关系是 `orgs (1) -> users (n) -> keys (n)`。

`orgs` 表对应「组织 / 业务线」这层。企业基建场景下一个部门或一条业务线就是一个 org; 对外卖 token 场景下一个付费客户公司就是一个 org。one-api 在这一层做了简化——它没有 org 表, 直接 `User` 顶到底, 后期做团队隔离时再补 `Group` 字段塞进 user 表 (`model/user.go:51` 的 `Group` 列)。本书在 Ch4 就把 org 单拉一张表, 理由有两条: 第一, Ch5 的账单聚合天然按 org 出 (一个客户公司一张账单), 提前把表建好后续聚合 SQL 不用改; 第二, 一个 org 整体禁用 (例如对外卖 token 时某个客户欠费) 要比逐 user 禁用方便, 表结构上加一行 `disabledAt` 字段就能批量生效。

`users` 表对应「个人账号」。企业基建场景下一名员工一个 user, 对外卖 token 场景下一个开发者账号一个 user。字段精简: `name` 仅供 UI 显示, 不参与鉴权; `email` 用于通知与去重 (本章不接邮件, 字段留出); `disabledAt` 是用户级别的即时禁用标记。one-api 的 `User` 表字段繁多 (`model/user.go:34`-`54` 一共 18 个字段, 包含 GitHub / WeChat / Lark / OIDC 等第三方登录映射), 本书的 v0.4 不涉及登录系统, 这些字段全部省略——读者真要做对外创业, 后面 Ch11 钱包章再补。

`keys` 表是本章核心。字段设计:

| 字段 | 类型 | 作用 |
|------|------|------|
| `id` | integer pk | 主键; 计费 / 日志 / 限流后续都按 keyId 归因 |
| `user_id` | integer fk | 反查所属 user |
| `key_hash` | text, unique | **sha256(明文 Key)**, 唯一索引, 鉴权时按它反查 |
| `key_preview` | text | `sk-gw-...x9k2` 形式, 仅展示用, 不参与鉴权 |
| `name` | text | 用户自取的标签 (`CI Bot` / `Production`) |
| `scopes` | text | 逗号分隔的 scope 列表, 留作扩展 (默认 `chat`) |
| `expires_at` | integer (unix ms), nullable | null 表示永不过期, 非 null 的过期 key 鉴权时直接拒 |
| `disabled_at` | integer (unix ms), nullable | 即时吊销标记; 软删, 不删行 |
| `last_used_at` | integer (unix ms), nullable | 仅展示用, 鉴权成功后异步刷新, 不阻塞主路径 |
| `created_at` | integer (unix ms) | 创建时间 |

最关键的字段是 `key_hash`: **数据库永远只存 sha256 哈希, 不存明文**。这条规则不能让步, 后面单独一节讲为什么。

`expires_at` 与 `disabled_at` 是两个互补的字段, 容易让人误以为重复。区别在: `expires_at` 是签发时设定的「被动失效」时间, 比如「这把 Key 90 天后过期」; `disabled_at` 是运维主动写入的「即时吊销」时间戳, 比如「这把 Key 现在 (Date.now() ms) 起立刻不能再用」。鉴权时两个都要查, 任意一个命中 (key.expires_at <= now 或 key.disabled_at !== null) 就 401 拒绝。

`last_used_at` 不参与鉴权决策, 只用于 UI 展示「这把 Key 最近用过吗」。它的更新策略很值得讲一下, 后面 4.6 节单独说。

Drizzle 的 schema 直接在 TS 里写, 类型推导一路贯穿到运行时:

```ts
// src/db/schema.ts
export const keys = sqliteTable(
  'keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id),
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

export type Key = typeof keys.$inferSelect;
export type NewKey = typeof keys.$inferInsert;
```

`Key` 与 `NewKey` 是 Drizzle 从 schema 推出来的运行时类型, 不需要手写 interface。

## 4.4 Migration 文件的约定

数据库结构变更必须经过 migration 文件落盘, 不允许程序启动时 `CREATE TABLE IF NOT EXISTS` 拍一遍。这是工程约定, 理由有二: 第一, schema.ts 变更与数据库结构变更必须可追溯——读者拉到 git 仓库的某个 commit, 应该能立刻判断「这个 commit 对应的数据库长什么样」; 第二, 后续章节会反复加字段、加索引, 没有 migration 历史就没法回退。

文件命名约定: `drizzle/<4 位编号>_<描述>.sql`, 编号递增, 每章新加一份。Ch4 的首份是 `drizzle/0001_init.sql`, Ch5 加 `usage_records` 表会出现 `0002_usage_records.sql`, Ch6 给 keys 表加 `monthly_quota` 字段会出现 `0003_keys_add_quota.sql`, 以此类推。**已发布的 migration 文件不要手改**, 改了之后已经跑过的环境无法自动重放, 必须新加一份递增编号的文件来「在前一份之上加列 / 改列」。

应用 migration 的逻辑放在 `src/db/migrate.ts`, 简化实现 (够本章用):

```ts
// src/db/migrate.ts (节选)
export function runMigrations(): { applied: string[]; skipped: string[] } {
  const sqlite = getRawSqlite();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite
    .prepare<[], { filename: string }>('SELECT filename FROM __drizzle_migrations')
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO __drizzle_migrations VALUES (?, ?)').run(file, Date.now());
    });
    tx();
    applied.push(file);
  }
  return { applied, skipped: files.filter((f) => appliedSet.has(f)) };
}
```

每次启动 (`src/index.ts` 开头) 都跑一次 `runMigrations()`, 已经应用过的文件被记录在 `__drizzle_migrations` 表里, 重复跑不会重复执行。整个 migration 包在事务里, 半途失败会回滚, 不会留下「半应用」的脏状态。

生产环境的更稳健做法是把启动时自动迁移换成单独的 `npm run migrate` 步骤——多实例部署时若每个实例启动都跑迁移, 会出现「多个实例同时执行 0002_xxx.sql」的竞态。Ch12 部署章会把这一点说清楚, 给出 wait-for-migration 的标准操作。但 v0.4 单机跑, 启动时自动迁移最省心。

Drizzle 自带一个迁移工具 `drizzle-kit`, 用 `npm run drizzle:generate` 命令可以根据 `schema.ts` 的变化自动生成下一份 migration SQL。本章已经手写好首份 `0001_init.sql` 让读者无需先跑生成命令就能启动, 但读者后续给 schema 加字段时, 应该用 `drizzle:generate` 而不是手写——工具会自动处理「跨 SQLite / Postgres / MySQL 的 SQL 方言差异」与「rename column 时的数据迁移」这类容易写错的细节。

## 4.5 Key 的形态与哈希存储

Key 的明文形态: 前缀 `sk-gw-` + 32 字节 CSPRNG 随机串的 base64url 编码。base64url 把 32 字节 (256 bit) 编成 43 个字符, 字符集是 `[A-Za-z0-9_-]`, 拼上 6 个字符的前缀总长 49。完整一把 Key 长这样:

```
sk-gw-Rk2P9Xz1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab
```

前缀 `sk-gw-` 取自 OpenAI 的 `sk-` 约定 (各家 LLM 厂商的 Key 都是这个开头) 加上 `gw` 标识网关——客户端代码看一眼就知道这是网关签发的内部 Key, 不会和上游 Key 混淆。one-api 的 Token 不带前缀, 明文长度也只有 48 字符, 用 ASCII 字母数字混合而成 (`common/random/main.go:23`); 区别是它的 Token 直接以明文存进数据库, 鉴权时把客户端传来的明文与数据库行 `key` 字段做明文匹配——这种方式数据库一旦泄露所有 Token 立刻失效。本书不沿用。

生成逻辑:

```ts
// src/auth/key.ts
const KEY_PREFIX = 'sk-gw-';
const KEY_RANDOM_BYTES = 32;

export function generateKey(): GeneratedKey {
  const random = randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  const plaintext = `${KEY_PREFIX}${random}`;
  const hash = sha256Hex(plaintext);
  const preview = `${KEY_PREFIX}...${plaintext.slice(-4)}`;
  return { plaintext, hash, preview };
}
```

`crypto.randomBytes(32)` 走系统 CSPRNG (`/dev/urandom` on Linux), 256 bit 的熵远超「能被暴力枚举」的界限——即便攻击者拿到全部哈希值, 也无法通过暴力猜测复原任何一把明文。base64url 而非 base64 是为了让 Key 字面里不出现 `/` 与 `+`, 整把 Key 可以直接放进 URL 路径或 query 而不需要 encode。

**为什么数据库只存 sha256 哈希, 不存明文**, 是本章最不能让步的设计决策。理由分三层:

第一层, 数据库是单点泄露风险面。SQLite 文件备份会被复制到运维的笔记本上、Postgres 实例会被云控制台导出、定期备份会上传到 S3。任何一个环节泄露, 如果存的是明文, 攻击者立刻拥有所有客户端 Key 的明文, 可以马上去消耗上游配额。存哈希则攻击者拿到 sha256 列只能干瞪眼——sha256 不可逆, 256 bit 熵不可暴力。

第二层, 鉴权链路不需要明文。鉴权要做的事是「拿到客户端发来的明文 Key, 验证它合法」: 把明文 hash 一下, 用结果在 `key_hash` 列上做 unique index 查询即可。完全不需要从 DB 取出明文与客户端比对。

第三层, 这套模式不是本书发明的, 而是行业最佳实践。GitHub Personal Access Token 用同样的方式存 (GitHub 的工程博客明确写过)、Stripe 的 secret_key 用同样的方式存、AWS 的 access key 用同样的方式存。one-api 是一个明显的反例——它的 `Token.Key` 直接存明文 (`model/token.go:26`), 用 unique index 反查; 这是 one-api 的安全缺陷, 本书不沿用。

**明文只在创建时返回给调用方一次**, 后续从任何接口都拿不到。这意味着用户丢失 Key 不能找回, 只能吊销旧的 + 重新签发——这是规范行为, 不是 UX 缺陷, GitHub PAT 的体验也是这样。

不用 bcrypt / argon2 这类「慢哈希」的原因要说一下。bcrypt 与 argon2 是为「人类口令」设计的, 抗暴力破解; 而本章的 Key 本身就有 256 bit 熵, 暴力破解的难度等同于直接猜原始 Key, 加慢哈希反而拖慢鉴权 P99。sha256 已经远超「数据库泄露后能被还原」的安全边界, 对 256 bit 高熵输入来说足够。

`key_preview` 字段长 `sk-gw-...x9k2`, 取明文最后 4 个字符。这条信息不参与鉴权, 唯一用途是让运维在 UI 列表里识别 Key——「哪把 Key 上周被吊销了」「哪把 Key 30 天没用过」, 看 preview 就够。完整明文永远不在 UI 上出现。

## 4.6 Hono middleware 的鉴权链路

鉴权 middleware 的位置: 挂在 `/v1/chat/completions` 与 `/v1/messages` 两条 LLM 路由上, 在路由 handler 执行前完成校验。健康检查 `/healthz` 不挂鉴权 (方便外部探活), `/admin/*` 用另一套 master token 鉴权 (下一节单独讲)。

链路五步:

```ts
// src/auth/middleware.ts (节选)
export const requireGatewayKey: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  // 1. 从 Authorization header 剥出 Bearer Token
  const plaintext = extractBearerToken(c);
  if (!plaintext) {
    return c.json({ error: { message: 'missing or malformed Authorization header' } }, 401);
  }
  // 2. 形态校验: 必须以 sk-gw- 开头
  if (!isWellFormedKey(plaintext)) {
    return c.json({ error: { message: 'key format invalid; expected prefix sk-gw-' } }, 401);
  }

  // 3. 对明文算 sha256, 在 keys 表按 keyHash 反查
  const keyHash = hashKey(plaintext);
  const db = getDb();
  const rows = db
    .select({
      keyId: keys.id,
      keyDisabledAt: keys.disabledAt,
      keyExpiresAt: keys.expiresAt,
      scopes: keys.scopes,
      userId: users.id,
      userDisabledAt: users.disabledAt,
      orgId: orgs.id,
      orgDisabledAt: orgs.disabledAt,
    })
    .from(keys)
    .innerJoin(users, eq(users.id, keys.userId))
    .innerJoin(orgs, eq(orgs.id, users.orgId))
    .where(eq(keys.keyHash, keyHash))
    .all();
  if (rows.length === 0) {
    return c.json({ error: { message: 'invalid key' } }, 401);
  }

  // 4. 校验 expires_at / disabled_at, 联查 user / org 的 disabled_at
  const row = rows[0]!;
  const now = Date.now();
  if (row.keyDisabledAt !== null) {
    return c.json({ error: { message: 'key has been revoked' } }, 401);
  }
  if (row.keyExpiresAt !== null && row.keyExpiresAt <= now) {
    return c.json({ error: { message: 'key has expired' } }, 401);
  }
  if (row.userDisabledAt !== null) {
    return c.json({ error: { message: 'user is disabled' } }, 403);
  }
  if (row.orgDisabledAt !== null) {
    return c.json({ error: { message: 'org is disabled' } }, 403);
  }

  // 5. 异步刷新 lastUsedAt, 注入 ctx, 放行
  setImmediate(() => {
    db.update(keys).set({ lastUsedAt: now }).where(eq(keys.id, row.keyId)).run();
  });
  c.set('auth', {
    keyId: row.keyId,
    userId: row.userId,
    orgId: row.orgId,
    scopes: parseScopes(row.scopes),
  });
  await next();
};
```

几处工程细节值得展开。

**为什么一次 join 拿三张表的字段, 而不是查完 keys 再分别查 users / orgs。**鉴权是高频路径, 每多一次 round trip 就多一次哈希查找 + 索引扫描。SQLite 的 inner join 在主键索引上耗时可以忽略, 一次 join 把鉴权所需的全部信息 (keyId / userId / orgId + 三层 disabled_at) 拿齐, 比串行三次查快得多, 也比客户端代码自己拼接更不容易写错。

> **关键设计: 401 vs 403 必须分开**
>
> Key 形态不对、查不到、被吊销、已过期 → 返 **401**, 因为客户端可以重新签发一把 Key 解决.
> User / Org 被禁 → 返 **403**, 因为「Key 本身合法, 但权限不足」, 客户端换 Key 也没用, 这条信号应该让调用方意识到要联系网关运维.
>
> OpenAI / Anthropic / GitHub 都用同样的 401 vs 403 区分, 客户端 SDK 通常会基于此决定下一步动作 (401 触发 token refresh, 403 直接抛错给用户). 把它们混到一个状态码上, 客户端就只能靠 error.body 里的 message 字符串猜——这是 API 设计里最常见也最不该犯的错.

**为什么 `lastUsedAt` 用 `setImmediate` 异步刷新。**better-sqlite3 是同步 API, 同步写 `lastUsedAt` 会在 hot path 上拿一次写锁。鉴权链路本身在亚毫秒级, 加一次写锁会把 P99 拖到几十毫秒。`setImmediate` 把写操作丢到下一个 event loop tick, 鉴权先返回 200, 写失败也无碍主流程。这种「成功路径上的非关键写操作不阻塞主请求」的模式, 在后续章节 (Ch5 的账单写入、Ch9 的日志落盘) 会反复出现。

**为什么 `scopes` 在本章不参与鉴权决策。**Ch4 的实现只把 `scopes` 字段读出来注入 ctx, 不在 middleware 里基于它做拦截。原因是 scope 的语义跨章节, Ch4 只需要「Key 是否合法」这一条判断, 真正的 scope 检查 (例如「只能调用 chat 接口, 不能调用 embeddings」) 在 Ch11 的钱包章会和「按 scope 限速」一起做。提前把字段建好, 后续接入零改动。

对照 one-api 的 `middleware/auth.go:91` 的 `TokenAuth`, 设计取舍可以看清:

| 维度 | one-api `TokenAuth` | 本书 `requireGatewayKey` |
|------|---------------------|---------------------|
| Key 反查 | 明文做 unique index 查询 | sha256 哈希做 unique index 查询 |
| 校验逻辑位置 | 拆到 `model.ValidateUserToken` 函数 (`model/token.go:62`) | 内联在 middleware 自己 |
| 缓存 | 走 Redis (`CacheGetTokenByKey`) | 不引入缓存, 单机 SQLite 查询亚毫秒 |
| Subnet / 模型白名单 | 在 middleware 里做 | 本章不做, 留到 Ch6 配额 / Ch8 渠道 |
| ctx 注入 | `c.Set(ctxkey.Id, token.UserId)` 等 | `c.set('auth', { keyId, userId, orgId, scopes })` |

最关键的差异在 Key 存储形态。one-api 的明文存储让它的 Redis 缓存可以直接 `key -> token` 反查, 但代价是数据库泄露即全员失效。本书的哈希存储天然走 unique index, 单机 QPS 远超网关瓶颈, 不需要 Redis。

## 4.7 Admin API 的最小形态

Admin API 用一组单独的路由 `/admin/*` 暴露, 受 `ADMIN_TOKEN` 环境变量保护——这是本章最简单的鉴权方案: 任何带正确 Bearer Token 的请求都视为管理员, 不区分管理员身份。生产环境应当换成短期 access token + 后台登录, 但 v0.4 的目标只是把「能签发 Key」这条链路打通, 不展开身份系统。

接口清单设计得故意平铺, 避免读者一上来要理解嵌套资源:

```
POST   /admin/orgs              创建 org
POST   /admin/users             创建 user (body: { orgId, name, email? })
POST   /admin/keys              签发 Key  (body: { userId, name, expiresInDays?, scopes? })
GET    /admin/keys?userId=      列 Key (脱敏, 不返回明文)
DELETE /admin/keys/:id          即时吊销 Key (软删)
```

`POST /admin/keys` 是本章最关键的一条:

```ts
// src/admin/routes.ts (节选)
app.post('/keys', async (c) => {
  const schema = z.object({
    userId: z.number().int().positive(),
    name: z.string().min(1).max(100),
    expiresInDays: z.number().int().positive().max(3650).optional(),
    scopes: z.string().optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  // ... 校验 user 存在 ...

  const generated = generateKey();
  const expiresAt =
    parsed.data.expiresInDays !== undefined
      ? Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000
      : null;

  const rows = db.insert(keys).values({
    userId: parsed.data.userId,
    keyHash: generated.hash,
    keyPreview: generated.preview,
    name: parsed.data.name,
    scopes: parsed.data.scopes ?? 'chat',
    expiresAt,
    createdAt: Date.now(),
  }).returning().all();

  return c.json({
    id: rows[0]!.id,
    plaintext: generated.plaintext,  // (new) 明文只在这一次返回
    preview: generated.preview,
    name: rows[0]!.name,
    expiresAt: rows[0]!.expiresAt,
    warning: 'Save this plaintext now. It will never be shown again.',
  }, 201);
});
```

返回里 `plaintext` 字段只在 `POST /admin/keys` 出现一次, `GET /admin/keys` 永远不返回它——这是「明文只暴露一次」原则的代码层兑现。返回体里加 `warning` 字段, 提醒调用方立刻保存。

吊销接口走软删:

```ts
app.delete('/keys/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const updated = db
    .update(keys)
    .set({ disabledAt: Date.now() })
    .where(eq(keys.id, id))
    .returning()
    .all();
  if (updated.length === 0) {
    return c.json({ error: { message: `key ${id} not found` } }, 404);
  }
  return c.json({ id, disabledAt: updated[0]!.disabledAt });
});
```

「软删 = 写时间戳, 不删行」是本章另一条不让步的工程规则。理由: 后续 Ch5 的账单记录会按 keyId 反查, 如果 keys 表的行直接删了, 历史账单就反查不到 key 名字与所属 user, 给运维出账时找不到归因。`disabled_at` 字段同时承担「即时吊销标记」与「吊销时间审计」两件事, 用一个列就把工程意图说清楚。

主令牌的校验逻辑独立成另一个 middleware:

```ts
export function requireAdminToken(): MiddlewareHandler {
  return async (c, next) => {
    const required = process.env.ADMIN_TOKEN ?? '';
    if (!required) {
      return c.json({ error: { message: 'ADMIN_TOKEN env var is not configured on server' } }, 500);
    }
    const provided = extractBearerToken(c);
    if (!provided) {
      return c.json({ error: { message: 'missing Authorization header' } }, 401);
    }
    if (!constantTimeEqual(provided, required)) {
      return c.json({ error: { message: 'invalid admin token' } }, 401);
    }
    await next();
  };
}
```

`constantTimeEqual` 走 `crypto.timingSafeEqual`, 防御时序侧信道——`ADMIN_TOKEN` 是低熵字符串 (人类设的, 不像 sk-gw 那样有 256 bit 熵), 必须常量时间比对。

注意 admin 路由套 `requireAdminToken`, LLM 路由套 `requireGatewayKey`。两套鉴权完全不能交叉: 拿 admin token 调 `/v1/chat/completions` 也会被 401 (形态校验通不过), 拿 gateway key 调 `/admin/keys` 也会被 401 (admin token 比对通不过)。两条路径在代码上是独立的 middleware, 互不影响。

## 4.8 命令行签发: 服务器初始化时的第一把 Key

Admin API 是 HTTP 接口, 但服务器刚装好的瞬间还没有任何 Key——这时 `curl` 自己的 admin API 总不能没有 ADMIN_TOKEN 就先 chicken-and-egg。本章给一个命令行工具 `src/cli/issue-key.ts`, 直接读 SQLite 文件签出第一把 Key, 不需要 HTTP 链路。

```bash
npm run issue-key -- --org "Acme Inc" --user "alice" --name "smoke-test"
```

执行流程:

1. 跑一次 `runMigrations()` 确保表结构就位 (服务器还没启动过的话);
2. 解析参数, 若 `--user-id` 没给就按 `--org` + `--user` 找 / 建 org 与 user;
3. 调 `generateKey()` 生成新 Key;
4. 直接走 Drizzle insert 写入 `keys` 表;
5. stdout 打印明文 + 预览 + 过期时间。

CLI 与 admin API 的关键区别在: CLI 直接打开 SQLite 文件操作, 不经过 HTTP, 也不需要 ADMIN_TOKEN——它默认「能跑这个 CLI 的人就是服务器管理员」。这种「root 工具」的设计模式在 GitLab `gitlab-rails console` / Discourse `bin/console` 里都能见到, 适合做 break-glass 操作 (例如忘记 admin token 的时候, 用 CLI 重签一个 admin 用的 Key)。

输出示例:

```
[cli] created org #1 "Acme Inc"
[cli] created user #1 "alice" in org #1

=== Save this plaintext now. It will never be shown again. ===
KEY_ID:     1
USER_ID:    1
NAME:       smoke-test
PREVIEW:    sk-gw-...X2XI
EXPIRES:    never
PLAINTEXT:  sk-gw-0cVKr3kF31a-Niy2B8H0Gghsil8yoNlvsyinrflX2XI
```

`PLAINTEXT` 一行就是下游客户端要用的 Bearer Token, 复制走立刻就能调网关。

## 4.9 内外两套 Key 体系的边界

整章反复强调「内外两套 Key 必须分开管理」, 这一节把这条原则正面说一遍——为什么不能合并、能不能用同一张表存。

| 维度 | 外部 Key (上游) | 内部 Key (下游) |
|------|----------------|----------------|
| 字面形态 | OpenAI `sk-...` / Anthropic `sk-ant-...` | `sk-gw-...` |
| 存储位置 | `.env` 环境变量 (Ch8 起迁到 `channels` 表) | DB 的 `keys` 表 (sha256) |
| 持有者 | 网关运维 (你) | 客户端 (其他人) |
| 申请来源 | OpenAI / Anthropic / DeepSeek 官网 | 网关自家的 admin API / CLI |
| 生命周期 | 由上游平台决定; 网关运维只能换不能签 | 由网关运维决定; 即时可签可吊销 |
| 暴露给客户端 | 永不 | 一次 (创建时) |
| 鉴权用途 | 用于发请求**给**上游 (Authorization header / x-api-key) | 用于验证客户端的请求是否合法 |

两套 Key 的方向完全相反——一个是网关「持有」并花给上游的额度凭证, 一个是网关「签发」给客户端的访问凭证。把它们合到一张表会出现两类灾难场景:

第一, 客户端拿到内部 Key 不会拿到上游 Key, 这是正确隔离。如果合到一张表, 那么任何一次客户端 Key 泄露都可能附带泄露上游 Key (取决于代码怎么读)。

第二, 上游 Key 是网关运维的资产, 它的吊销由上游平台触发 (例如 OpenAI 检测到异常使用主动 ban); 内部 Key 是网关运维主动签发的, 它的吊销由 admin API 触发。两套生命周期由完全不同的事件源驱动, 表设计也应该不同——外部 Key 需要「健康状态」「错误统计」「故障转移权重」(Ch8 的 channels 表的字段), 内部 Key 需要「scope」「过期时间」「按用户归因」(本章的 keys 表的字段)。

one-api 的设计是这样隔离的——`Token` 表对应内部 Key, `Channel` 表对应外部 Key, 两张表用 `relay/controller/relay.go` 串起来。本书沿用同一拆分, 但把 Channel 的引入延后到 Ch8——v0.4 的目标只是「让内部 Key 落地」, Channel 表先不要建, 防止读者一次性面对太多新概念。

## 4.10 v0.4 的运行验证

跑通本章所有路径不需要任何上游 Key, 上游 Key 可以留作 `sk-replace-me` 占位。完整端到端测试只验证「鉴权层是否工作」, 上游调用失败属于预期 (`sk-replace-me` 会拿到上游的 401 或网络错误)。

启动:

```bash
cd examples/04-stop-sharing-the-master-key
cp .env.example .env
# 必改: ADMIN_TOKEN 改成你自己的强随机串
npm install                      # better-sqlite3 native module 编译, 约 10-30 秒
npm run dev
```

启动日志:

```
INFO db_migrations_applied applied=["0001_init.sql"]
INFO Gateway v0.4 listening on http://localhost:3000
```

注意 `db_migrations_applied` 日志——首次启动会自动跑 `0001_init.sql` 创建三张表, 第二次启动会跳过 (`__drizzle_migrations` 表里有记录)。

健康检查不带鉴权:

```bash
curl http://localhost:3000/healthz
# {
#   "ok": true,
#   "version": "v0.4",
#   "routes": [...],
#   "extra_endpoints": ["/v1/messages (Anthropic passthrough)", "/admin/* (admin API)"]
# }
```

不带 Key 调 LLM 路由:

```bash
$ curl -i -X POST http://localhost:3000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
HTTP/1.1 401 Unauthorized
{"error":{"message":"missing or malformed Authorization header"}}
```

形态不对:

```bash
$ curl -i -X POST http://localhost:3000/v1/chat/completions \
    -H "Authorization: Bearer not-a-gw-key" ...
HTTP/1.1 401 Unauthorized
{"error":{"message":"key format invalid; expected prefix sk-gw-"}}
```

用 admin API 完整签发链路 (假设 `ADMIN_TOKEN=test-admin-token-12345`):

```bash
$ curl -X POST http://localhost:3000/admin/orgs \
    -H "Authorization: Bearer test-admin-token-12345" \
    -H "Content-Type: application/json" \
    -d '{"name":"Acme Inc"}'
{"id":1,"name":"Acme Inc","disabledAt":null,"createdAt":1778787163795}

$ curl -X POST http://localhost:3000/admin/users \
    -H "Authorization: Bearer test-admin-token-12345" \
    -H "Content-Type: application/json" \
    -d '{"orgId":1,"name":"alice","email":"alice@acme.test"}'
{"id":1,"orgId":1,"name":"alice",...}

$ curl -X POST http://localhost:3000/admin/keys \
    -H "Authorization: Bearer test-admin-token-12345" \
    -H "Content-Type: application/json" \
    -d '{"userId":1,"name":"smoke","expiresInDays":30}'
{
  "id":1,
  "plaintext":"sk-gw-0cVKr3kF31a-Niy2B8H0Gghsil8yoNlvsyinrflX2XI",
  "preview":"sk-gw-...X2XI",
  "name":"smoke",
  "scopes":"chat",
  "expiresAt":1781379163820,
  "createdAt":1778787163820,
  "warning":"Save this plaintext now. It will never be shown again."
}
```

把 `plaintext` 字段的值复制走当 Bearer Token:

```bash
$ GATEWAY_KEY=sk-gw-0cVKr3kF31a-Niy2B8H0Gghsil8yoNlvsyinrflX2XI
$ curl -i -X POST http://localhost:3000/v1/chat/completions \
    -H "Authorization: Bearer $GATEWAY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
HTTP/1.1 502 Bad Gateway   # 网关层鉴权过了, 上游 sk-replace-me 不存在
{"error":{"message":"upstream network error"}}
```

服务端日志:

```
INFO upstream_network_error key_id=1 user_id=1 provider=openai model=gpt-4o-mini err="fetch failed"
```

日志里 `key_id=1 user_id=1` 表明鉴权 middleware 成功注入了 ctx——上游调用失败是 sk-replace-me 占位 Key 的预期结果, 与鉴权无关。把 OPENAI_API_KEY 换成真实 Key, 上游会正常返回 200。

吊销 Key, 再用同一把:

```bash
$ curl -X DELETE http://localhost:3000/admin/keys/1 \
    -H "Authorization: Bearer test-admin-token-12345"
{"id":1,"disabledAt":1778787164147}

$ curl -i -X POST http://localhost:3000/v1/chat/completions \
    -H "Authorization: Bearer $GATEWAY_KEY" ...
HTTP/1.1 401 Unauthorized
{"error":{"message":"key has been revoked"}}
```

吊销立刻生效, 不需要重启服务, 不需要等缓存过期——直接走 DB 查询所以总是看到最新状态。

过期 Key 的验证需要构造一把已过期的 Key (admin API 只允许 `expiresInDays > 0`)。读者可以临时把系统时间往后调, 或者用 `npm run issue-key -- --expires-days 1` 后用 `sqlite3 data/gateway.db "UPDATE keys SET expires_at = 1 WHERE id = ..."` 把过期时间手动改成过去。鉴权层会返回:

```
HTTP/1.1 401 Unauthorized
{"error":{"message":"key has expired"}}
```

CLI 签发等价于走一遍 admin API + DB insert:

```bash
$ npm run issue-key -- --org "TestCo" --user "bob" --name "cli-smoke"
[cli] created org #1 "TestCo"
[cli] created user #1 "bob" in org #1

=== Save this plaintext now. It will never be shown again. ===
KEY_ID:     1
PLAINTEXT:  sk-gw-ik9NEINcfyzvzu8CU5LfqP6Xd0mAH6u38eyq9mW7VMc
```

## 4.11 一处常见的设计错误: 把 Authorization 同时承担两种含义

有一种容易出错的模式: 既要让网关支持「客户端用内部 Key 调网关」, 又要让网关支持「客户端用上游 Key 直接调网关」(把网关当反向代理用)。两种含义共用同一个 Authorization header, 网关靠前缀判断:

```ts
// 不要这样写
const token = c.req.header('Authorization')!.replace('Bearer ', '');
if (token.startsWith('sk-gw-')) {
  // 内部 Key 鉴权
} else {
  // 视为上游 Key, 直接转发
}
```

这种设计在两种场景下都会出事故。第一, 「直通模式」意味着上游 Key 经过网关——网关运维有意无意都能记录到完整明文 (日志里、内存里、错误堆栈里), 这构成对客户端的不必要权限暴露。第二, 一旦判断逻辑出 bug (例如 OpenAI 改了 Key 前缀), 内部 Key 可能被当成上游 Key 直接透传给真实 API, 上游会返回 401 但泄露了网关存在的事实——本来应该被网关本地拦截的请求穿透了。

正确做法是: 网关只接受内部 Key, 上游 Key 永远不暴露在客户端可触及的位置。**对外暴露的每一个 endpoint 都必须经过内部 Key 鉴权**, 没有「透传模式」这个口子。Ch3 末尾埋的旁路 `/v1/messages` 在本章也接入了 `requireGatewayKey`, 与主路径完全对等——不允许出现「某条路径绕过基础设施」的特例。

one-api 在这一点上的实现就是干净的: 它的 admin 后台与 LLM 转发都走 `Token`, 上游 `Channel.Key` 永远只在服务端使用 (`middleware/distributor.go:73` 把 Channel.Key 写进 Request header 之前已经把客户端的 Authorization 完全替换掉)。本书沿用同一设计。

## 4.12 v0.4 之后还差什么

把本章实现完, 客户端能用按用户签发的独立 Key 调网关、运维能即时吊销出问题的 Key、内外两套 Key 体系完全隔离。但用一个月的视角看, v0.4 暴露的下一道工程缺口非常明显:

```
月底了, 8000 美元的账单, 你能说清楚:
  - 这 8000 在 10 把 Key 之间如何分布吗?
  - 每把 Key 调了哪些模型?
  - input 占多少, output 占多少 (input 的单价通常是 output 的 1/3 ~ 1/5)?
  - 流式响应的 token 是否记全了 (客户端中途断开时漏计的几率)?
```

v0.4 的鉴权 middleware 只记录了「请求是否被允许」, 没有记录「请求消耗了什么」。Ch5 要补的是计费链路: token 计数 (tiktoken 本地估算 + 上游 usage 校准, 两路对账)、价格表 (model × provider × 时间窗)、两阶段计费 (预扣 + 实结)、`usage_records` 表落账。这套链路会成为 Ch6 (限流的 TPM 维度依赖能算 token)、Ch9 (按 trace_id 反查全链路时的金额还原)、Ch10 (成本优化效果对比) 三章的共同基础设施。

## 配套代码

完整可运行的 v0.4 代码在 `examples/04-stop-sharing-the-master-key/`, 目录结构:

```
src/
  index.ts                  # Hono 入口, 主路径 + /v1/messages 旁路均套鉴权
  db/
    client.ts               # (new) better-sqlite3 + Drizzle 实例 (单例)
    schema.ts               # (new) orgs / users / keys 三张表
    migrate.ts              # (new) 启动时自动跑 drizzle/*.sql
  auth/
    key.ts                  # (new) Key 生成 / 哈希 / 形态校验
    middleware.ts           # (new) Bearer Token 鉴权 + admin token 鉴权
  admin/
    routes.ts               # (new) /admin/* 管理 API
  cli/
    issue-key.ts            # (new) 命令行签发第一把 Key
  adaptors/                 # 与 v0.3 一致
  streaming/                # 与 v0.3 一致
  types/                    # 与 v0.3 一致
  router.ts                 # 与 v0.3 一致
drizzle/
  0001_init.sql             # (new) 首份 migration
data/                       # SQLite 文件落盘位置, 启动自动创建
```

按 README 指引 `npm install && npm run dev` 即可起服务。`npm install` 会编译 `better-sqlite3` 这个 native module, 在 Linux 上需要 `build-essential` 工具链; Node 24+ 用户可以直接下到对应 ABI 的预编译二进制, 不需要本地编译。

## 下一章预告

v0.4 之后, 每位用户 / 每条业务线持有独立 Key, 出问题能即时吊销, 上下游 Key 的生命周期完全隔离。但当月度账单到来时, v0.4 只记录了请求是否被允许, 没有记录请求消耗了什么——账单上 8000 美元的总花费, 在每把 Key、每个模型、input 与 output 之间如何分布, 现有日志说不清楚。

第 5 章把 token 计数 + 价格表 + 两阶段计费 + `usage_records` 表搭起来, 让网关能输出按用户、按模型、按业务线维度的精确账单。流式响应的计费需要边收边算 (客户端中途断开时漏计的边角也要处理掉), 这条流式计费链路在 Ch7 的 SSE 透传上还会闭环一次。Ch5 写完, 网关从「能拦」走到「能算」, 是把它推向生产可用最关键的一步。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)
