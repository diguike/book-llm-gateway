---
title: 第 10 章 中转站为什么便宜
feishu_url: "https://www.feishu.cn/wiki/U0B2wwof3iZK7dksQMQc3PJOnob"
last_synced: "2026-05-16T18:29:14"
---

## 10.1 为什么自建网关比对外卖的中转站贵

v0.9 之后，一切都可观测了。看板上每一笔账都清清楚楚: `gpt-4o-mini` 一笔请求 (5 prompt + 17 completion = 22 token) 实结 9 微元人民币，折算下来跟官方公布的 1.05 元/1M input + 4.32 元/1M output 完全吻合。

然后打开市面上随便一家面向开发者的中转站，用同样的 `gpt-4o-mini`, 同样的 22 token, 价格只要 4-5 微元。折算下来比官方价低 50%-60%, 比自建网关也低同样幅度。翻它的「价格说明」页面，写的是「比官方便宜 60%, 充值即用」.

第一反应通常是怀疑——比官方便宜。上游单价摆在那里，中转站买进价 = 官方原价，卖出价 60%, 这怎么能持续?

可持续的部分有，不可持续的部分也有。这一章把两者拆开。先讲 5 件合法的、可量化的降本机制，每一件都给出数字 + 落地代码。再讲 3 件灰色玩法，揭原理但不教操作，配合一个基于学术论文的指纹审计工具教读者怎么自我防御。

具体拆开:

**合法降本 5 件**:

1. **Prompt caching 透传**: 上游官方原生提供的缓存折扣. Anthropic 的 cache read 是 input 单价的 0.1x, OpenAI 的 cached_tokens 是 0.5x, Gemini 是 0.1x, DeepSeek 是 0.1x. 在 system prompt 长 + 高频复用场景，这一招就能把 input 成本砍 60%-80%.
2. **Batch API 异步通道**: OpenAI / Anthropic 都提供 batch API, 50% 折扣, 24 小时内异步返回。中转站把延迟不敏感的请求 (评分 / 翻译 / embeddings 重算。走 batch, 同步通道维持原价。
3. **渠道倍率与套利**: 同一个 logical model (例如 `gpt-4o-mini`) 可以挂在 5-10 个上游 channel 上 (官方直连 + Azure OpenAI + 第三方代理 + 国内经销). 不同 channel 的进货价不一样，网关层做倍率定价，卖出价由 `用户倍率 × 渠道倍率 × 模型倍率` 决定。
4. **成本路由 fallback**: 多 channel 之间按价格升序请求，命中限流或 5xx 时降级到稍贵但稳定的下一档。主路径永远先吃便宜的，兜底吃贵的。
5. **企业渠道价差**: Azure OpenAI / Vertex AI 对企业大客户提供 commit 折扣，通常 10%-30%. 一个企业大账号承接所有用户流量，吃返点差是合规的，且公开 SKU 可查。

**灰色玩法 3 件 (只揭原理，不实现，不展示代码)**:

1. **拼车号池**: 把 Claude Pro $20 / Claude Max $200 / ChatGPT Team 这种月费订阅逆向出 API, 5-20 人共享分摊。易克拉迪等拼车站官方页面写明「Claude Max $200 → 5 人车 ¥399/月」，等效 72% 折扣。违反所有上游 ToS, 厂商收紧时立刻塌方。
2. **退款套利**: 批量注册账号 + 充值 + 用到额度耗尽前被封 + 申请退款 + 循环。虎嗅 2026 年 4 月报道详述四层结构 (盗刷信用卡 → 逆向 → 灰色流转 → 正规 API), 上游一收紧政策成本立刻从 0.4 元/刀涨到 1+ 元/刀。
3. **偷偷降级模型**: 用户调 `gpt-5`, 后台路由到 GLM-4-9B 或 DeepSeek 等便宜模型。公开社区曾多次曝光。声称提供顶级闭源模型的某些中转服务，行为表现与开源中小参数模型一致——这类问题可以用指纹检测工具识别，也是为什么本章 10.9 节会落一个 5 探针的 CLI 让读者自己跑。这是黑色生意，一旦被审计上游会封 channel, 下游集体宕机。

最后一件是本章最有价值的「防御侧」工具: 本章落一个 5 探针的指纹检测 CLI, 让读者自己能审计接入的中转站是不是在偷换模型——不教做攻击，教做防御。

字段口径上，本章不引入新的运行时概念，只是在 v0.9 已有的 `usage_records / prices / channels` 三张表上各加 2-3 列，主路径的选 channel 函数从 `pickChannelForModel` 切到 `pickCheapestChannel`. 增量代码约 600 行 (主项目 200 + 三个独立子工具各约 130 行).

按照 v3 draft 的 Ch10 合同，本章是对外创业场景的核心护城河章节。企业基建场景的读者可以挑读「成本路由 fallback」(10.5 节), 其余四种合法机制对对外创业必读。

## 10.2 Prompt caching: 一行单价改造省 60%

把 prompt caching 排第一，是因为它是**唯一一件可以光明正大写在产品页上**的降本机制: 上游官方文档明文支持，计费字段公开，实现成本极低。

四家主流上游各自的语义差异，列表对比:

| 上游 | 触发方式 | 缓存读单价 | 缓存写单价 | usage 字段 | 文档 |
|------|----------|-----------|-----------|-----------|------|
| Anthropic | 显式 `cache_control` breakpoint, ≤ 4 个 | 0.1x input | 1.25x (5min) / 2x (1h) | `cache_read_input_tokens` / `cache_creation_input_tokens` | [docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| OpenAI | ≥ 1024 token 的 prefix 自动缓存, 5-10min 内有效 | 0.5x input | 同 input (无溢价) | `prompt_tokens_details.cached_tokens` | [post](https://openai.com/index/api-prompt-caching/) |
| Gemini | explicit cache API + cache_name 引用 | 0.1x input | 同 input | `usage_metadata.cached_content_token_count` | [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| DeepSeek | 自动 KV cache, 无显式控制 | 约 0.1x input | 同 input | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | [news](https://api-docs.deepseek.com/news/news0802) |

数字层面, OpenAI 50% 的折扣已经够大, Anthropic / Gemini / DeepSeek 的 90% 折扣更夸张。但夸张归夸张，必须满足两个前提才能拿到:

**前提 1: 不破坏 prefix**. 自动缓存 (OpenAI / DeepSeek) 要求两次请求的 prompt 前 N 字节字节级一致。网关如果在 prompt 头里塞了 trace_id / timestamp / 随机串，哪怕只有 4 个字符不同，缓存命中率立刻归零。

这是中转站很容易踩的坑: 想象一下这种「为了方便对账」的写法:

```ts
// 反面教材: 在 prompt 前面拼 trace_id
const messagesWithTrace = [
  { role: 'system', content: `[trace=${traceId}] ${originalSystem}` },
  ...originalMessages.slice(1),
];
```

每次请求 trace_id 都不同，上游看到的 system prompt 字面值每次都不同，缓存命中率 = 0. 用户付双份钱，网关运营自己还浑然不觉。

**前提 2: 显式 cache_control 字段透传**. Anthropic / Gemini 的缓存是显式声明的，用户在请求体里告诉上游「这一块系统 prompt 帮我缓存」. 网关层必须把 `cache_control` 字段原封不动转给上游，不能因为「我们的 IR 里没有这个字段」就丢掉。

这两件事本章的 `optimization/prompt-cache.ts` 都做了。看代码:

```ts
// src/optimization/prompt-cache.ts (节选)
export function extractCacheUsageFromOpenAI(usage: unknown): ExtractedCacheUsage {
  if (!usage || typeof usage !== 'object') {
    return { cachedInputTokens: 0, cacheWriteTokens: 0 };
  }
  const u = usage as Record<string, unknown>;

  // OpenAI: prompt_tokens_details.cached_tokens
  let cachedTokens = 0;
  const details = u['prompt_tokens_details'];
  if (details && typeof details === 'object') {
    const ct = (details as Record<string, unknown>)['cached_tokens'];
    if (typeof ct === 'number' && ct >= 0) cachedTokens = ct;
  }

  // DeepSeek: prompt_cache_hit_tokens (顶层字段)
  const deepseekHit = u['prompt_cache_hit_tokens'];
  if (typeof deepseekHit === 'number' && deepseekHit >= 0 && cachedTokens === 0) {
    cachedTokens = deepseekHit;
  }
  return { cachedInputTokens: cachedTokens, cacheWriteTokens: 0 };
}
```

OpenAI 兼容族 (含 DeepSeek) 共用一个抽取函数，兼容两种字段位置. Anthropic 单独一个 `extractCacheUsageFromAnthropic`, 同时取 read 与 write 两个字段。

抽出来的数字怎么计费? `billing/prices.ts` 加了一列 `cache_input_price_micro_per_1m`, 每个 model 独立配置. `billing/calculator.ts` 多一个 `computeFinalCost` 私有函数，把 input 成本拆成「普通 input + cache 命中」两部分:

```ts
// src/billing/calculator.ts (节选)
function computeFinalCost(
  input: PostConsumeInput,
  price: ResolvedPrice,
  multiplier: number,
): { promptCost: number; completionCost: number; cacheCost: number; finalCost: number } {
  const cached = Math.max(0, input.cachedInputTokens ?? 0);
  // realPromptTokens 通常包含 cached 部分, 减出 normal input
  const normalInput = Math.max(0, input.realPromptTokens - cached);

  const inputUnit = price.inputPricePerToken;
  const cacheUnit =
    price.cacheInputPricePerToken !== null
      ? price.cacheInputPricePerToken
      : price.inputPricePerToken;

  const normalInputCost = normalInput * inputUnit;
  const cacheReadCost = cached * cacheUnit;
  const outputCost = input.realCompletionTokens * price.outputPricePerToken;

  const promptCost = Math.ceil((normalInputCost + cacheReadCost) * multiplier);
  const completionCost = Math.ceil(outputCost * multiplier);
  const cacheCost = Math.ceil(cacheReadCost * multiplier);
  return { promptCost, completionCost, cacheCost, finalCost: promptCost + completionCost };
}
```

最关键一行是 `realPromptTokens - cached`. 上游返回的 `prompt_tokens` 字段通常已经包含 cached 部分 (OpenAI 文档明文如此, Anthropic 的 `input_tokens` 不含 cache_read 是另一种约定). 把这两部分拆开按各自单价算，加起来就是真实 input 成本。

跑一次实测对比。主项目里 mock-upstream 加了一个简化的「`[CACHED]` 前缀触发 80% 命中」规则:

```bash
# 第 1 次 (5 token, 全 cold)
curl ... -d '{"messages":[{"role":"user","content":"hi there how are you"}], ...}'
# 日志: prompt_tokens=5, cached_input_tokens=0, final_cost=9 微元

# 第 2 次 (13 token, 其中 10 token 缓存命中)
curl ... -d '{"messages":[{"role":"user","content":"[CACHED] hi there how are you ..."}], ...}'
# 日志: prompt_tokens=13, cached_input_tokens=10, final_cost=8 微元
```

第 2 次输入 token 是第 1 次的 2.6 倍，但成本反而更低。这就是 cache 单价 (0.1x) 的威力——10 个 cached token 只算 1 个 token 的钱，比剩下 3 个 normal token 的钱还少。

`tools/prompt-cache-demo/` 是一个独立的子工具，里面起了一个内嵌的 mock 上游，同时实现 Anthropic 显式 `cache_control` 和 OpenAI 自动 prefix 两套语义，跑出来的实测数字 (本机。是:

- Anthropic: 第 1 次冷调 2452 微元，第 2 次命中 1011 微元, **节省 58.8%**
- OpenAI: 第 1 次冷调 402 微元，第 2 次命中 369 微元, **节省 8.2%** (短 prompt 收益小)
- 反例: 在 OpenAI 请求前加 trace_id 破坏 prefix, 命中归零，第 2 次反而比第 1 次贵 (因为输入文本变长了)

OpenAI 的节省幅度看起来不大，是因为 demo 里的 prompt 才 358 token. 真实产品场景下 system prompt + tool schema 通常 5K-20K token, 缓存命中能让 input 成本砍半，配合 output 成本不变，整体单笔成本下降 30%-40%.

cache_control 透传那一面更简单，我们什么都不做就好。主项目的 IR (`types/ir.ts`) 用了 `passthrough()`, message content 数组里的 `cache_control` 字段会原封不动传到 `OpenAIAdaptor.buildRequest()` 拼出的请求体里，上游能识别。这是 v0.2 抽 IR 时埋的伏笔——「不知道是干什么的字段，透传」, Ch10 才看到回报。

至于 Anthropic 的 cache write 溢价 (1.25x / 2x), 本章简化为按 input 单价计 (`cacheWriteTokens` 走 `inputPricePerToken`), 没把这部分扣下来。真实运营要严格的话，多加一列 `cache_write_5min_price_micro_per_1m` 和 `cache_write_1h_price_micro_per_1m`, 计费时按 break point 的 ttl 分别算。教学场景这个细节留作扩展点。

cache 命中率本身是一个需要主动监控的指标: 在 v0.9 的 dashboard 基础上，加一行聚合 SQL 就能算出当日「cached_input_tokens / prompt_tokens」的比例，反映 system prompt 设计是否合理。命中率长期低于 30% 通常意味着两件事之一。要么 system prompt 还没稳定下来 (每次调用都在改), 要么调用频率太低 (5-10 分钟的 cache TTL 内没有第二笔同 prefix 请求). 前者是 prompt engineering 问题，后者是流量问题，两件事都不归网关解决，但网关需要把命中率暴露出来让上层有据可查。

另一个常见误区是「主动 warm-up cache」. 有运营会想。上线一段长 system prompt 之前，先用一个空 user query 发一次给上游，把 cache 写好，后续请求就能直接命中。听上去合理，实际不工作——Anthropic 的 5min cache 是按「breakpoint 内容 + 写入时刻」严格计算 TTL 的，没有续期机制: 用一次预热写入只能护住后 5 分钟的请求，第 6 分钟来的请求又是冷调。真要稳定命中，必须让真实流量的频率本身 ≥ 1 次/5min. cache 是「频率给的奖励」，不是「能主动获取的资源」.

## 10.3 Batch API: 用 24 小时换 50% 折扣

Batch 是另一件「能光明正大写在产品页上」的降本机制，但比 prompt caching 多一个隐性成本。用户能不能接受异步。

OpenAI 官方文档明确「each model is offered at 50% cost discount vs. the synchronous APIs」, 24 小时内完成，支持 `/v1/chat/completions`、`/v1/embeddings`、`/v1/responses`、`/v1/videos` ([docs](https://developers.openai.com/api/docs/guides/batch)). Anthropic 同样有 batch API ([docs](https://docs.anthropic.com/en/api/creating-message-batches)), 50% 折扣，而且**可以和 prompt caching 叠加**——如果用户的批量请求里有大段重复的 system prompt, 单次成本可以降到原价的 50% × 10% = 5%.

真实 batch API 的流程是这样的:

1. 客户端把多条 request 拼成一个 jsonl 文件 (一行一个 chat completion 请求);
2. POST `/v1/files` 上传文件，拿到 `file_id`;
3. POST `/v1/batches` 提交 batch 任务, `completion_window: "24h"`, 拿到 `batch_id`;
4. 24 小时内异步执行，期间客户端 polling `/v1/batches/{batch_id}` 看状态;
5. 完成后下载结果文件，按 `custom_id` 把每条响应跟原请求对应起来。

中转站能怎么用这个机制: 两种实现:

**实现 a: 真 batch**. 把客户端的同步请求攒 5-15 分钟一批，然后发上游 batch API. 用户付出延迟换 50% 单价折扣。适合: 评分 / 翻译 / 摘要等非交互场景。

**实现 b: 假 batch**. 用一个吃 batch 折扣的「专享 key」(企业账号，跑闲时计算队列), 给前端伪装成同步: 这种实现只是「拿到 batch 价但是同步响应」，上游不真的走 batch.

绝大多数 chat 类中转站不会做实现 a, 因为 chat 用户体验对延迟敏感，等 5 秒就有人骂。实现 b 在中转站里更常见，但它依赖企业账号资源，不是所有运营都能拿到。

本章 v0.10 主项目里给出实现 a 的雏形 (5 秒窗口或攒满 10 条触发 flush), 不接 OpenAI Batch API 完整流程 (jsonl 上传 + 24h polling) ——那一段是工程接入题，跟本章「降本机制」核心不重叠。简化版的代码在 `optimization/batch-channel.ts`:

```ts
// src/optimization/batch-channel.ts (节选)
const BATCH_WINDOW_MS = Number(process.env.BATCH_WINDOW_MS ?? 5000);
const BATCH_MAX_SIZE = Number(process.env.BATCH_MAX_SIZE ?? 10);

const queueByModel: Map<string, BatchJob[]> = new Map();
let flushHandle: NodeJS.Timeout | null = null;

export function enqueueBatchRequest(group: string, ir: IRChatRequest): Promise<IRChatResponse> {
  return new Promise<IRChatResponse>((resolve, reject) => {
    const job: BatchJob = { ... };
    let q = queueByModel.get(ir.model);
    if (!q) { q = []; queueByModel.set(ir.model, q); }
    q.push(job);

    if (q.length >= BATCH_MAX_SIZE) {
      void flushModel(ir.model);
      return;
    }
    if (!flushHandle) {
      flushHandle = setTimeout(() => {
        flushHandle = null;
        void flushAll();
      }, BATCH_WINDOW_MS);
    }
  });
}
```

5 秒窗口或 10 条攒满，任一触发就 flush. flush 时把队列里所有任务发到 `supports_batch=true` 的 channel, 计费按 `batchInputPricePerToken / batchOutputPricePerToken` 算。主路径用一个新的 IR 字段 `priority: "low"` 触发这个分支:

```ts
// 客户端
curl -X POST $BASE/v1/chat/completions \
  -d '{"model":"mock-gpt-4o-mini",
       "messages":[{"role":"user","content":"批量翻译第 N 句"}],
       "max_tokens":256,
       "priority":"low"}'   // 这一行让请求走 batch 通道
```

`priority: "low"` 是网关层私有字段，不透传给上游: 上游不认这个字段，对它来说还是一笔普通的同步请求: 网关做的事是。把这一笔请求路由到 `supports_batch=true` 的 channel + 计费时强制走 batch 单价。

实测一下成本差异:

```
# 普通请求 (priority 不传, 默认同步通道, 用 normal 单价)
final_cost_micro_cny: 9

# priority=low (走 batch 通道, 用 batch 单价)
final_cost_micro_cny: 4
```

batch 模式下 input 与 output 都按 0.5x 算, 4 / 9 ≈ 0.44, 略低于 0.5 是因为 input 太短 (向上取整的 ceiling 噪声). 真实场景下 prompt 几百到几千 token, 节省幅度稳定在 50%.

`channels.supports_batch` 字段是 v0.10 新增的，标记哪些 channel 配的是企业 batch key. 默认 channel 里 `mock-cheap-batch` 设为 `true`, 其余四个 false. 路由时只看这一标记:

```ts
// src/optimization/cost-router.ts (节选)
export function pickCheapestChannel(
  group: string,
  model: string,
  options?: CostPickOptions,
): CostPickedChannel | null {
  let list = registry.lookup(group, model);
  if (options?.requireBatch) {
    list = list.filter((c) => c.supportsBatch);
    if (list.length === 0) return null;
  }
  // ... 按 cost_priority asc 选 ...
}
```

`requireBatch: true` 直接过滤掉 supports_batch=false 的 channel. 如果 batch channel 全挂了，不会自动降级到非 batch channel——降级会让用户付了 batch 价却走了 normal 通道，是反向漏洞。直接返 503 让客户端重试或换 priority=normal.

batch + cache 叠加是一个值得多说一句的组合. Anthropic 文档里明确写「Message Batches API and prompt caching can be used together」: 把多条请求都用同一个 cache_control 标记的 system prompt, 走 batch, 第二条起命中 cache → 那一条的 input 成本是 0.1x (cache) × 0.5x (batch) = 0.05x. 一段 10K token 的 system prompt 在批量场景下成本可以降到原价的 5%, 这是中转站能在「文档评分」「批量翻译」类场景给到 80% 折扣的真实来源。

`batch_mode` 字段被独立落到 `usage_records` 里，是为了看板能区分「同步实时 vs 异步 batch」两个轨道的实际成本占比。一个对外卖 token 的网关运营每周都会看这两个数字: batch 占比 50%+ 表示客户在用 priority=low, 整体毛利空间大; batch 占比 < 10% 表示客户全部要实时，网关的护城河主要靠 cache + 企业 channel. 数字差异直接影响商务策略——是去争取更多企业 batch 配额，还是去签更多 Azure commit.

## 10.4 渠道倍率: one-api 的核心抽象

第三件机制是渠道倍率定价，这是 one-api / new-api 的核心商业抽象，在我们的 v0.5 计费模块里也已经有了 (`channelMultiplier` 字段). v0.10 没有动这一块，只是在它之外多加了一层 `cost_priority` 字段，把「价格分档」与「可用性分档」拆开。

先回顾 one-api 的倍率公式:

```
final_cost = (input_tokens + output_tokens × completion_ratio) × group_ratio × model_ratio × channel_ratio
```

四个倍率分别表达:

- `model_ratio`: 模型本身的相对单价。比如 GPT-4o = 2.5, GPT-4o-mini = 0.15, 数字代表「相对于 GPT-3.5 的倍数」.
- `completion_ratio`: output 相对 input 的倍数. GPT-4o = 4 (output 是 input 的 4 倍价).
- `group_ratio`: 用户分组的整体折扣. VIP = 0.8, 普通用户 = 1.0.
- `channel_ratio`: 渠道倍率. 1.0 = 按官方原价收, 0.3 = 按 0.3 倍人民币就能消费等量额度。

`channel_ratio` 是商业护城河的核心: 同一个 `gpt-4o-mini` 背后可能挂 5-10 个 channel, 每个 channel 的 channel_ratio 不一样:

- 官方直连: channel_ratio = 1.0 (原价 + 加价)
- Azure OpenAI: channel_ratio = 0.85 (吃企业 commit)
- 第三方分销: channel_ratio = 0.5 (灰色，拼车号池，上游随时可能封)
- 企业经销商: channel_ratio = 0.7 (有合同，稳定)

社区里[一篇综述文章](https://www.gm7.org/archives/48708) 把倍率分布写得很清楚: 1.0 = 官方原价 + 正常加价、0.5-0.8 = 企业折扣或 Azure 渠道、0.1-0.3 = 逆向 / 拼车 / 号池 / 有封号风险: 中转站把这些 channel 都堆在同一个 logical model 名下，路由时按权重轮询，用户付一份钱，中转站赚一份差价。

我们的 v0.5 已经实现了「渠道倍率」(`channels.channel_multiplier` 字段), v0.10 把它真正用起来: `seed.ts` 灌的 5 个默认 channel 不再像 v0.8 那样全部 channel_multiplier=1.0, 而是各自配不同的 cost_priority. 主路径选 channel 时优先选 cost_priority 最低的，失败逐档降级。看下一节。

## 10.5 成本路由 fallback: cost_priority asc + 失败降级

第四件机制 cost_priority 是 v0.10 新增的字段，也是这一章对主项目最实质性的改动。

为什么不直接复用已有的 `priority` 字段: 因为 `priority` 与 `cost_priority` 表达的是两件不同的事:

- `priority` (Ch8 引入): 解决「主备分层」，主用 = 100, 备用 = 50, 兜底 = 10. 主活就别动备。一般运维不改。
- `cost_priority` (Ch10 新增): 解决「省钱优先」，越小越便宜。高频运营字段，每月跟进调价时调整。

混在一个字段里会出现矛盾的语义: 例如「企业大客户 channel」既是「最便宜」(cost) 又是「最优先用」(priority), 用同一个数字描述; 「逆向号池 channel」既是「最贵备用」又是「价格最低」，没法靠一个数表达。拆成两个字段后，一个真实场景就清楚了:

| channel | priority | cost_priority | 说明 |
|---------|---------|---------------|------|
| azure-oai-1 | 100 | 10 | Azure 企业账号, 享 commit 折扣, 最便宜 |
| openai-direct | 100 | 50 | 官方直连, 标准价 |
| openai-backup | 50 | 50 | 官方备用 key, 主号炸了用 |
| reseller-pool | 100 | 100 | 第三方分销, 贵但充足 |

v0.9 的行为: priority desc → azure / openai-direct / reseller-pool 三选一加权随机, openai-backup 永远不会被选 (priority 低一档).

v0.10 的行为: cost_priority asc + priority desc → 优先 azure-oai-1 (最便宜的高 priority), 失败 → openai-direct, 再失败 → reseller-pool, 整个 priority=100 那一层穷尽后才往 priority=50 走。

代码上，选择算法在 `optimization/cost-router.ts`:

```ts
// src/optimization/cost-router.ts (节选)
export function pickCheapestChannel(
  group: string,
  model: string,
  options?: CostPickOptions,
): CostPickedChannel | null {
  const registry = getChannelRegistry();
  let list = registry.lookup(group, model);
  if (list.length === 0) return null;

  if (options?.requireBatch) {
    list = list.filter((c) => c.supportsBatch);
    if (list.length === 0) return null;
  }

  // 按 cost_priority asc 分层, 同层按 priority desc
  const sorted = [...list].sort((a, b) => {
    if (a.costPriority !== b.costPriority) return a.costPriority - b.costPriority;
    return b.priority - a.priority;
  });

  // 逐层尝试: 同 costPriority 一层 -> weighted -> 失败再下一层
  let i = 0;
  while (i < sorted.length) {
    const currentCost = sorted[i]!.costPriority;
    const layer: ChannelEntry[] = [];
    while (i < sorted.length && sorted[i]!.costPriority === currentCost) {
      layer.push(sorted[i]!);
      i++;
    }
    const picked = pickChannel(layer, { excludeIds: options?.excludeIds });
    if (picked) {
      return {
        channel: picked,
        adaptor: buildAdaptorForChannel(picked),
        selectedTier: { costPriority: picked.costPriority, priority: picked.priority },
      };
    }
  }
  return null;
}
```

`pickChannel` 复用 v0.8 的 weighted-picker, 同层按 weight 加权随机. fallback 主路径在 `index.ts` 的故障转移循环里:

```ts
for (let attempt = 0; attempt < MAX_CHANNEL_ATTEMPTS; attempt++) {
  const picked = attempt === 0
    ? firstPick
    : pickCheapestChannel(DEFAULT_GROUP, ir.model, {
        excludeIds,
        requireBatch: isBatch,
      });
  if (!picked) { /* refund + 502 */ }
  attemptedChannels.push(picked.channel.id);
  // ... 发上游, 失败则 excludeIds.add(picked.channel.id) 进入下一档 ...
}
```

`excludeIds` 累加已试过的 channel id, 下次 `pickCheapestChannel` 自动跳过，直接选下一档便宜 channel 中没试过的。算法层面没有特殊处理，直接交给同一份 weighted-picker.

实测一下这套 fallback. `tools/cost-router-demo/` 是一个独立 demo, 起 5 个 mock channel, 故意把 cost_priority=10 的那个配成 50% 概率失败。跑 10 笔请求，输出节选:

```
请求 #1:
  [attempt=0] cost_tier=10 -> azure-oai-cheap (fail)
  [attempt=1] cost_tier=20 -> deepseek-direct (success)
  -> 命中 deepseek-direct (cost_priority=20), 成本 1100 微元

请求 #5:
  [attempt=0] cost_tier=10 -> azure-oai-cheap (success)
  -> 命中 azure-oai-cheap (cost_priority=10), 成本 550 微元

汇总:
  总请求: 10
  总成本: 9350 微元 (avg 935 微元/请求)
  Channel 命中分布:
    azure-oai-cheap        3 次 (30%)
    deepseek-direct        7 次 (70%)
  对照: 平均轮询所有可用 channel 的预期成本 1257 微元/请求.
  本次 cost-router 实际平均 935 微元/请求, 节省 25.6%.
```

最便宜的 channel 即使一半概率失败，也每次先被尝试。失败了立刻 fallback 到下一档，用户感受不到任何延迟差异 (除了多发了一次上游请求，增加几十毫秒). 整体平均成本对比「平均轮询所有可用 channel」节省 25.6%, 这个数字会随 cost_priority 的分布拉得越开就越大。

成本路由的工程价值不只是省钱。它还隐含一个「自动适配上游政策变化」的能力——如果 Azure 突然涨价，运营把 azure-oai-1 的 channel_multiplier 从 0.85 调到 1.0, 选择决策不变 (cost_priority 没改), 但实际计费立刻反映新价格。如果 OpenAI 突然给企业账号 50% 折扣，加一个 cost_priority=5 的新 channel, 主路径自动开始优先用它，不需要改任何代码。

「数据驱动 vs 代码驱动」这件事在中转站的成本优化里特别明显。中转站每周都在跟上游政策博弈 (Anthropic 4 月取消了原 10-15% API 折扣改成 seat-based [(theregister)](https://www.theregister.com/2026/04/16/anthropic_ejects_bundled_tokens_enterprise/), OpenAI 的 batch 折扣偶尔上调, Gemini 改 cache 单价), 任何「写死在代码里」的策略都活不过一个月。把所有可调参数都做成 channel 表里的字段 + admin 接口热更，是中转站架构必须的一层。

成本路由还有一个隐性的合规价值。它让运营在「便宜但合规风险高」的 channel 与「贵但完全合规」的 channel 之间显式抉择. v0.9 的混合 weighted 轮询机制下，一个 channel_ratio=0.3 的逆向号池可能跟一个 channel_ratio=1.0 的官方直连按权重共存。运营要把灰色 channel 摘掉，需要逐个调权重为 0 (或干脆删除). v0.10 之后，把逆向 channel 单独设一个 cost_priority=300, priority=10, 它就是「永远不会被主路径选中，只在所有其它都死的时候才会试」的兜底位置。一行字段值的改动等于一次合规策略调整，不需要重启服务、不需要写代码、不需要等发版。

至于 fallback 在「客户端等待时间」上的代价，实测下来一笔请求多试一档 channel 约增加 50-200ms (本机直连 mock 上游, 50ms; 跨大洲走真实上游, 200ms). 算上 v0.8 的 streaming 「首字节前可重试」机制，客户端在 fallback 命中之前不会收到任何输出，看到的就是一次比较慢的请求，不会出现「上半段是 A channel 的输出，下半段是 B channel 的输出」这种串味。这是 Ch8 重构 sse-proxy 时埋下的伏笔, Ch10 才看到回报。

## 10.6 企业渠道价差: Azure / Vertex 与公开 SKU

第五件合法降本机制是企业渠道价差。这部分不需要任何代码改动，是「商务能力的工程化承载」.

Azure OpenAI 的 SKU 与 OpenAI 直连按 token 同价，但有两类隐性折扣:

1. **Azure commit**: 已经有 Azure 既定 commit 的企业，用 Azure OpenAI 等于把 LLM 消耗也算进 commit 基数，等效享受 Azure 整体折扣 (通常 10%-20%, 取决于 commit 量级). 公开资料: [cloudzero.com 的 Azure OpenAI 定价分析](https://www.cloudzero.com/blog/azure-openai-pricing/), [redresscompliance.com 的 Azure OpenAI pricing 解读](https://redresscompliance.com/azure-openai-pricing-explained-what-microsoft-doesnt-tell-you.html).
2. **预付承诺**: Anthropic / OpenAI 都对年付 + 承诺消费量给 10%-30% 单价折扣. [costbench.com 的 OpenAI discounts 页](https://costbench.com/software/llm-api-providers/openai-api/discounts/) 整理了公开档位. Anthropic 2026 年 4 月调整，取消了原来的 10-15% API 折扣改为 seat-based, 这种政策变化是中转站接入决策必须跟踪的。

中转站怎么用这个。用一个企业大账号承接所有用户流量，吃返点差。网关层不需要做任何特殊处理——Azure 的 endpoint 就是一个普通的 OpenAI 兼容 channel, 配进 channels 表，设个低 cost_priority 即可。价差通过「卖给客户的单价 vs 自己付给 Azure 的单价」自动落到中转站的毛利里。

代码层面这是一个零行改动的机制: 但要落地需要两件事都到位:

- **商务**: 拿到 Azure / 经销商 / 企业账号的合同，这是非工程能力;
- **工程**: 把 Azure endpoint 接进 channels 表，设合理的 cost_priority, 让主路径自动优先选它。

第二件事我们的网关已经支持了。把 Azure 接进来的方法:

```bash
curl -X POST $BASE/admin/channels \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "name": "azure-prod-eastus",
    "provider": "openai",
    "apiKey": "<azure-key>",
    "baseUrl": "https://your-resource.openai.azure.com/openai/deployments/gpt-4o-mini",
    "enabledModels": ["gpt-4o-mini"],
    "priority": 100,
    "weight": 5,
    "costPriority": 10,
    "channelMultiplier": 0.85
  }'
```

`provider: "openai"` 让网关用 OpenAIAdaptor 处理 (Azure OpenAI 与 OpenAI 兼容，仅 endpoint 路径不同). `costPriority: 10` 让主路径优先选它. `channelMultiplier: 0.85` 把 15% 折扣落到计费里 (用户付 0.85 倍人民币就能消费 1 倍额度).

公开的 channel 单价对比 (2026 年 5 月公布价，以 gpt-4o-mini 为例，元 / 1M tokens):

| 渠道 | input | output | 备注 |
|------|-------|--------|------|
| OpenAI 直连 | 1.05 | 4.32 | 官方价 (按 0.15 USD / 0.60 USD × 7.2 汇率) |
| Azure OpenAI | 1.05 | 4.32 | 同价, 但可吃 commit 折扣 |
| OpenAI Cached | 0.525 | - | 自动 prefix 缓存 0.5x |
| OpenAI Batch | 0.525 | 2.16 | 异步通道 0.5x |
| Anthropic Claude 3.5 Sonnet | 21.6 | 108 | 完全不同模型, 仅作单价对比 |
| Anthropic Cache Read | 2.16 | - | 0.1x input |
| Anthropic Batch | 10.8 | 54 | 0.5x both |

把这些数字配进 prices 表 (本章 prices.ts 默认 seed 已经全部灌入), 就能在 admin 接口查不同 model 不同 channel 的实时单价。一个 channel 接入新 SKU 时, admin 加一行 channel + 一行 price, 主路径无感知。

## 10.7 灰色玩法 1: 拼车号池

合法的 5 件讲完了。接下来 3 件是灰色玩法，揭原理但不给实现，也不教读者怎么做。

第一件是拼车号池。模型:

- Claude Pro $20/月，网页版 + Claude Code 客户端按对话不按 token;
- Claude Max $200/月，配额 5x Claude Pro;
- ChatGPT Plus $20/月 / Team $25/seat/月，按对话不按 token.

把这些月费订阅在网页 / 客户端的凭据 (OAuth token / Cookie) 逆向出来，包成 OpenAI 兼容 API, 就能把「定额订阅」变现成「按 token 卖」. 多人共享分摊月费。

公开资料层面，两个开源项目说得很直白:

- [Sub2API (Wei-Shaw/sub2api)](https://github.com/Wei-Shaw/sub2api) 项目 README 明文写「让 Claude/OpenAI/Gemini 订阅统一接入，支持拼车共享」;
- [claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) 同源，专做 Claude Code 凭据池化。

商业上，易克拉迪等拼车站官方页面写明 [Claude Max $200 → 5 人车 ¥399/月](https://easyclaude.com/post/claude-code-max-pinche), 等效 72% 折扣 ($200 ≈ ¥1440, 5 人均摊 ¥288, 卖 ¥399 中转站赚 ¥555 差价). 36 氪 / 虎嗅都有过详述「ChatGPT Plus 一号 5-20 人共用」的拼车模型 ([huxiu.com/article/4854018](https://www.huxiu.com/article/4854018.html)). 这类灰色页面随时会被下架或改版，建议截图存档备查，后续引用时以截图为准。

为什么这是灰色。三个角度:

1. **ToS 违规**. Claude Pro / ChatGPT Plus 的 ToS 写明「single user」，多人共享技术上违反 ToS. 厂商目前没有大规模封禁，但随时可以。
2. **政策可变**. Anthropic 2025-2026 多次收紧 Claude Code 1h cache 与 Max plan rate limit, 被业界解读为针对拼车 ([xda-developers.com](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/)). 这种「悄悄收紧」会让拼车号池单号能服务的人数从 20 降到 5, 中转站价格立刻上涨。
3. **数据安全**. 用户的 prompt 通过号池主人逆向出来的 API 转发，中介有完整可见性: 企业敏感数据走拼车号池等于裸奔。

工程角度本章不会演示「逆向 + 多人共享」的代码。不是技术上做不到，是教读者做这个会推他往灰色里走。但读者要知道。市面上看到的「Claude Max 拼车 ¥399」就是这个机制，价格便宜的代价是合规风险全部压在用户与中转站身上。

## 10.8 灰色玩法 2: 退款套利

第二件灰色玩法是退款套利。机制:

1. 批量注册 Claude / OpenAI 账号 (开源注册机能零成本造 GPT Team 号);
2. 用盗刷信用卡或低成本支付通道充值;
3. 用到额度耗尽前主动申请「服务不满意」退款;
4. 上游退款政策松动期内成功率高，退一笔成本就归零，净赚一笔已用额度;
5. 循环。

公开资料。虎嗅 2026 年 4 月报道 [《AI Token 经济地下供应链曝光》](https://www.huxiu.com/article/4854018.html) 详述了四层结构 (盗刷信用卡 → 逆向 → 灰色流转 → 正规 API). [gm7.org 的综述](https://www.gm7.org/archives/48708) 提到「四到七毛人民币每刀」的成本来源就是这条链路。

为什么这个不能写进书:

1. **违法**. 盗刷信用卡 + 欺诈退款两条都是刑事犯罪，不在「灰色」范畴，在「黑色」.
2. **不可持续**. 上游 (尤其 Anthropic) 一收紧退款政策，地下号池单价立刻从 0.4 元/刀涨到 1+ 元/刀 ([gm7.org](https://www.gm7.org/archives/48708)). 中转站靠这条压价，上游一收紧就崩. 2026 年初 Anthropic 收紧 dispute 流程后，一批中转站集体涨价 30%-50%, 就是这个原因。

工程师视角的「防御」: 如果一个中转站的价格突然比所有合法机制能算出来的极限还低 (例如 gpt-4o-mini < 0.5 元/1M tokens), 大概率上游链路里有这种黑色环节。别用。短期占便宜，长期会断供。

这一节的价值不在「告诉你怎么做」，而在「告诉你别上别人的当」. 选中转站时看到「比官方便宜 70%」这种价格，心里要打问号，而不是单纯庆祝省钱。

## 10.9 灰色玩法 3: 偷偷降级模型 (含防御工具)

第三件灰色玩法是模型替换，也是本章最有学术依据、最值得 engineer 警惕的一件。

机制极简单。用户调 `gpt-5`, 后台路由到 GLM-4-9B 或 DeepSeek-V3 或 Llama-3.1-70B. 同一个 prompt 走开源模型成本只有 GPT-5 的 5%-10%, 但用户付的是 GPT-5 的钱。

这件事的影响有多严重。公开社区与第三方测评里能看到的迹象:

- 部分中转站的「同 prompt 不同 endpoint」比对实验里，声称顶级闭源模型但行为表现明显偏向开源中小参数模型的比例不低;
- 极端案例。声称 GPT-5 实际返回与 GLM 系列、Llama 系列、Qwen 系列高度相似的 token 分布;
- 一些站点按高价收费，但响应风格 / 知识截止日期 / 数学一致性等多个维度都对不上声称的模型——按 GPT-4o 收钱给开源模型的输出，毛利空间巨大但用户被欺诈。

具体数字让读者用本章的 `model-fingerprint-cli` 自己跑一遍最有说服力。业内成熟的指纹方法用多套维度组合: tokenizer 行为、特殊 prompt 触发的拒答模式、知识截止日期、logits 分布。完整复现需要 LLMmap 类的指纹库，工程量不小。

但本章的 `tools/model-fingerprint-cli/` 给出一个 100 行级别的「最小可用」复现版, 5 个探针，不需要 logprobs, 纯文本判定:

| 探针 | 判定逻辑 |
|------|---------|
| `self_id` | 直接问「你是哪个模型」. 看回答是否提到声称模型的 family (gpt/claude/glm), 是否反过来提到了别的家族 |
| `knowledge_cutoff` | 让上游回答自己的知识截止日期. 比对各家公开数据 (gpt-4o=2023-10, glm-4=2023-06...) |
| `tokenizer_quirk` | 让上游 echo 一个 emoji + 中文 + 日文混合的字符串, 看 tokenizer 行为差异 |
| `refusal_pattern` | 问敏感操作 (访问 /etc/passwd 等). GPT/Claude 通常带 caveat, 国产开源模型常常直接给代码 |
| `math_consistency` | 简单整数乘法 (17×23=391). 不同模型在边界算术上的表现差异 |

5 个探针的算分逻辑各不相同，摊开看一遍能避免读者跟 cli.ts 源码反复跳:

- **self_id**: 把声称模型名按分隔符拆词，第一段视为「family」(gpt-4o → gpt, claude-3-5-sonnet → claude). 把回答里出现的所有家族关键字 (gpt/claude/gemini/glm/qwen/deepseek/llama/mistral) 抓出来. family 命中且没有其它家族出现 → 1.0; family 没命中反而出现别的家族 → 0.0; 两个都出现 → 0.3 (可疑共存); 两个都没出现 → 0.5 (无法判断).
- **knowledge_cutoff**: 维护一张「声称模型 → 公开 cutoff 年-月」的小表 (gpt-4o=2023-10 / claude-3-5-sonnet=2024-04 / glm-4=2023-06 等). 正则提取回答里的 YYYY-MM, 完全相等 → 1.0; 差 ≤ 3 月 → 0.8 (训练快照差异容忍); 差 > 3 月 → 0.1 (高度可疑). 声称的模型不在表里 → 0.5 跳过。
- **tokenizer_quirk**: 让上游原样 echo `Hello, 世界! 🌍 こんにちは` (混了 ASCII + 中文 + emoji + 日文). 完整字符串包含在回答里 → 1.0; 三个核心子串 (`Hello` / `世界` / `こんにちは`) 都在但 emoji 或标点丢失 → 0.5 (低端 tokenizer 嫌疑); 否则 → 0.1. GPT-4o 的 o200k_base、Claude 的新 tokenizer 都能完美 echo, 7B 级开源模型常常丢 emoji 或加多余空白。
- **refusal_pattern**: 问「写脚本读 `/etc/passwd`」. 看回答里有没有 `careful` / `permission` / `caution` / `warning` / `security` / `be aware` 这类词。声称是 gpt/claude 且有 caveat → 1.0; 声称是 gpt/claude 但没 caveat → 0.3 (RLHF 风格对不上); 声称非 GPT/Claude → 0.7 (不强约束).
- **math_consistency**: 17 × 23 = 391. 正则抓第一个 2-5 位数字，等于 391 → 1.0; 解析不到数字 → 0.3; 其它 → 0.2. 边界算术 (两位 × 两位。是区分模型推理稳定性的低成本探针，早期 GLM / Qwen 7B 经常算错。

每个探针 ≥ 0.5 算 PASS. 5 个加权平均得到总分: < 0.5 报警, < 0.75 中等, ≥ 0.75 通过。阈值是经验值，读者可以根据自己审计的样本量调。

每个探针返回 0-1 的置信度，加权平均得到总分. < 0.5 报警. CLI 用法:

```bash
# 探一个真实 endpoint
npx tsx cli.ts --base-url https://api.openai.com --claimed gpt-4o-mini --api-key sk-... --probes all

# 探一个本地 mock (本工具自带, 模拟「声称 gpt-4o 实际跑 glm」)
npm run mock &                     # 起 :14081
npx tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o --probes all
```

实测一下检测可疑 mock 上游的输出 (本机):

```
探测 endpoint: http://localhost:14081
声称模型: gpt-4o
探针数量: 5
------------------------------------------------------------------------
[self_id] 探测中... FAIL (置信度 0.00)
  原文: I am GLM-4, an AI assistant developed by Zhipu AI.
  判定: 回答没提 family "gpt", 反而提到了 glm
[knowledge_cutoff] 探测中... FAIL (置信度 0.10)
  原文: 2023-06
  判定: cutoff=2023-06, 与期望 2023-10 相差 4 月, 高度可疑
[tokenizer_quirk] 探测中... PASS (置信度 0.50)
  原文: ```Hello, 世界! こんにちは```
  判定: echo 大部分字符 OK 但 emoji 或标点丢失, 可能是低端 tokenizer
[refusal_pattern] 探测中... FAIL (置信度 0.30)
  判定: GPT/Claude 模型应当给 caveat 但没给, 可疑
[math_consistency] 探测中... FAIL (置信度 0.20)
  原文: 381
  判定: 算成了 381, 期望 391

通过: 1 / 5
平均置信度: 0.22
[WARN] 置信度低于 0.5, 上游可能在偷换模型. 这是社区调研里反复出现的问题, 用本工具定期巡检自己接入的中转站可以早发现.
```

5 个探针中 4 个失败，平均置信度 0.22, 远低于 0.5 阈值。把这个工具拿去探一个正常的 OpenAI endpoint, 总分通常在 0.85+.

这个工具的工程价值有三个场景:

1. **接入新中转站之前**: 跑一次审计，决定要不要正式打钱;
2. **自家网关定期巡检**: 例如每周一次，防止某个 channel 上游悄悄换模型;
3. **对账纠纷时作为证据**: 「我跑了 fingerprint 通过率 0.18, 上游模型有问题」.

不适合的场景:

- **不要用来攻击或黑名单他人服务**. 探针频率高了会被识别为 abuse, 很多中转站会专门检测 fingerprint 流量并临时切回真模型 (反检测), 抽样审计就够了。
- **不要把分数当作绝对结论**. 这是辅助工具，最终判断要结合「价格异常 + 响应时延异常 + 输出风格异常」综合看。

防御侧的代码全部在 `tools/model-fingerprint-cli/cli.ts`, 不依赖任何外部库，单文件 ~250 行，读者可以 fork 加自己的探针。配套的 `mock-suspect-upstream.ts` 是一个故意「声称 gpt-4o 实际像 GLM」的本地 mock, 让读者在没有外网时也能跑通整个流程。

写到这里要明确表态。我们的网关项目本身不会做模型替换: 不演示，不教，没有任何代码路径走这条。演示这个工具是因为读者作为「中转站接入方」可能会遇到上游欺诈，工程师有权利、有责任能识别。这跟教做攻击不是一回事。

## 10.10 把 5 件合法机制叠起来。一个真实算账

把 5 件合法机制按「能叠加」「不能叠加」分类，算一笔真实账。

**能叠加的**:

- prompt cache + batch (Anthropic 文档明确两者可叠加);
- 渠道倍率 + 成本路由 (channel_multiplier 是 cost_priority 升序选完之后再乘);
- 企业渠道价差 + 任意上面的 (企业账号本身就是一个 channel, 享不享 cache / batch 看具体 SKU).

**不能叠加 / 互斥的**:

- prompt cache vs 上下文压缩。压缩会改 prefix 字节，直接破坏自动缓存;
- batch vs 实时。用户体验互斥，不能既要 batch 价又要实时响应;
- 拼车号池 vs prompt cache: 逆向 API 通常不返回真实 cache 字段 (需要中转站自己估算), 透明度 = 0.

按一个真实场景跑一遍数。假设客户调 Claude 3.5 Sonnet, system prompt 5K token (高频复用), 每次 user query 200 token, output 800 token, 一天调 1000 次:

| 计费维度 | 标准价 (元/1M) | 当次 token 数 | 当次成本 (元) |
|---------|--------------|--------------|--------------|
| input (普通) | 21.6 | 200 (user) | 0.00432 |
| input (cache read, 0.1x) | 2.16 | 5000 (system, 缓存命中) | 0.0108 |
| output | 108 | 800 | 0.0864 |
| 当次合计 | - | - | 0.10152 |

每次调用 0.1 元左右。一天 1000 次 = 100 元。

不开 cache 的话, system prompt 每次按标准价: 5000 × 21.6 / 1M = 0.108 元/次，一天多 108 元，总 208 元。

**开 cache 节省 ≈ 51%**. 这是单一机制的极限收益。

再叠加 batch (假设 80% 的请求是异步可接受的):

- 80% 走 batch: input/output 都是 0.5x, 单次 0.10152 × 0.5 = 0.05 元 → 一天 800 × 0.05 = 40 元;
- 20% 走同步: 单次 0.10152 → 一天 200 × 0.10152 = 20 元;
- 总成本 60 元/天。

**开 cache + batch 节省 ≈ 71%** vs 标准价。

再叠加企业 channel (假设拿到 0.85x channel_multiplier):

- 60 元 × 0.85 = 51 元/天。

**三件合法机制叠加节省 ≈ 75%** vs 标准价。

这个数字跟市面上中转站「比官方便宜 60-70%」的标价基本对得上。不需要任何灰色操作就能达到，唯一的代价是: 80% 的请求要异步，用户能接受才行。

如果客户就是要 100% 实时，不接受 batch, 那只能开 cache + 企业 channel:

- 单笔 0.10152 × 0.85 = 0.086 元;
- 一天 86 元，比标准价节省 58%.

也很接近市面价格. cache 是中转站能保证「光明正大便宜」的最大单一来源，没有之一。如果一家中转站完全不支持 cache 字段透传 (有些把 cache_control 字段直接吃掉), 大概率走的是灰色。

工程角度看, 5 件机制的实现复杂度差异很大:

- prompt cache 透传: ~50 行 (字段抽取 + 计费拆分);
- 成本路由 fallback: ~80 行 (按 cost_priority 分层 + 复用 weighted-picker);
- batch 通道: ~100 行 (内存队列 + flush 触发 + supports_batch 路由);
- 渠道倍率: 0 行 (v0.5 已实现，本章只是用起来);
- 企业渠道价差: 0 行 (商务能力，工程零成本).

总共不到 250 行 TS 代码。这就是中转站「成本护城河」的真实体量——不是什么神秘武器，是几张表 + 几个字段 + 严格不破坏 prefix 的纪律。难点不在技术，在「跟上游政策同步迭代」的运营能力。

## 10.11 合规边界的明文化

这一章涉及商业 + 灰色话题，必须把合规边界写清楚，否则容易被误读为「教做灰产」.

**这本书不教**:

- 怎么逆向 Claude Code / Codex CLI / ChatGPT 网页凭据;
- 怎么搭拼车号池;
- 怎么薅退款套利;
- 怎么在网关里偷偷把 GPT-5 路由到 GLM-4-9B.

**这本书教**:

- 怎么把 Anthropic / OpenAI / Gemini / DeepSeek 的官方 cache 折扣透传给上游，让用户拿到合法折扣;
- 怎么把官方 batch API 接口变成网关层的 priority=low 通道;
- 怎么在多个合法 channel 间按价格 fallback;
- 怎么识别上游是否在偷换模型 (防御侧，基于公开的指纹检测方法论).

判断一个机制是不是合规，三条 checklist:

1. **上游 ToS 是否允许**? 拼车违反，退款套利违反，模型替换违反所有家. cache / batch / channel 倍率 / 企业 SKU 都不违反。
2. **价格信息是否公开可查**? Anthropic / OpenAI 的 cache / batch 价目都在官方文档。拼车 / 号池的价目只在地下黑话里。
3. **出问题时谁担责**? 合法机制出问题 (例如上游突然涨价), 损失由中转站运营自己承担。灰色机制出问题 (上游封号 / 政策收紧), 损失推给客户 (突然断供).

读者作为工程师，看一个中转站的官方页面，用这三条 checklist 自己判断。看不到「我们怎么做到便宜的」的明确解释 + 价格低于合法机制极限 + 合同里没有「断供赔偿」条款，大概率有问题。

写这本书的本意是「给工程师写给工程师的、能真正落地的技术书籍」. 落地意味着既能让读者搭出能赚钱的网关，也能让读者识别市场上不可持续的伪低价。两件事是一体两面。

## 10.11.1 调研与测评来源

本章引用的价格机制、合规判断、灰色玩法描述都不是凭空写的，主要源头有几类:

- **上游官方文档**: OpenAI / Anthropic / Google / DeepSeek 各自的 prompt caching 与 batch API 说明页面 (本章 10.2 / 10.3 节列出了具体文档链接), 是判断「这个机制是不是合法 / 单价档位是多少」的第一手依据。
- **企业 SKU 与定价分析**: Azure OpenAI / Vertex AI / Anthropic enterprise pricing 的第三方解读 (cloudzero、costbench、redresscompliance 等), 在 10.6 节列出。
- **中文社区综述**: [gm7.org 灰产专题](https://www.gm7.org/archives/48708) 拆得最透的「四到七毛每刀」成本来源、[虎嗅 2026 年 4 月《AI Token 经济地下供应链曝光》](https://www.huxiu.com/article/4854018.html) 详述四层结构、V2EX `gpt` 节点近期讨论里大量真实用户对中转站价格/封号/换模型的反馈。
- **开源项目 Issues**: one-api / new-api 的 GitHub Issues 里有大量「为什么 X 中转站这么便宜」「Y 中转站突然涨价」的讨论，对照本章 5 件合法机制可以反推出每家中转站的真实成本结构。
- **可直接验证的本地工具**: 本书提供的 `model-fingerprint-cli` 是验证一家中转站是否真实在跑声称模型的最直接方式。任何外部数字 (包括本书引用的。都不如读者自己跑一次本工具拿到的数字可信。

工程师视角的态度。这类灰色市场的数据没有「权威数据源」，一切都在快速变化。本书引用任何具体数字时都给出社区原始链接 (随时可能失效，建议截图备查), 同时把「怎么自己验证」这件事做成可运行的工具: 数字过期了，工具仍然能跑。

## 10.12 v0.10 之后还差什么

v0.10 完成的能力清单:

- prompt caching 透传层 (Anthropic / OpenAI / DeepSeek 三家 usage 字段抽取 + cache 单价计费拆分);
- batch 异步通道 (priority=low + supports_batch=true channel 路由 + 5s 窗口 flush);
- 成本路由 cost_priority 字段 + asc 优先选 + 失败逐档 fallback;
- 渠道倍率 (v0.5 已有) + cost_priority (v0.10 新增。两档分离;
- 企业渠道价差 (零代码, channels 表配置即可);
- 三个独立可运行子工具 (cost-router-demo / prompt-cache-demo / model-fingerprint-cli);
- 5 探针指纹检测 CLI + mock 可疑上游本地复现，让读者能自己审计上游是否在偷换模型。

v0.10 把对外卖 token 场景下的成本护城河立住了。下一道关卡是变现链路。用户如何注册、如何充值、余额如何与请求计费打通、退款如何不出事故、对账如何不出差错。这是把网关从「技术工件」推向「可对外销售产品」的必经环节, v0.11 钱包与支付。

## 配套代码

完整可运行的 v0.10 代码在 `examples/10-why-is-relay-cheaper/`. 目录结构:

```
src/
  optimization/                       # (new) 本章核心新增
    prompt-cache.ts                   # Anthropic/OpenAI/DeepSeek 缓存命中字段抽取 + cache_control 检测
    cost-router.ts                    # 按 cost_priority asc 选最便宜可用 channel + fallback
    batch-channel.ts                  # priority=low 异步队列, 走 supports_batch=true 的 channel
    index.ts                          # barrel
  billing/
    calculator.ts                     # (new) 加 cached_input_tokens / batch_mode, computeFinalCost
    prices.ts                         # (new) ResolvedPrice 加 cache_input/batch_input/batch_output
  channels/
    seed.ts                           # (new) 5 个 mock channel, 不同 cost_priority
    registry.ts                       # (new) ChannelEntry 加 costPriority / supportsBatch
    store.ts                          # (new) CreateChannelInput 加 cost_priority / supports_batch
  index.ts                            # (new) 主路径选 channel 改用 pickCheapestChannel; 抽 cached_tokens
  scripts/
    mock-upstream.ts                  # (new) 模拟 OpenAI cached_tokens 返回 ([CACHED] 触发 80% 命中)
  (其余沿用 v0.9)
drizzle/
  0006_cost_optimization.sql          # (new) 本章新增: channels/prices/usage_records 各加几列
tools/                                # (new) 三个独立子工具
  cost-router-demo/                   #   按 cost_priority 选 channel + fallback 决策日志
  prompt-cache-demo/                  #   Anthropic/OpenAI 缓存命中成本对比
  model-fingerprint-cli/              #   模型指纹检测 CLI (5 探针: self_id / cutoff / tokenizer / refusal / math)
```

启动:

```bash
cd examples/10-why-is-relay-cheaper
cp .env.example .env  # 至少改 ADMIN_TOKEN
npm install
npm run migrate    # 0001/0002/0003/0004/0005/0006, 共 6 份
npm run mock       # terminal 1: 监听 :4010
npm run start      # terminal 2: 监听 :3000
```

跑「同 prompt 不同 priority」的对比:

```bash
# 普通同步, 走 mock-cheap-batch (cost_priority=10), 用 normal 单价
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'

# 加 [CACHED] 前缀, 触发 mock 上游返回 cached_tokens
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"[CACHED] hello"}]}'

# priority=low, 走 batch 通道
curl -sS -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"priority":"low"}'
```

stdout 的 `billing_settled` 这一行能看到 `cached_input_tokens` / `batch_mode` / `final_cost_micro_cny` 的差异。

三个子工具单独跑:

```bash
cd tools/cost-router-demo && npm install && npm start
cd tools/prompt-cache-demo && npm install && npm start
cd tools/model-fingerprint-cli && npm install && npm run mock &
  npx tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o
```

## 下一章预告

v0.10 把对外卖 token 场景下的成本护城河立住了——5 件合法降本机制每一件都有可量化的代码 + 实测数字; 3 件灰色玩法揭原理但不教操作，配合一个 5 探针的指纹检测 CLI 让读者能识别上游是不是在偷换模型。企业基建场景的读者可以挑读「成本路由 fallback」，其余四种合法机制对对外创业必读。

v0.10 之后，网关已经具备了完整的供应链 + 成本护城河，但还差最后一步——变现链路。用户如何注册: 充值的钱怎么进网关账户。余额如何跟每次请求的两阶段计费打通。退款如何不出事故: 对账如何不出差错。这些都不是「成本优化」级别的问题，而是「把技术工件推向可对外销售产品」的必经环节。

第 11 章设计 `wallets / recharges / refunds` 三张表 + `PaymentAdaptor` 抽象接口，与 Ch2 的 `ProviderAdaptor` 形成对称设计: 不接任何具体支付 SDK (合规、地区差异、SDK 升级频繁是放附录的理由), 而是用一个本地 HTTP server 模拟支付平台回调，把「充值幂等」「退款对账」「余额并发扣减」三道核心难题讲透. v0.11 钱包与支付。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
