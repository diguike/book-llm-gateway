# 第 6 章 v0.6 配套代码

v0.5 把计费链路打通, 但只回答了「钱花到哪里」, 没回答「谁在短时间内打爆我」。v0.6 给网关补上分层限流 + 月度配额: 按 Key / 按 Model / 按全局三层做 QPS (滑动窗口) + TPM (预扣 + 实结) 双维度限流, 同时给 keys 表加 `monthly_quota` 字段, 让单 Key 的当月累计花费可控.

## 目录结构

```
src/
  index.ts                          # ★ 主路径接入 rateLimit middleware + 月度配额检查
  db/
    schema.ts                       # ★ keys 表加 5 列限流 / 月度配额字段
    migrate.ts                      # 与 v0.5 一致
    client.ts                       # 与 v0.5 一致
  limit/                            # ★ 本章新增
    types.ts                        # RateLimiter 接口
    sliding-window.ts               # QPS 滑动窗口 (内存)
    tpm-reservation.ts              # TPM 预扣 60s 滚动桶 (内存)
    memory-limiter.ts               # 组合 + 单例
    middleware.ts                   # Hono middleware (auth 之后, preConsume 之前)
  billing/
    quota.ts                        # ★ 月度配额: checkMonthlyQuota + commitMonthlyUsage
    calculator.ts                   # 与 v0.5 一致
    prices.ts                       # 与 v0.5 一致
    tokenizer.ts                    # 与 v0.5 一致
    streaming-counter.ts            # 与 v0.5 一致 (Ch7 接入)
    record.ts                       # 与 v0.5 一致
  multiplier/registry.ts            # 与 v0.5 一致
  auth/                             # 与 v0.5 一致
  admin/
    routes.ts                       # ★ 新增 /admin/keys/:id/limits + /admin/keys/:id/usage-window
  cli/issue-key.ts                  # 与 v0.5 一致
  adaptors/                         # 与 v0.5 一致
  scripts/
    attack.ts                       # ★ 本章新增: 并发压测脚本
  streaming/                        # 与 v0.5 一致
  types/                            # 与 v0.5 一致
  router.ts                         # 与 v0.5 一致
drizzle/
  0001_init.sql                     # 与 v0.5 一致
  0002_billing.sql                  # 与 v0.5 一致
  0003_quota.sql                    # ★ 本章新增
```

## 依赖

- Node.js 20+
- npm
- 编译 better-sqlite3 需要 C++ 工具链
- 本章新增 devDep: autocannon (可选, 用于额外压测; attack.ts 不依赖它, 走 native fetch)

## 启动

```bash
cp .env.example .env
# 改 ADMIN_TOKEN; 上游 Key 可填可不填 (本章主要看限流, 上游网络错也能验)

npm install
npm run dev
```

启动日志:

```
INFO db_migrations_applied applied=["0001_init.sql","0002_billing.sql","0003_quota.sql"]
INFO default_prices_seeded inserted=10
INFO Gateway v0.6 listening on http://localhost:3000
```

## 配一个被限流的 Key

把限流和月度配额一次配齐:

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

# 建 org / user
curl -s -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -s -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'

# 签 Key, 一并设置: 2 QPS / 1000 TPM / 0.01 元/月配额
GW_KEY=$(curl -s -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId":1,
    "name":"throttled",
    "qpsLimit":2,
    "tpmLimit":1000,
    "monthlyQuotaCny":0.01
  }' | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
echo "GW_KEY=$GW_KEY"
```

确认配置生效:

```bash
curl -s "$BASE/admin/keys/1/usage-window" -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool
```

输出 (注意 monthly.limitCny 是 0.01 元):

```json
{
  "keyId": 1,
  "qps":     { "limit": 2,    "current": 0 },
  "tpm":     { "limit": 1000, "currentTokens": 0 },
  "monthly": { "limitMicroCny": 10000, "usedMicroCny": 0, "limitCny": 0.01, "usedCny": 0 }
}
```

## 验证 1: QPS 限流

5 并发跑 20 次, 配置是 2 QPS, 预期前 2 个 ok (会因为没真实上游 Key 进入网络错 502, 但限流通过了), 其余被限流返 429:

```bash
GW_KEY=$GW_KEY node --import tsx src/scripts/attack.ts \
  --base http://localhost:3000 \
  --model gpt-4o-mini \
  --total 20 \
  --concurrency 5
```

预期输出 (示例; 具体数字取决于网络延迟):

```json
{
  "total": 20,
  "concurrency": 5,
  "by_status": {
    "429": 18,
    "502": 2
  },
  "first_429_at_index": 2,
  "first_429_retry_after": "1"
}
```

- `by_status["429"]` 大头, 限流生效;
- `first_429_at_index: 2` 第 3 个请求 (0-based) 开始被拦, 说明前两个吃掉了 1 秒的 QPS=2 名额;
- `Retry-After: 1` 头部, 客户端最少等 1 秒重试.

调小压力再跑一次, 看 200 / 502 (网络错) 出现:

```bash
GW_KEY=$GW_KEY node --import tsx src/scripts/attack.ts \
  --total 2 --concurrency 1
```

```json
{ "total": 2, "by_status": { "502": 2 }, "first_429_at_index": null }
```

两个请求都通过限流 (没 429), 但上游 Key 未配置, 网络错 502. 这是预期: 限流只做流量整形, 不替换计费 / 上游调用.

## 验证 2: TPM 限流

把 QPS 放宽到不限, 把 TPM 收紧到「一次请求能预扣的额度」之下:

```bash
# 调整 Key 配置: qps=0 (不限), tpm=100
curl -s -X POST $BASE/admin/keys/1/limits -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"qpsLimit":0,"tpmLimit":100}'

# 同样调用: max_tokens=64, prompt 短, TPM 预扣 ≈ (估算 prompt + 64), 单次就超 100
GW_KEY=$GW_KEY node --import tsx src/scripts/attack.ts --total 5 --concurrency 1
```

预期: 第一次请求就 429, 原因是 TPM 预扣 ≈ 70 + 64 = 134 > 100:

```json
{
  "total": 5,
  "by_status": { "429": 5 },
  "first_429_at_index": 0,
  "first_429_body": {
    "error": {
      "type": "rate_limit_exceeded",
      "kind": "tpm",
      "dimension": "key",
      "limit": 100,
      "current": 0,
      "retry_after_ms": 60000
    }
  }
}
```

## 验证 3: 月度配额

把 QPS / TPM 都放开, 月度配额设到「一次预扣就超」:

```bash
curl -s -X POST $BASE/admin/keys/1/limits -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"qpsLimit":0,"tpmLimit":0,"monthlyQuotaCny":0.00001}'

curl -i -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

预期 402 (配合 Ch5 的 402, 配额耗尽与余额不够同一状态码):

```
HTTP/1.1 402 Payment Required
{"error":{"type":"monthly_quota_exceeded","message":"monthly quota for this key has been exhausted","used_micro_cny":0,"limit_micro_cny":10,"reserving_micro_cny":17713}}
```

注意 `reserving_micro_cny` 是「这次请求预扣的金额」, `limit_micro_cny` 是配额上限, `used_micro_cny` 是当月已用 (此例为 0 因为还没成功过). reserved + used > limit 就拒.

## 查窗口实时状态

```bash
curl -s "$BASE/admin/keys/1/usage-window" -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool
```

短时间内连续调几次接口后再查, 能看到:

```json
{
  "keyId": 1,
  "qps":     { "limit": 2,    "current": 2     },  // 1 秒内已用 2 个名额
  "tpm":     { "limit": 1000, "currentTokens": 612 },  // 当前分钟桶内累计 token
  "monthly": { "limitMicroCny": 10000, "usedMicroCny": 0, "limitCny": 0.01, "usedCny": 0 }
}
```

`tpm.currentTokens` 在 commit 阶段会用真实 usage 替换预扣值 (多退少补). `monthly.usedCny` 只在 postConsume 真正完成后累加, 上游失败 / 网络错时不累加.

## 相对 v0.5 的核心变化

| 变化 | 文件 | 说明 |
|------|------|------|
| Schema 增列 | `src/db/schema.ts` + `drizzle/0003_quota.sql` | keys 加 qps_limit / tpm_limit / monthly_quota_micro / monthly_used_micro / quota_reset_at |
| RateLimiter 接口 | `src/limit/types.ts` | checkQps / reserveTpm / commitTpm / releaseTpm; 留 Redis adapter 替换点 |
| QPS 滑动窗口 | `src/limit/sliding-window.ts` | 每 key 一个时间戳双端队列; O(1) check + 60s GC |
| TPM 预扣 | `src/limit/tpm-reservation.ts` | 60s 滚动桶; reserve + commit (多退少补) + release |
| 内存实现 | `src/limit/memory-limiter.ts` | 组合 sliding-window + tpm; 进程内单例 |
| Hono 中间件 | `src/limit/middleware.ts` | 三维限流 (key/model/global) + TPM 预扣注入 ctx |
| 月度配额 | `src/billing/quota.ts` | checkMonthlyQuota 单 SQL CASE WHEN 跨月归零; commitMonthlyUsage 累加 |
| 主路径接入 | `src/index.ts` | 在 preConsume 前插入 rateLimit, 在 postConsume 后 commitTpm + commitMonthlyUsage |
| Admin 接口扩展 | `src/admin/routes.ts` | /admin/keys/:id/limits (设置) + /admin/keys/:id/usage-window (查) |
| 压测脚本 | `src/scripts/attack.ts` | 滑动并发池 + 按 status 聚合 + 首个 429 索引 |

## 暂不支持的能力

| 缺陷 | 解决章节 |
|------|---------|
| 流式仍未做, stream=true 直接 400 | 第 7 章 |
| 限流的 TPM 维度在流式响应上需要 streaming-counter 接入 | 第 7 章 |
| Redis adapter 实现 (本章只定义了接口) | 第 12 章基建整合时按需替换 |
| 渠道池, 故障转移 (channel_multiplier 暂硬编码 1.0x) | 第 8 章 |
| 结构化日志, 看板 (按 trace_id 反查的看板视图) | 第 9 章 |
