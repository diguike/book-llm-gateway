# 第 5 章 v0.5 配套代码

v0.4 把内部 Key 体系打通, 但只回答了「请求是否被允许」, 没回答「请求消耗了什么」。v0.5 把 token 计数、价格表、倍率体系、两阶段计费、UsageRecord 落账全链路搭起来, 让网关从「能拦」走到「能算」。

## 目录结构

```
src/
  index.ts                          # Hono 入口, 主路径接入两阶段计费
  db/
    client.ts                       # 与 v0.4 一致
    schema.ts                       # ★ users 加 balance + multiplier; 新增 prices / usage_records 两表
    migrate.ts                      # 与 v0.4 一致 (按文件名顺序应用)
  billing/                          # ★ 本章新增
    prices.ts                       # 价格表查询 / 缓存 / 默认价格灌库
    tokenizer.ts                    # js-tiktoken 本地估算
    calculator.ts                   # preConsume + postConsume + refund 三段式核心
    streaming-counter.ts            # 流式 token 计数器 (Ch7 接入)
    record.ts                       # UsageRecord 查询辅助
  multiplier/                       # ★ 本章新增
    registry.ts                     # user × channel × model 三合一倍率
  auth/                             # 与 v0.4 一致
  admin/
    routes.ts                       # ★ 扩展: 调余额 / 改倍率 / 列价格 / 改价 / 查账单
  cli/
    issue-key.ts                    # ★ 改动: 创建 user 时给初始余额
  adaptors/                         # 与 v0.4 一致 (gpt-* / deepseek-* / claude-*)
  streaming/                        # 与 v0.4 一致
  types/                            # 与 v0.4 一致
  router.ts                         # 与 v0.4 一致
drizzle/
  0001_init.sql                     # 与 v0.4 一致
  0002_billing.sql                  # ★ 本章新增
data/
  gateway.db                        # 启动后自动生成
```

## 依赖

- Node.js 20+
- npm
- 编译 better-sqlite3 需要本地有 C++ 工具链 (macOS 自带; Linux 装 build-essential)
- 本章新增依赖: js-tiktoken (纯 JS, 无 native binding, 安装快)

## 启动步骤

```bash
cp .env.example .env
# 至少改两件事:
#   ADMIN_TOKEN=admin-change-me   ->  改成你自己的强随机串
#   上游 Key (任选一家填上即可冒烟)

npm install                    # 编译 better-sqlite3 + 装 js-tiktoken
npm run migrate                # 显式跑 migration (可选, dev/start 也会自动跑)
npm run dev                    # 启动网关, 自动跑 migration + 灌入默认价格
```

启动日志:

```
INFO db_migrations_applied applied=["0001_init.sql","0002_billing.sql"]
INFO default_prices_seeded inserted=10
INFO Gateway v0.5 listening on http://localhost:3000
```

## 一次完整请求 → 账单的端到端演练

```bash
ADMIN_TOKEN=admin-change-me
BASE=http://localhost:3000

# 1. 建 org / user (user 默认拿到 INITIAL_BALANCE_CNY = 100 元)
curl -s -X POST $BASE/admin/orgs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Inc"}'
# {"id":1,"name":"Acme Inc","disabledAt":null,"createdAt":...}

curl -s -X POST $BASE/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"orgId":1,"name":"alice","balanceCny":100}'
# {"id":1,"orgId":1,"name":"alice","balanceMicro":100000000,"userMultiplier":1000,...}

# 2. 签发 Key
curl -s -X POST $BASE/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"name":"smoke"}'
# {"id":1,"plaintext":"sk-gw-...","preview":"sk-gw-...XXX","warning":"..."}

GW_KEY=sk-gw-replace-with-plaintext-above

# 3. 用 Key 调网关. 上游 sk-replace-me 没真实 Key, 网络层会拒, 但 preConsume
#    应该已经在 usage_records 写下一行 status=reserved, 等网络错触发 refund
#    把它改成 status=refunded.
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-4o-mini",
    "messages":[{"role":"user","content":"hello world, this is a test message for billing"}]
  }'
# 上游 sk-replace-me 不存在 -> {"error":{"message":"upstream network error"}}

# 4. 看账单
curl -s "$BASE/admin/usage?userId=1" -H "Authorization: Bearer $ADMIN_TOKEN"
```

预期看到的账单 (上游网络失败 → refunded, 余额未扣):

```json
{
  "data": [
    {
      "id": 1,
      "traceId": "dfa123480dcd949104eb0e6c18f74672",
      "userId": 1, "orgId": 1, "keyId": 1,
      "model": "gpt-4o-mini", "provider": "openai",
      "promptTokens": 0, "completionTokens": 0,
      "estimatedPromptTokens": 17,
      "preReservedCost": 17713,
      "finalCost": 0,
      "status": "refunded",
      "errorMessage": "network_error: fetch failed",
      ...
    }
  ]
}
```

预期看到的关键字段:
- `estimatedPromptTokens` 是 tiktoken 本地估算的 input token 数;
- `preReservedCost` 是 preConsume 阶段扣下的金额 (微元);
- `status: refunded` 表示上游失败, 预扣已退回;
- 如果上游真实 Key 填了, 这条记录会变成 `status: finalized` + `promptTokens / completionTokens` 来自上游 usage + `finalCost` 是实结金额。

## 余额不足时的预期响应

```bash
# 把余额设到不足以付一次请求
curl -s -X POST $BASE/admin/users/1/balance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"setCny":0.001}'

curl -i -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

```
HTTP/1.1 402 Payment Required
{"error":{"type":"insufficient_quota","message":"balance is not enough to cover the reservation","required_micro_cny":17704,"available_micro_cny":1000}}
```

402 是 preConsume 在乐观锁 UPDATE 失败时返回的——余额不够, 不进上游, 不写 record。

## 三种聚合查询 SQL

下面这些 SQL 直接在 `data/gateway.db` 上跑即可 (用 `sqlite3` 或者写一个小脚本)。

```sql
-- 1) 按用户 (今天)
SELECT
  user_id,
  COUNT(*)                                 AS request_count,
  SUM(prompt_tokens)                       AS prompt_tokens,
  SUM(completion_tokens)                   AS completion_tokens,
  SUM(final_cost) / 1000000.0              AS final_cost_cny
FROM usage_records
WHERE status = 'finalized'
  AND created_at >= strftime('%s','now','start of day') * 1000
GROUP BY user_id
ORDER BY final_cost_cny DESC;

-- 2) 按模型 (本月)
SELECT
  model,
  provider,
  COUNT(*)                                 AS request_count,
  SUM(prompt_tokens)                       AS prompt_tokens,
  SUM(completion_tokens)                   AS completion_tokens,
  SUM(prompt_cost) / 1000000.0             AS prompt_cost_cny,
  SUM(completion_cost) / 1000000.0         AS completion_cost_cny,
  SUM(final_cost) / 1000000.0              AS total_cny
FROM usage_records
WHERE status = 'finalized'
  AND created_at >= strftime('%s','now','start of month') * 1000
GROUP BY model, provider
ORDER BY total_cny DESC;

-- 3) 按天 (最近 30 天)
SELECT
  strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch')) AS day,
  COUNT(*)                                 AS request_count,
  SUM(final_cost) / 1000000.0              AS daily_cost_cny
FROM usage_records
WHERE status = 'finalized'
  AND created_at >= (strftime('%s','now') - 30 * 86400) * 1000
GROUP BY day
ORDER BY day DESC;
```

## 流式情况下账单何时落表

本章 v0.5 暂不开放 stream=true (返 400), 但流式计费链路的核心 API 已经在 `src/billing/streaming-counter.ts` 里就位:

```ts
const counter = new StreamingTokenCounter(model, fallbackPromptTokens);
// SSE 主循环里, 收到 delta 文本片段时:
counter.ingestDelta(textChunk);
// 上游送了 usage 事件 (OpenAI: stream_options.include_usage; Anthropic: message_delta.usage):
counter.ingestUsage({ prompt_tokens: 12, completion_tokens: 34 });
// 客户端中途 Ctrl+C:
counter.markAborted();
// 流结束 (正常 [DONE] 或中断都触发) 后:
const { promptTokens, completionTokens, abortedByClient } = counter.finalize();
postConsume({ recordId, userId, model, provider,
              realPromptTokens: promptTokens,
              realCompletionTokens: completionTokens });
```

Ch7 SSE 透传章会把这套 API 与 `fetch` 的 `ReadableStream` + `AbortController` 接起来。一个关键约束: 客户端中途断开时, **主循环必须在 catch 块里调一次 `finalize() + postConsume()`**, 否则 reserved 行永远停在 reserved 状态, 余额一直被压住。

## 相对 v0.4 的核心变化

| 变化 | 文件 | 说明 |
|------|------|------|
| Schema 增列 / 新表 | `src/db/schema.ts` + `drizzle/0002_billing.sql` | users 加 balance_micro / user_multiplier; 新增 prices / usage_records 两表 |
| 价格表 | `src/billing/prices.ts` | model × provider × 时间窗; TTL 60s 进程内缓存; 启动灌默认价 |
| 本地 token 估算 | `src/billing/tokenizer.ts` | js-tiktoken (纯 JS, 无 native binding); cl100k / o200k 自动选 |
| 倍率体系 | `src/multiplier/registry.ts` | user × channel × model 三维, 千分位 integer, 三合一快照入账 |
| 两阶段计费 | `src/billing/calculator.ts` | preConsume (乐观锁扣余额 + 写 reserved) → postConsume (实结 + 多退少补) / refundReservation (全额退回) |
| 流式计数器 API | `src/billing/streaming-counter.ts` | API 就位, Ch7 接入 SSE 主循环 |
| 主路径接入 | `src/index.ts` | `/v1/chat/completions` 套上 preConsume → 调上游 → postConsume / refund |
| Admin 接口扩展 | `src/admin/routes.ts` | `/admin/users/:id/balance` / `/admin/users/:id/multiplier` / `/admin/prices` / `/admin/usage` |
| CLI 给初始余额 | `src/cli/issue-key.ts` | 创建 user 时按 INITIAL_BALANCE_CNY 充值, 避免首次调网关立刻 402 |

## 暂不支持的能力

| 缺陷 | 解决章节 |
|------|---------|
| 不限流, 单把 Key 可以打爆上游配额 | 第 6 章 |
| 流式仍未做, stream=true 直接 400 | 第 7 章 |
| 渠道池, 故障转移 (channel_multiplier 暂硬编码 1.0x) | 第 8 章 |
| 结构化日志, 看板 (按 trace_id 反查的看板视图) | 第 9 章 |
| 表达式计费 (cache / image / audio 独立定价) | 第 10 章 |
