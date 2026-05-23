# 第 10 章 v0.10 配套代码

v0.9 之后, 看板能算清每一笔账, 但同样的 `gpt-4o-mini` 请求, 自建网关的实际成本明显高于市面对外销售的中转站价格. 第 10 章拆透这件事的合法降本机制, 并把五件可量化的代码落进主项目, 同时提供 3 个独立子工具供单独研究.

## 目录结构

```
src/
  optimization/                       # ★ 本章核心新增
    prompt-cache.ts                   # Anthropic/OpenAI/DeepSeek 缓存命中字段抽取 + cache_control 检测
    cost-router.ts                    # 按 cost_priority asc 选最便宜可用 channel + fallback
    batch-channel.ts                  # priority=low 异步队列, 走 supports_batch=true 的 channel
    index.ts                          # barrel
  billing/
    calculator.ts                     # ★ 加 cached_input_tokens / batch_mode, 拆分 computeFinalCost
    prices.ts                         # ★ ResolvedPrice 加 cache_input/batch_input/batch_output 三个单价
  channels/
    seed.ts                           # ★ 5 个 mock channel, 不同 cost_priority (10/20/50/80/100)
    registry.ts                       # ★ ChannelEntry 加 costPriority / supportsBatch
    store.ts                          # ★ CreateChannelInput 加 cost_priority / supports_batch
  index.ts                            # ★ 主路径选 channel 改用 pickCheapestChannel; 抽 cached_tokens
  scripts/
    mock-upstream.ts                  # ★ 模拟 OpenAI cached_tokens 返回 ([CACHED] 前缀触发 80% 命中)
  (其余沿用 v0.9)
drizzle/
  0006_cost_optimization.sql          # ★ channels 加 cost_priority/supports_batch;
                                      #   prices 加 cache/batch 三列单价;
                                      #   usage_records 加 cached_input_tokens/cache_write_tokens/batch_mode
tools/                                # ★ 三个独立子工具 (单独 npm install + npm start)
  cost-router-demo/                   #   按 cost_priority 选 channel + fallback 决策日志
  prompt-cache-demo/                  #   Anthropic/OpenAI 缓存命中成本对比
  model-fingerprint-cli/              #   模型指纹检测 CLI (5 探针: self_id / cutoff / tokenizer / refusal / math)
```

## 依赖

- Node.js 20+
- npm

## 启动 + 迁移

```bash
cd examples/10-why-is-relay-cheaper
cp .env.example .env   # 至少改 ADMIN_TOKEN

npm install
npm run migrate        # 0001/0002/0003/0004/0005/0006, 共 6 份
npm run mock           # terminal 1: 监听 :4010
npm run start          # terminal 2: 监听 :3000
```

启动日志会打印 5 个默认 mock channel 已 seed (cost_priority 10/20/50/80/100).

## 准备一把 Key

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -sS -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -sS -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
GW_KEY=$(curl -sS -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"ch10-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
echo $GW_KEY
```

## 跑成本路由 (主路径)

```bash
# 同步请求, 默认会走 cost_priority=10 (mock-cheap-batch) 的最便宜 channel
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"stream":false}'
```

stdout 会有 `first_channel_cost_priority: 10`, 命中 `mock-cheap-batch`.

## 跑缓存命中对比

`[CACHED]` 前缀让 mock 上游返回 `cached_tokens = 80% prompt_tokens`. 主路径按 cache 单价 (0.1x) 单独计费这部分.

```bash
# 第 1 次冷调
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hello world how are you"}],"max_tokens":8,"stream":false}'

# 第 2 次同 prompt 加 [CACHED] hint
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"[CACHED] hello world how are you"}],"max_tokens":8,"stream":false}'
```

stdout 日志里 `billing_settled` 这一行可以看到第 2 次的 `cached_input_tokens > 0`, `final_cost_micro_cny` 显著低于第 1 次.

## 跑 batch 异步通道

```bash
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"batch test"}],"max_tokens":8,"stream":false,"priority":"low"}'
```

`priority:"low"` 会强制路由到 `supports_batch=true` 的 channel (mock-cheap-batch), 计费按 batch 单价 (0.5x both input/output).

## 跑三个独立子工具

每个工具单独 npm install + npm start, 不需要起主网关.

```bash
# 1. cost-router-demo: 跑 10 笔模拟请求, 看 cost_priority 选择决策 + fallback
cd tools/cost-router-demo && npm install && npm start

# 2. prompt-cache-demo: 起内嵌 mock, 跑 Anthropic + OpenAI 缓存命中前后成本对比
cd tools/prompt-cache-demo && npm install && npm start

# 3. model-fingerprint-cli: 探测一个 OpenAI 兼容 endpoint 是否在偷换模型
cd tools/model-fingerprint-cli && npm install
npm run mock &                         # 起一个故意「声称 gpt-4o 实际像 GLM」的 mock 上游
npx tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o --probes all
```

## 相对 v0.9 的核心变化

| 维度 | v0.9 | v0.10 |
|------|------|------|
| 选 channel | `pickChannelForModel` (priority desc) | `pickCheapestChannel` (cost_priority asc → priority desc) |
| 价格表字段 | input/output 两列 | + cache_input + batch_input + batch_output 三列可选 |
| usage_records 字段 | 17 列 (含 channel_id / latency / attempted) | + cached_input_tokens + cache_write_tokens + batch_mode |
| 计费 | postConsume 按 input/output 两价 | computeFinalCost 拆 normal/cache/batch 三套单价 |
| 默认 channel | 3 个 (含 will-fail-401 演示禁用) | 5 个 (cost_priority 10/20/50/80/100, 全 key 合法) |
| 请求语义 | OpenAI 兼容字段 | + priority: "low" 走 batch 异步通道 |

## 仍然故意保留的缺陷 (留给后续章节)

- 真实 batch API 是 jsonl 文件上传 + 24h 异步流程 (OpenAI Files + Batches API), 本章简化为 5s 窗口 + 同步发, 只为演示计费链路 (v1.0 接 OpenAI Batch API 完整流程);
- 流式 (SSE) 路径上的 cached_input_tokens 抽取留作扩展点, 主要在非流式 demo 看效果;
- 用户钱包 / 支付链路仍然不存在, 余额是 admin 手动充 (v0.11);
- 模型指纹检测目前是 5 个最小探针, 真实运营应当配合 logprobs 分析 + 更完整的指纹库工具.

## 引用

- Anthropic Prompt Caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI Prompt Caching: <https://openai.com/index/api-prompt-caching/>
- OpenAI Batch API: <https://developers.openai.com/api/docs/guides/batch>
- DeepSeek Context Caching: <https://api-docs.deepseek.com/news/news0802>
- Gemini Pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- one-api 倍率定价: <https://github.com/songquanpeng/one-api>
- 中转站灰色生意综述 (gm7.org): <https://www.gm7.org/archives/48708>
