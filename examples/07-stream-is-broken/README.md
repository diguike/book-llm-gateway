# 第 7 章 v0.7 配套代码

v0.6 完成了非流式场景下的「钱算清 + 频率限住 + 配额封顶」。v0.7 把 `stream=true` 这条断头的链路补完: SSE 透传主循环, 客户端断开的反向取消, 流式 token 边收边算, 流式终态的三态计费 (finalized / canceled / partial).

## 目录结构

```
src/
  index.ts                          # ★ 主路径增加 stream 分支 -> proxySSE
  streaming/                        # ★ 本章核心
    sse-proxy.ts                    # SSE 透传主循环 + 反向取消 + 心跳
    event-normalizer.ts             # OpenAI / Anthropic chunk 统一接口
    counter.ts                      # re-export Ch5 的 StreamingTokenCounter
    anthropic-events.ts             # 沿用 Ch3 的归一化器
  adaptors/
    base.ts                         # ★ 接口加 buildStreamRequest / newStreamState / parseStreamChunk
    openai.ts                       # ★ 新增流式方法 (stream_options.include_usage 自动注入)
    anthropic.ts                    # ★ 新增流式方法 (Anthropic 事件归一化)
    deepseek.ts                     # 继承自 openai, 无需改
  billing/
    calculator.ts                   # ★ 新增 postConsumeStream (finalized / canceled / partial 三态)
    streaming-counter.ts            # 与 v0.6 一致
    (其余沿用 v0.6)
  scripts/
    mock-upstream.ts                # ★ 本章新增: 最小 OpenAI 兼容 SSE 上游, 用于演示
    stream-test.ts                  # ★ 本章新增: 流式客户端 + 反向取消验证
    attack.ts                       # v0.6 沿用
  limit/                            # 与 v0.6 一致
  auth/                             # 与 v0.6 一致
  admin/                            # 与 v0.6 一致
  db/                               # 与 v0.6 一致 (schema 不变, status 字段值新增 'canceled' / 'partial')
client/
  index.html                        # ★ 10 行打字机 demo
nginx.conf.example                  # ★ 反代关键配置 (proxy_buffering off / X-Accel-Buffering)
drizzle/                            # 与 v0.6 一致
```

## 依赖

- Node.js 20+
- npm

## 启动 + 迁移

```bash
cd examples/07-stream-is-broken
cp .env.example .env
# 改 ADMIN_TOKEN (默认 test-admin-token-12345)

npm install
npm run migrate    # 0001/0002/0003 与 v0.6 一致, 不新增 migration
npm run start      # 监听 :3000
```

## 准备一把 Key

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -sS -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -sS -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
GW_KEY=$(curl -sS -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"streamer"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
echo $GW_KEY
```

## 启动 mock 上游 (新开一个 terminal)

mock-upstream 实现一个最小的 OpenAI 兼容 SSE 端点, 每 250ms 吐一个 chunk, 跑 10 个 chunk 后送 `[DONE]`. 它也演示了「客户端关连接时上游能感知」(打 `mock_aborted_by_client` 日志).

```bash
npm run mock        # 监听 :4010
```

## curl 一把看打字机

```bash
curl -N -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

预期输出 (一段一段, 不是一次性大块吐出):

```
data: {"id":"chatcmpl-mock-...","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"...","choices":[{"index":0,"delta":{"content":", world"},"finish_reason":null}]}

...

data: {"id":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"...","usage":{"prompt_tokens":2,"completion_tokens":17,"total_tokens":19}}

data: [DONE]
```

## 看反向取消 (Ctrl+C 验证)

`stream-test.ts` 模拟「收到 N 个 chunk 后按 Ctrl+C」, 验证反向取消是否到上游:

```bash
npx tsx src/scripts/stream-test.ts \
  --base $BASE --key $GW_KEY --model mock-gpt-4o-mini \
  --prompt "tell me something" \
  --abort-after-chunks 3
```

预期客户端输出:

```
[stream-test] http status=200 content-type=text/event-stream; charset=UTF-8
[stream-test] first delta at +303ms
Hello, world! This
[stream-test] aborting after 3 chunks (simulated Ctrl+C)
```

mock 上游日志 (`/tmp/mock.log`):

```
WARN: mock_aborted_by_client id=chatcmpl-mock-...
WARN: mock_stop_early_due_to_abort id=... chunks_sent=2
```

`mock_aborted_by_client` 证明反向取消信号 (网关 abort 上游 fetch) 确实传到了 mock 进程的 `res.on('close')`.

网关日志 (`/tmp/gw.log`):

```
INFO billing_pre_consumed       is_stream=true ...
INFO stream_settled              terminal_status=canceled prompt_tokens=8 completion_tokens=3 final_cost_micro_cny=20 ...
```

usage_records 表里这次请求的状态:

```bash
sqlite3 data/gateway.db \
  "SELECT id, status, prompt_tokens, completion_tokens, final_cost, pre_reserved_cost FROM usage_records WHERE is_stream=1 ORDER BY id DESC LIMIT 3;"
```

输出 (示例):

```
13|canceled|8|3|20|1032
12|finalized|3|17|71|1033
11|refunded|0|0|0|147
```

- `canceled` 行: 已发出的 3 个 token 计费入账 (20 µCNY), 多扣的 1012 µCNY 退回余额;
- `finalized` 行: 完整跑完, 17 个 completion token 实结 71 µCNY;
- `refunded` 行: 上游 fetch 阶段就失败 (例如 OPENAI_API_KEY 没配真值导致网络层错), 全额退回, status=refunded.

## 10 行 HTML 打字机 demo

打开 `client/index.html` (用 `python3 -m http.server 8081` 或随便起个静态服务器):

```bash
cd client && python3 -m http.server 8081
# 浏览器打开 http://localhost:8081/
```

填入 `sk-gw-...` Key, 点「发送」, 看打字机输出. 点「Ctrl+C / 取消」按钮触发 AbortController, 看 mock_aborted 日志.

## Nginx 反代

`nginx.conf.example` 给出关键三行:

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 90s;
```

没加 `proxy_buffering off` 的话, Nginx 会把上游每个 chunk 攒到一定大小才一次性 flush, 客户端看到的就是「卡 30 秒一次性吐」. 我们的网关也在响应头里加了兜底 `X-Accel-Buffering: no`, 缺哪条都可工作, 但建议两条都开.

## 相对 v0.6 的核心变化

| 维度 | v0.6 | v0.7 |
|------|------|------|
| `stream=true` | 直接返 400 | 走 sse-proxy 主循环, 边收边发 |
| 上游响应 | `await response.text()` 一次性读完 | `ReadableStream` + `TextDecoder` 增量读 |
| 反向取消 | 不支持 | 客户端关连接 -> downstream readable.cancel -> upstreamCtrl.abort -> 上游 fetch 立刻断 |
| 流式 token 计数 | 不存在 | `StreamingTokenCounter` 在 SSE 主循环里边收边累加; 上游送 usage 时校准 |
| 终态 | `finalized` / `refunded` / `failed` | 多 `canceled` (客户端断) / `partial` (上游中途断) 两态 |
| 心跳 | 不需要 | 每 15s 写 `: keepalive\n\n`, 防 Nginx 60s 超时切断 |
| 反代缓冲 | 不涉及 | 响应头加 `X-Accel-Buffering: no` |

## 仍然故意保留的缺陷 (留给后续章节)

- 单一上游 Key. 上游返 401 / 5xx 抖动 -> 所有流式连接被中断, 无自动恢复. Ch8 Channel + 故障转移会解决.
- 结构化日志 / 看板. 流式请求按 trace_id 反查、按 channel_id 归因. Ch9 接入 pino structured 日志 + SSR 看板.
