# 第 4 章 v0.4 配套代码

v0.3 完成了三家上游的协议适配，但对外暴露的 base URL 没有任何鉴权——任何拿到 URL 的客户端都能消耗上游额度。v0.4 引入内部 Key 体系，把外部上游 Key 与内部下游 Key 分两套生命周期管理。

## 目录结构

```
src/
  index.ts                  # Hono 入口, 主路径 + /v1/messages 旁路 (本章: 都套鉴权 middleware)
  db/
    client.ts               # ★ 本章新增: better-sqlite3 + Drizzle 实例 (单例)
    schema.ts               # ★ 本章新增: orgs / users / keys 三张表
    migrate.ts              # ★ 本章新增: 启动时自动跑 drizzle/*.sql
  auth/
    key.ts                  # ★ 本章新增: Key 生成 / 哈希 / 形态校验
    middleware.ts           # ★ 本章新增: Bearer Token 鉴权 + admin token 鉴权
  admin/
    routes.ts               # ★ 本章新增: /admin/* 管理 API (受 ADMIN_TOKEN 保护)
  cli/
    issue-key.ts            # ★ 本章新增: 命令行签发第一把 Key
  adaptors/                 # 与 v0.3 一致
  streaming/                # 与 v0.3 一致
  types/                    # 与 v0.3 一致
  router.ts                 # 与 v0.3 一致
drizzle/
  0001_init.sql             # ★ 本章新增: 首份 migration
data/
  gateway.db                # 启动后自动生成
```

## 依赖

- Node.js 20+
- npm
- 编译 `better-sqlite3` 需要本地有 C++ 工具链（macOS 自带；Linux 装 `build-essential`；Windows 装 `windows-build-tools`）

## 启动步骤

```bash
cp .env.example .env
# 至少改两件事:
#   ADMIN_TOKEN=admin-change-me   ->  改成你自己的强随机串
#   上游 Key (任选一家填上即可冒烟)

npm install                      # 编译 better-sqlite3 native module, 约 10-30 秒
npm run migrate                  # 显式跑 migration (可选, dev/start 也会自动跑)
npm run dev                      # 启动网关, 自动跑 migration, 监听 :3000
```

## 用 CLI 签出第一把 Key

```bash
# 另开一个终端
npm run issue-key -- --org "My Company" --user "alice" --name "smoke-test"
```

输出形如：

```
[cli] created org #1 "My Company"
[cli] created user #1 "alice" in org #1

=== Save this plaintext now. It will never be shown again. ===
KEY_ID:     1
USER_ID:    1
NAME:       smoke-test
PREVIEW:    sk-gw-...x9k2
EXPIRES:    never
PLAINTEXT:  sk-gw-Rk2P9...43-char-string
```

`PLAINTEXT` 即下游客户端要用的 Bearer Token。**只有这一次能看到它**，后续从 DB 取永远只是哈希 + 预览。

## 用 admin API 签发 Key（与 CLI 等价）

```bash
ADMIN_TOKEN=admin-change-me
BASE=http://localhost:3000

# 1. 建 org
curl -s -X POST $BASE/admin/orgs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Company"}'
# {"id":1,"name":"My Company","disabledAt":null,"createdAt":1715750000000}

# 2. 建 user
curl -s -X POST $BASE/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgId":1,"name":"alice","email":"alice@example.com"}'

# 3. 签发 Key (90 天过期)
curl -s -X POST $BASE/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"name":"ci-bot","expiresInDays":90}'
# {"id":1,"plaintext":"sk-gw-...","preview":"sk-gw-...x9k2", "warning":"Save this plaintext now..."}

# 4. 列出 user 1 的所有 Key (脱敏, 不返回明文)
curl -s "$BASE/admin/keys?userId=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 5. 即时吊销 Key #1
curl -s -X DELETE $BASE/admin/keys/1 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"id":1,"disabledAt":1715750999999}
```

## 用 Key 调上游

```bash
GATEWAY_KEY=sk-gw-...43-char-string

curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

如果上游 Key 也填了，会拿到真实回包。如果没填，会拿到上游的 401（透传），但网关层的鉴权已经过了。

## 预期错误响应

| 场景 | 状态码 | 错误信息 |
|------|--------|----------|
| 没带 Authorization | 401 | `missing or malformed Authorization header` |
| Authorization 不是 `sk-gw-` 形态 | 401 | `key format invalid; expected prefix sk-gw-` |
| Key 在 DB 里查不到 | 401 | `invalid key` |
| Key 已被 DELETE 吊销 | 401 | `key has been revoked` |
| Key 已过期 | 401 | `key has expired` |
| user 被禁 | 403 | `user is disabled` |
| org 被禁 | 403 | `org is disabled` |
| admin API 但没带 admin token | 401 | `missing Authorization header` |
| admin API 带错 admin token | 401 | `invalid admin token` |

## 相对 v0.3 的核心变化

| 变化 | 文件 | 说明 |
|------|------|------|
| 持久层首次引入 | `src/db/{client,schema,migrate}.ts` | better-sqlite3 + Drizzle ORM；schema 三张表；启动自动 migration |
| Key 生成 / 哈希 / 校验 | `src/auth/key.ts` | `sk-gw-` 前缀 + 32 字节 CSPRNG + sha256 哈希存储；明文只返一次 |
| Bearer Token 鉴权 middleware | `src/auth/middleware.ts` | 解析 Authorization → 哈希比对 → 检查 expires_at / disabled_at → 注入 ctx.var.auth |
| Admin HTTP API | `src/admin/routes.ts` | 创建 org / user / 签发 Key / 列 Key / 吊销 Key；受 ADMIN_TOKEN 保护 |
| CLI 工具 | `src/cli/issue-key.ts` | 服务器初始化时签出第一把 Key，免去先用 admin API 调链路 |
| 主路径鉴权 | `src/index.ts` | `/v1/chat/completions` 与 `/v1/messages` 都套 `requireGatewayKey` |

## 内外两套 Key 体系

| 维度 | 外部 Key (上游) | 内部 Key (下游) |
|------|----------------|----------------|
| 形态 | OpenAI: `sk-...` / Anthropic: `sk-ant-...` / DeepSeek: `sk-...` | `sk-gw-...` |
| 存储位置 | `.env` 环境变量 (Ch8 起迁到 channels 表) | DB 的 keys 表 (只存 sha256) |
| 持有者 | 网关运维（你） | 客户端（其他人） |
| 申请处 | OpenAI / Anthropic / DeepSeek 官网 | 网关自家的 admin API / CLI |
| 生命周期 | 由上游平台决定 | 由网关运维决定，支持即时吊销 |
| 暴露给客户端 | 永不 | 一次（创建时） |

## 暂不支持的能力

| 缺陷 | 解决章节 |
|------|---------|
| 不计费、不知道每把 Key 消耗了多少钱 | 第 5 章 |
| 不限流、单把 Key 可以打爆上游配额 | 第 6 章 |
| 流式仍未做 | 第 7 章 |
| 渠道池、故障转移 | 第 8 章 |
| 结构化日志、按 trace_id 反查 | 第 9 章 |
