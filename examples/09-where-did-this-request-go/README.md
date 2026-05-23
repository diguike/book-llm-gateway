# 第 9 章 v0.9 配套代码

v0.8 渠道切换是自动的, 但日志仍然是文本流 + 自由格式. 这一版把全 repo 的日志收口到 pino 结构化输出, 每条日志带 `trace_id` / `request_id` / `user_id` / `key_id` / `channel_id` / `prompt_tokens` / `completion_tokens` / `upstream_latency_ms` / `total_latency_ms` / `status` / `error_code` / `attempted_channels` 等字段; 同时新增最小可用的 SSR 看板, 把今日 QPS / 花费 / Top Key / Channel 健康 / 错误率 Top 模型摊到一个 HTML 页面.

## 目录结构

```
src/
  index.ts                          # ★ 主路径全面替换 console.log / 自由 pino 为 ctx.logger
  log/                              # ★ 本章新增
    logger.ts                       # 全 repo 共享的 pino 根实例 + 字段字典
    middleware.ts                   # trace_id 生成 + child logger 注入 ctx
  dashboard/                        # ★ 本章新增
    queries.ts                      # 看板聚合 SQL (今日 QPS / 花费 / Top Key / Channel 健康 / 错误率)
    render.ts                       # 纯字符串 SSR HTML, 含 30s meta refresh + XSS 防御
    routes.ts                       # GET /admin/dashboard (HTML) + /admin/dashboard/data (JSON)
  billing/
    calculator.ts                   # ★ 新增 recordObservability(): 把 channel_id / upstream_latency_ms 写回 usage_records
  channels/
    health-checker.ts               # ★ 改用 createChildLogger, 不再 import pino
  scripts/
    mock-upstream.ts                # ★ 改用 createChildLogger
  (其余沿用 v0.8)
drizzle/
  0001_init.sql                     # 沿用
  0002_billing.sql                  # 沿用
  0003_quota.sql                    # 沿用
  0004_channels.sql                 # 沿用
  0005_observability.sql            # ★ 本章新增: usage_records 加 channel_id / upstream_latency_ms / attempted_channels
```

## 依赖

- Node.js 20+
- npm

## 启动 + 迁移

```bash
cd examples/09-where-did-this-request-go
cp .env.example .env  # 至少改 ADMIN_TOKEN

npm install
npm run migrate    # 0001/0002/0003/0004/0005, 共 5 份
npm run start      # 监听 :3000

# 另开 terminal 起 mock 上游
npm run mock       # 监听 :4010
```

启动日志改为 JSON 一行 (`LOG_PRETTY=false`) 或彩色 (`LOG_PRETTY=true`, 默认开发模式开启). 一行示例:

```
{"level":"info","service":"gateway","env":"development","pid":12345,"time":"2026-05-15T10:00:00.123Z","applied":["0005_observability.sql"],"msg":"db_migrations_applied"}
```

## 准备一把 Key (与 v0.8 一致)

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -sS -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -sS -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
GW_KEY=$(curl -sS -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"observability-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
echo $GW_KEY
```

## 跑几次请求, 看结构化日志

```bash
for i in 1 2 3 4 5; do
  curl -sS -X POST $BASE/v1/chat/completions \
    -H "Authorization: Bearer $GW_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":16}' \
    -w "\n#$i HTTP %{http_code}\n" -o /dev/null
done
```

每次请求会在 stdout 输出一组带同一 `trace_id` 的日志, 至少 3 条: `billing_pre_consumed` -> `billing_settled`/`stream_settled` 之一 -> `request_completed`. 故障转移命中时还有 `non_stream_upstream_failed` 或 `stream_upstream_failed_pre_byte`.

## 按 trace_id 反查全链路

stdout 直接 grep 就行 (生产环境接 Loki / ELK 后, 按 `trace_id` 字段过滤):

```bash
# 假设上面某次请求 X-Request-Id 响应头给的 trace_id 是 abc...
TRACE_ID=abc-...
npm run start 2>&1 | grep $TRACE_ID
```

更标准的做法是用 DB 直接看那一笔账单:

```bash
sqlite3 ./data/gateway.db <<SQL
.headers on
.mode column
SELECT id, trace_id, user_id, key_id, channel_id, model, provider,
       prompt_tokens, completion_tokens, final_cost,
       upstream_latency_ms, attempted_channels, status
  FROM usage_records
 WHERE trace_id = '$TRACE_ID';
SQL
```

或者走 admin/usage 接口:

```bash
curl -sS "$BASE/admin/usage?traceId=$TRACE_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool
```

如果想用一笔请求的 X-Request-Id 复用作 trace_id, 客户端发请求时带 `-H "X-Request-Id: my-trace-123"` 即可, 网关识别该头复用而不生成新的.

## 浏览器打开看板

```
http://localhost:3000/admin/dashboard?token=test-admin-token-12345
```

看板 5 大 section + 全局摘要卡片:

- 全局摘要: 今日总请求数 / 今日花费 / 平均上游延迟 + 近 7 天累计花费
- 今日 QPS (按分钟): ASCII sparkline, 一眼看出峰值时间分布
- 今日花费 · 按用户: Top 20 用户的请求数 / 花费 / token
- 今日花费 · 按模型: Top 20 模型的请求数 / 花费 / token
- Top 10 Key 用量: 今日花费 Top 10 的 Key + 异常笔数
- Channel 健康状态: 全部 channel 的 status / 禁用原因 / 今日请求 / 错误率 / 平均上游延迟
- 错误率 Top 5 模型: 今日 ≥ 5 笔且错误率最高的 5 个模型

页面有 `<meta http-equiv="refresh" content="30">`, 浏览器每 30s 自动刷新.

JSON 版本 (给监控告警 / 自动化用):

```bash
curl -sS "$BASE/admin/dashboard/data?token=$ADMIN_TOKEN" | python3 -m json.tool
```

## 一键端到端验证脚本

`failover-test.ts` 沿用 v0.8 的脚本, 跑完之后看板的「Channel 健康」表里 mock-bad-key 会显示 disabled + 错误率, 同时 stdout 日志里有完整的 trace_id 链路.

```bash
GW_KEY=$GW_KEY BASE_URL=$BASE ADMIN_TOKEN=$ADMIN_TOKEN \
  npx tsx src/scripts/failover-test.ts
```

## 相对 v0.8 的核心变化

| 维度 | v0.8 | v0.9 |
|------|------|------|
| 日志输出 | 每个文件 `pino({transport:{target:'pino-pretty'}})` 自己 new 一个 | 全 repo 共享 `src/log/logger.ts` 单例 + JSON / pretty 双模式 |
| trace_id 来源 | 主路径 `randomBytes(16).toString('hex')` 32 字符自定义格式 | Hono middleware 用 `crypto.randomUUID()`; 客户端 `X-Request-Id` 头可复用; 响应回写 |
| 日志字段一致性 | `trace_id` / `channel_id` 各处自由命名 | 字段从 `LogFields` 字典取, 跨文件不再漂移 |
| usage_records 字段 | 14 列 (含 trace_id 但无 channel_id / upstream_latency_ms) | 17 列, 新增 channel_id / upstream_latency_ms / attempted_channels |
| 看板 | 无 | `/admin/dashboard` SSR HTML (30s 自动刷新) + `/admin/dashboard/data` JSON |
| 按 trace_id 反查 | grep stdout, 跨日志切割就断线 | DB 表 + 看板按 channel_id / model 直接聚合, 历史可审计 |
| admin 鉴权 | 仅 Bearer 头 | 业务接口仍 Bearer; 看板加 query string token (浏览器友好) |

## 仍然故意保留的缺陷 (留给后续章节)

- 看板数据源是 SQLite + usage_records, 单表百万行内仍然几十毫秒级聚合; 真要支撑百万级 QPS, 应当把日志接进 ClickHouse / Loki (Helicone 的实践), 本书 SQLite 路线只覆盖到「教学 + 中小规模上线」
- 看板鉴权是 query string token, 生产环境应改成 cookie + 后台登录 (Ch12 上线整合时处理)
- 灰度对比 (gpt-4o-mini 同 prompt 在不同 channel 的实际单价) 还没有, v0.10 接成本优化时补
- 钱包 / 支付链路仍然不存在, 余额是 admin 手动充 (v0.11)

## 与 one-api / Helicone / Portkey 的对照

| 概念 | one-api 实现 | Helicone 实现 | 本章实现 |
|------|--------------|---------------|---------|
| Log 表 | `model/log.go::Log` (PromptTokens / CompletionTokens / ChannelId / RequestId / ElapsedTime) | ClickHouse `request_response_versioned` 表 (列式压缩 + 倒排索引) | `usage_records` 表 + v0.9 加 channel_id / upstream_latency_ms / attempted_channels |
| 请求 ID 生成 | `helper.GetRequestID(ctx)` (自定义格式) | Cloudflare Workers 自动 `cf-ray` | Hono middleware `randomUUID()` + 客户端 `X-Request-Id` 头可复用 |
| 看板 | React 前端 + Go API | 独立 Next.js dashboard | 纯字符串 SSR HTML (无前端依赖) |
| 日志库 | `common/logger` (自封装 zap-like) | Pino + ClickHouse exporter | Pino (官方推荐 transport 模式) |
