---
title: 第 5 章 每一分钱的归属
feishu_url: "https://www.feishu.cn/wiki/JRiQwH4qNiIa4OkYSklcp8dLnPh"
last_synced: "2026-05-16T18:28:47"
---

## 5.1 月底账单上的那个无法回答的问题

把 v0.4 跑一个月, 12 个同事拿到的 12 把 `sk-gw-` Key, 在网关上调出去的 OpenAI / DeepSeek / Anthropic 三家累计 8000 多元。账单到了运维 / 财务桌上, 问题就来了:

- 这 8000 在 12 把 Key 之间是怎么分布的? Tom 那把 CI 机器人 Key 一直在轮询, 是不是占了大头?
- 每把 Key 调过哪些模型? gpt-4o 与 gpt-4o-mini 单价差 16 倍, 用错模型可能把账单翻两番;
- input 和 output 各占多少? 主流模型 output 单价通常是 input 的 3-5 倍, 这两个不拆开记永远说不清是 prompt 太长还是回答太长把钱花光的;
- 流式响应那部分有没有记全? 客户端中途 Ctrl+C 关掉对话, 网关到底有没有把已经送出去的 token 算进账?

v0.4 的中间件只记了「请求是否被允许」, 没有任何字段能回答上面四个问题。日志里有 `key_id` 与 `user_id`, 但没有 token、没有金额、没有 input / output 拆解, 月底想拉一张「按用户 / 按模型 / 按业务线」的报表, 只能挨个 grep nginx access log + 手动估算, 还估不准。

这一章要补的就是计费链路: token 计数、价格表、倍率体系、两阶段计费、`UsageRecord` 表落账。落地之后:

- 每次请求都有一条账单, 字段含 trace_id / user_id / key_id / org_id / model / provider / prompt_tokens / completion_tokens / prompt_cost / completion_cost / final_cost / multiplier_snapshot / status;
- 三种维度的聚合查询 SQL (按用户 / 按模型 / 按天) 直接能跑;
- 计费链路在「上游不返 usage」「客户端中途断开」「上游业务错」等边角下都不漏计也不多扣。

`UsageRecord` 是贯穿全书的核心领域对象之三 (截止本章为 3 个: 之一 `IR` (Ch2)、之二 `Key` (Ch4)、之三本章 `UsageRecord`; 之四 `Channel` 由 Ch8 引入)。它在本章建好之后, Ch6 限流的 TPM 维度、Ch7 流式计费闭环、Ch9 看板的按 trace_id 反查、Ch10 成本优化效果对比都会复用同一张表, 不再展开建。

## 5.2 token 怎么算: 本地估算 + 上游回包双路对账

要算钱必须先算 token。token 的来源有两路:

1. **本地估算**: 用 tiktoken 算法把客户端的 messages 跑一遍, 离线得到 prompt token 数;
2. **上游回包**: 调用上游后, 上游在响应体 `usage` 字段里给出真实的 `prompt_tokens` 与 `completion_tokens`。

只用其中一路都有事故风险。

**只用上游 usage** 的问题:

- 上游不一定每次都返 usage。OpenAI 流式响应在没传 `stream_options.include_usage` 时 [刻意省略 usage](https://platform.openai.com/docs/api-reference/chat/streaming) (旧 SDK 没主动开这个选项, 几乎拿不到流式 usage); 部分国产 OpenAI 兼容上游 (尤其老版本) 干脆从不返 usage;
- 流式响应中途断开时, 上游可能在 `[DONE]` 之前就被 TCP RST, 那一刻的 usage 永远拿不到;
- 网络层失败的请求拿不到任何响应体, 但本地估算的 prompt 部分已经发出去了——这部分要不要算钱由网关的退款策略决定;
- 信任问题: 网关跑久了对上游的 usage 数字不能完全无审计接受。如果某家上游悄悄把 prompt_tokens 报高 5%, 没有本地对账就发现不了。

**只用本地估算** 的问题:

- tiktoken 是 OpenAI 公开的 BPE 算法, 对 GPT 系列接近精确, 但对 Anthropic / DeepSeek / Gemini 的真实 tokenizer 是估算, 误差 1-3%; 累积到月度账单是几十到几百元的差异;
- assistant 回复的 token 在没真实调上游之前完全不知道, 只能按 `max_tokens` 上限估;
- 上游收的钱按它自己的 tokenizer 算, 网关收客户的钱如果按本地估算就是「上游收 100 元 / 网关收 97 元」这种偏差, 长期累积会侵蚀毛利。

正确做法是两路都要走, 两个数字分两列存进 `usage_records`, 实结按上游 usage 为准, 月度审计时按 `prompt_tokens - estimated_prompt_tokens` 看 diff 分布。one-api 的 OpenAI Adaptor 把这个思路写得很直接——`relay/adaptor/openai/adaptor.go:113-119` 在流式响应没拿到上游 usage 时, fallback 到本地 tokenizer 估算; 本书把这个 fallback 行为做成显式的双路对账, 两个数字分别落账。

本地估算用 `js-tiktoken` 而不是 `tiktoken` (Rust binding) 的原因:

- `tiktoken` 是 napi-rs 写的 native module, install 时要下预编译二进制或本地 Rust 工具链, 跨平台部署不稳; 而且 Cloudflare Workers 上跑不起来, 与本书后续承诺的「跨 runtime」冲突;
- `js-tiktoken` 是纯 JS 实现, 单文件 npm install 即可, 性能足够 (一条普通消息 < 1 ms, 远低于上游网络延迟);
- 精度上 `js-tiktoken` 与 `tiktoken` 在 cl100k_base / o200k_base 等主流编码上结果一致——前者只是慢一点, 不会算错。

`src/billing/tokenizer.ts` 里的核心实现:

```ts
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

const ENCODERS = new Map<TiktokenEncoding, Tiktoken>();

function getEncoder(name: TiktokenEncoding): Tiktoken {
  let enc = ENCODERS.get(name);
  if (enc) return enc;
  const ranks = name === 'o200k_base' ? o200k_base : cl100k_base;
  enc = new Tiktoken(ranks);
  ENCODERS.set(name, enc);
  return enc;
}

export function estimatePromptTokens(messages: IRMessage[], model: string): number {
  const enc = getEncoder(pickEncoding(model));
  let tokens = 0;
  for (const m of messages) {
    tokens += 4;                       // 消息封装固定开销 (role + 分隔符)
    tokens += enc.encode(m.role).length;
    if (typeof m.content === 'string') {
      tokens += enc.encode(m.content).length;
    } else if (Array.isArray(m.content)) {
      // multimodal: text 段累加; image_url 段固定 85 token (粗估)
      for (const part of m.content) {
        if (part?.type === 'text') tokens += enc.encode(part.text).length;
        else tokens += 85;
      }
    }
  }
  tokens += 2;                          // assistant 回复引导 token (粗估)
  return tokens;
}
```

每条消息有 4 token 的固定封装开销, 这来自 OpenAI 官方 cookbook `num_tokens_from_messages` 的经验值。`pickEncoding(model)` 用 `js-tiktoken` 内置的 model → encoding 映射: GPT-4 / GPT-3.5 类用 `cl100k_base`, GPT-4o / o1 / o3 类用 `o200k_base`, 未知模型兜底 `cl100k_base`。

把 token 算法封装在一个文件里, 后面 Ch7 的流式 streaming-counter 在收到每个 SSE delta 时也调同一个 `estimateCompletionTokens()`, 累加成 output 计数。

## 5.3 价格表: 把上游单价从代码里挪到数据库里

有了 token 数, 还要拿单价才能算钱。网关层的价格表设计核心约束有三:

1. **同一模型不同上游可能不同价**。OpenAI 官方的 `gpt-4o-mini` 与 Azure OpenAI 上的 `gpt-4o-mini` 单价不同; 同一家上游的不同分销渠道也有不同折扣 (Ch8 接入渠道池后会更明显)。因此 `prices` 表的主键不是 model 本身, 而是 `(model, provider)`;
2. **价格会变**。OpenAI 一年至少调三次价, 国内厂商更频繁。改价不能 UPDATE 老行, 否则之前已经发生的请求的 `usage_records` 反查回来就会得到「按新价算」的错误结果。正确做法是给价格行加 `effective_from` / `effective_to` 时间窗, 调价时 INSERT 新行并把老行的 `effective_to` 闭合;
3. **input 与 output 必须分开计价**。主流模型的 output 单价是 input 的 3-5 倍 (因为 generate 比 prefill 贵), 合到一个数算月账时会把 prompt 重的工作负载和 completion 重的工作负载混在一起, 看不出哪类用例更花钱。

把这些约束写进 schema:

```ts
// src/db/schema.ts
export const prices = sqliteTable('prices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  /** input 单价: 微元 / 1M tokens. */
  inputPriceMicroPer1M: integer('input_price_micro_per_1m').notNull(),
  /** output 单价: 微元 / 1M tokens. */
  outputPriceMicroPer1M: integer('output_price_micro_per_1m').notNull(),
  /** 模型自身倍率 (千分位). 例: 某模型成本被运营定为基线 1.2x, 这里写 1200 */
  modelMultiplier: integer('model_multiplier').notNull().default(1000),
  effectiveFrom: integer('effective_from').notNull(),
  effectiveTo: integer('effective_to'),  // null = 仍有效
  createdAt: integer('created_at').notNull(),
});
```

几处工程细节值得展开。

**为什么所有金额都用 integer 而不是 real / float。** SQLite 的 `REAL` 是 IEEE 754 双精度, 经典的 `0.1 + 0.2 !== 0.3` 在算月度账单时会累加成可观的偏差。本书选用「微元」这个单位 (1 元 = 1_000_000 微元), 所有金额字段都是 integer, 累加 / 比较 / 排序都是精确算术。换算成「元」只在边界 (API 输入输出) 做一次乘 / 除。

**为什么单价用「微元 / 1M tokens」**。主流厂商对外公布的写法是 `$0.15 / 1M tokens` 或 `1.05 元 / 1M tokens`。直接对齐这个单位, 价格表填值时不用算 (写 `1.05` 就是 1.05 元 / 1M, 不是「每 token 的金额」)。计算时:

```
cost_micro = tokens × inputPriceMicroPer1M / 1_000_000
```

只有「除 1M」一步, 远比每行存「每 token 价」需要算到 12 位小数稳定。

**为什么 `effective_to` 可以为 null**。null 表示「截至当前仍有效」。调价时, INSERT 新行 + UPDATE 老行的 `effective_to = now`, 一条 SQL 完成时间窗闭合。读价时按 `effective_from <= now AND (effective_to IS NULL OR effective_to > now)` 取行, 同样模型有多行命中时取 `effective_from` 最大的那行 (最近生效优先)。`prices.ts` 的核心查询逻辑:

```ts
export function getCurrentPrice(model: string, provider: string): ResolvedPrice {
  const cached = CACHE.get(`${model}::${provider}`);
  if (cached && cached.expiresAt > Date.now()) return cached.price;

  const rows = db
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.model, model),
        eq(prices.provider, provider),
        lte(prices.effectiveFrom, Date.now()),
        or(isNull(prices.effectiveTo), gt(prices.effectiveTo, Date.now())),
      ),
    )
    .orderBy(desc(prices.effectiveFrom))
    .limit(1)
    .all();

  if (rows.length === 0) throw new PriceNotFoundError(model, provider);
  // ... 缓存写入 ...
}
```

**TTL 60s 进程内缓存**。价格不是每次请求都要查 DB——同一个模型的价格在一分钟内不会有意义地变化。进程内 Map 缓存 60 秒, 改价时 admin 接口主动 `invalidatePriceCache()` 清掉, 避免长尾的「热更新延迟」。

**查不到价格时抛错而不是 fallback**。某些实现会让「价格表查不到时按 0 计费」, 这会产生「免费白嫖」漏洞——新接入一个上游忘了配价, 客户端就能免费消耗。本章直接 throw `PriceNotFoundError`, 主路径捕获后返 400 `price_not_configured` 给客户端, 强制运维补齐价格表。

启动时自动灌入一份默认价格 (`seedDefaultPricesIfEmpty()`), 仅在 `prices` 表为空时执行——避免覆盖运维改过的价。默认值取自 2026 年 5 月各家公开 API 价目, 数字按 1 USD ≈ 7.2 CNY 大致换算。真实运营要按当天汇率 + 上游分销折扣调整, 调用 admin `POST /admin/prices` 热改即可。

## 5.4 倍率体系: 别把策略硬编码进单价

价格表里写的是「上游事实价」, 这部分由运营根据上游官方价目维护。但网关对外卖出去的价钱通常不是这个——大客户会有折扣、某些渠道会加价、某些模型在运营层面被定为「我们要鼓励 / 抑制使用」。

直接改价格表会让两件事混在一起: 「上游真实成本」与「网关侧的定价策略」。运维想知道这个月在 OpenAI 上花了多少时, 翻 `prices` 表得到的是「加完折扣后的对外价」, 还得拿对账单倒推上游事实价, 工程上拧巴。

正确做法是把「定价策略」拆成倍率层, 与单价隔离。本章的倍率体系是三维:

```
final_cost = base_cost
           × (user_multiplier   / 1000)   // 用户折扣 / 加价
           × (channel_multiplier / 1000)  // 渠道加价 (Ch8 渠道池接入)
           × (model_multiplier   / 1000)  // 模型倍率 (运营定的)
```

每个维度都用「千分位 integer」表示, 1000 = 1.0x = 不调整。这套写法的好处:

- **整数乘法不掉精度**。三个倍率相乘是九位 integer, 再除以 `1_000_000_000` 才转成 float 乘到 cost 上;
- **范围足够**: 0.001x ~ 10x 在教学场景足够, 极端情况 (例如某 VIP 客户给 5 折, 某加急通道加 50%) 都能表达;
- **存储紧凑, 索引友好**: 整数列在 SQLite / Postgres 上都比 float 紧凑。

`src/multiplier/registry.ts` 的核心实现:

```ts
export function resolveMultiplier(ctx: MultiplierContext): CombinedMultiplier {
  const userRows = db
    .select({ m: users.userMultiplier })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .all();
  const userMul = userRows.length > 0 ? userRows[0]!.m : MULTIPLIER_SCALE;

  const price = getCurrentPrice(ctx.model, ctx.provider);
  const modelMul = price.modelMultiplier;

  // v0.5: 渠道倍率写死 1000. Ch8 渠道池接入后从 channels 表读
  const channelMul = MULTIPLIER_SCALE;

  const combined = userMul * channelMul * modelMul;
  return {
    user: userMul,
    channel: channelMul,
    model: modelMul,
    combinedScale1e9: combined,
    combinedFloat: combined / (MULTIPLIER_SCALE * MULTIPLIER_SCALE * MULTIPLIER_SCALE),
  };
}
```

注意 `combinedScale1e9` 这个字段——它会原样落进 `usage_records.multiplier_snapshot`, 作为「这次请求当时生效的倍率快照」。**倍率不能用指针存**, 必须存当时的数值, 否则运营三个月后调一次某用户的折扣, 历史账单跟着改, 财务对账直接乱掉。这是新手最容易踩的坑。

对照 one-api 的设计, 区别可以看清:

| 维度 | one-api | 本书 v0.5 |
|------|---------|----------|
| 价格表 | Go map 编译进二进制 (`relay/billing/ratio/model.go:13`) | DB 表, 时间窗 + 热加载 |
| 单价单位 | hardcode `1 == $0.002 / 1K tokens` (魔法常量) | 微元 / 1M tokens (与厂商公开价目对齐) |
| 倍率维度 | modelRatio × groupRatio (二维) | user × channel × model (三维) |
| 倍率存储 | float64 内存常量 | integer 千分位, 入账时快照 |
| 调价 | 改源码 + 重启 | `POST /admin/prices` 热加载 |
| input/output 拆分 | 用 completionRatio 把 output 乘 2-5x | 直接两个独立单价 |

new-api 在这一点上更激进——它用 `pkg/billingexpr/` 表达式计费, 每个模型挂一个 `tier("base", p * 2.5 + c * 15 + cr * 0.3 + img * 5)` 的表达式, cache token / image token / audio token 独立定价。这套设计是真正的「策略与单价解耦的终态」——倍率被「表达式系数」直接表达, 不再需要分离的 multiplier 字段。本书 v0.5 不引入这个复杂度, 留到 Ch10 成本优化章; 但 `prices` 表的 schema 已经向这个方向预留, 后续替换为表达式只需要加一个 `expression text` 字段。

`one-api` 把 modelRatio 写在 Go 源码 map 里 (`relay/billing/ratio/model.go:11-16`), 改一次价要全员同步代码 + 重启服务, 在「商业网关」语境下是工程负担。本书一开始就把价格放 DB, 也是为了让读者改价像改任何业务数据一样轻量。

## 5.5 两阶段计费: preConsume 与 postConsume

把价格表、token 算法、倍率三件事拼起来, 计费的核心就出来了——它要被嵌进主路径, 而且要分成两个阶段。

**单阶段「先扣后调」的事故风险**。直觉上, 计费应该「在上游返回后, 按真实 usage 算钱, 扣余额」。这套流程在 99% 的请求上是对的, 但在余额边界附近会出事故:

- 客户 A 余额 0.01 元;
- 提交了一个 prompt 长度 = 2000 token, max_tokens = 4000 的请求;
- 网关在「上游返回前」不扣钱, 直接调上游;
- 上游算 8000 token (`prompt + completion`), 收 0.5 元;
- 网关回头扣 A 的余额, 余额变 -0.49 元——但客户本来不该有透支额度。

更糟的场景是流式: 上游已经返了 3000 个 token, 客户端中途断开, 上游不再继续生成。如果网关只在「响应完成」时扣钱, 客户端这个断开行为会让这次请求消耗的 3000 token 永远不会被扣到 A 的账上——A 白嫖了。

正确做法是「先扣后调」改成两阶段:

```
preConsume:
  1. 用 tiktoken 算 estimated_prompt_tokens
  2. 用 request.max_tokens (或 DEFAULT_MAX_TOKENS=4096) 当 output 上限
  3. 按当前价格 + 倍率, 算出预扣金额 (向上取整, 防止四舍五入少扣 1 微元)
  4. 用乐观锁扣余额: UPDATE WHERE balance >= cost
     失败 = 余额不够, 返 402 不进上游
  5. 写一行 usage_records, status = reserved

(主路径调上游)

postConsume / refundReservation (二选一):
  - 调上游成功: 按真实 usage 重算 final_cost, 多退少补
                UPDATE balance += (preReserved - finalCost)
                usage_records SET status = finalized
  - 调上游失败 (网络错 / 业务错): 全额退回预扣
                UPDATE balance += preReserved
                usage_records SET status = refunded
```

`src/billing/calculator.ts` 的 preConsume 核心代码:

```ts
export function preConsume(input: PreConsumeInput): PreConsumeOutput {
  // 1. 本地估算 prompt tokens
  const estimatedPromptTokens = estimatePromptTokens(input.messages, input.model);

  // 2. 取当前价格 + 三合一倍率
  const price = getCurrentPrice(input.model, input.provider);
  const mul = resolveMultiplier({
    userId: input.userId, model: input.model, provider: input.provider,
  });

  // 3. 预扣金额 = (prompt × inputPrice + max_output × outputPrice) × 倍率
  const baseCost =
    estimatedPromptTokens * price.inputPricePerToken +
    input.maxOutputTokens * price.outputPricePerToken;
  const preReservedCost = Math.ceil(baseCost * mul.combinedFloat);

  // 4. 乐观锁扣余额: UPDATE WHERE balance >= cost
  const updated = db
    .update(users)
    .set({ balanceMicro: sql`${users.balanceMicro} - ${preReservedCost}` })
    .where(sql`${users.id} = ${input.userId} AND ${users.balanceMicro} >= ${preReservedCost}`)
    .returning({ balance: users.balanceMicro })
    .all();
  if (updated.length === 0) {
    throw new InsufficientBalanceError(preReservedCost, /* ... */);
  }

  // 5. 写入 usage_records 占位 (status = reserved)
  const rows = db.insert(usageRecords).values({
    traceId: input.traceId,
    userId: input.userId, orgId: input.orgId, keyId: input.keyId,
    model: input.model, provider: input.provider,
    estimatedPromptTokens,
    preReservedCost,
    multiplierSnapshot: mul.combinedScale1e9,
    status: 'reserved',
    isStream: input.isStream,
    createdAt: Date.now(),
  }).returning({ id: usageRecords.id }).all();

  return { recordId: rows[0]!.id, preReservedCost, estimatedPromptTokens };
}
```

注意第 4 步的「乐观锁」: `UPDATE ... WHERE balance >= cost` 配合 `.returning()` 是 **单条 SQL 完成的「检查并扣减」**, 两个并发请求不会都成功扣穿。如果用「先 SELECT 后 UPDATE」, 高并发下会出现「读到余额 100, 决定扣 80, UPDATE 时余额已经被另一个并发请求扣到 30, 还是把它扣成负数」这种竞态。一个 SQL 原子完成, 失败时 `updated.length === 0`, 直接抛 `InsufficientBalanceError`。

postConsume 的实现:

```ts
export function postConsume(input: PostConsumeInput): PostConsumeOutput {
  const price = getCurrentPrice(input.model, input.provider);
  const mul = resolveMultiplier({ userId: input.userId, ... });

  const promptCost = Math.ceil(input.realPromptTokens * price.inputPricePerToken * mul.combinedFloat);
  const completionCost = Math.ceil(input.realCompletionTokens * price.outputPricePerToken * mul.combinedFloat);
  const finalCost = promptCost + completionCost;

  // 多退少补: balanceDelta = preReserved - finalCost
  //   > 0: 退回, balance += delta
  //   < 0: 少扣的部分再扣
  const balanceDelta = row.preReservedCost - finalCost;
  if (balanceDelta !== 0) {
    db.update(users)
      .set({ balanceMicro: sql`${users.balanceMicro} + ${balanceDelta}` })
      .where(eq(users.id, input.userId)).run();
  }

  db.update(usageRecords).set({
    promptTokens: input.realPromptTokens,
    completionTokens: input.realCompletionTokens,
    promptCost, completionCost, finalCost,
    status: 'finalized', finalizedAt: Date.now(),
  }).where(eq(usageRecords.id, input.recordId)).run();

  return { recordId, promptCost, completionCost, finalCost, balanceDelta };
}
```

`balanceDelta = preReserved - finalCost` 这个符号方向值得展开说一下。one-api 的 `postConsumeQuota` (`relay/controller/helper.go:97-141`) 用的是 `quotaDelta = quota - preConsumed`, 然后 `PostConsumeTokenQuota(tokenId, quotaDelta)` 把这个 delta 「再扣」一次。本书的 `balanceDelta = preReserved - finalCost` 符号是相反的, 意思是「应该回退给用户多少」。两套实现语义等价, 但「多退少补」的视角在余额模型里读起来更直接。

refundReservation 处理上游失败时的全额退回:

```ts
export function refundReservation(recordId: number, errorMessage?: string): void {
  // ... 取 record ...
  if (row.status !== 'reserved') return;  // 幂等

  db.update(users)
    .set({ balanceMicro: sql`${users.balanceMicro} + ${row.preReservedCost}` })
    .where(eq(users.id, row.userId)).run();
  db.update(usageRecords).set({
    status: 'refunded', finalCost: 0, finalizedAt: Date.now(),
    errorMessage: errorMessage ?? null,
  }).where(eq(usageRecords.id, recordId)).run();
}
```

「上游失败时退全款」的策略是网关层的业务选择, 不是工程必须。one-api 的处理是: 上游网络错时同样退回预扣 (`relay/billing/billing.go:11-21::ReturnPreConsumedQuota`), 但上游业务错 (4xx) 时仍然按真实 usage 扣费 (因为上游已经处理了 prompt, 算力已经消耗)。本书 v0.5 简化为「只要客户端没拿到 200, 都退全款」, 实务上对小型自建网关足够; 真要做对外卖 token 的商业网关, 应该按 one-api 的细分策略走。

## 5.6 主路径接入两阶段计费

把 preConsume / postConsume / refund 接到 `/v1/chat/completions` 主路径——核心是「主路径只负责调度三个函数 + 处理错误分支」, 函数体已在 §5.5 定义好, 这里不重复:

```ts
// src/index.ts (主路径骨架, 完整入参见仓库)
app.post('/v1/chat/completions', requireGatewayKey, async (c) => {
  const auth = c.get('auth');
  const ir = /* ... zod 校验 ... */;
  const adaptor = router.resolve(ir.model);

  // ----- 1) preConsume: 估 token + 扣余额 + 写 reserved 记录 -----
  let reservation;
  try {
    reservation = preConsume({ /* traceId / auth / ir / adaptor */ });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return c.json({ error: { type: 'insufficient_quota' } }, 402);
    if (err instanceof PriceNotFoundError) return c.json({ error: { type: 'price_not_configured' } }, 400);
    throw err;
  }

  // ----- 2) 调上游: 网络错 / 业务错都触发 refund -----
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    refundReservation(reservation.recordId, `network_error: ${err.message}`);
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }
  const rawBody = await upstreamResp.text();
  if (!upstreamResp.ok) {
    refundReservation(reservation.recordId, `upstream_${upstreamResp.status}`);
    return new Response(rawBody, { status: upstreamResp.status });
  }

  // ----- 3) postConsume: 用上游 usage (或本地 fallback) 实结 -----
  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  try {
    postConsume({
      recordId: reservation.recordId,
      realPromptTokens: irResponse.usage?.prompt_tokens ?? reservation.estimatedPromptTokens,
      realCompletionTokens: irResponse.usage?.completion_tokens
        ?? estimateCompletionTokens(irResponse.choices?.[0]?.message?.content ?? '', ir.model),
      /* userId / model / provider */
    });
  } catch (err) {
    markFailed(reservation.recordId, err.message);
  }
  return c.json(irResponse, 200);
});
```

几个分支值得点明:

**preConsume 抛 `InsufficientBalanceError` → 402**。402 Payment Required 是 HTTP 语义专门留给「钱不够」的状态码, OpenAI 自己用的也是它 (`insufficient_quota`)。客户端 SDK 看到 402 应该停止重试 (重试只会让账单更负), 与 429 区分开。

**preConsume 抛 `PriceNotFoundError` → 400**。这是「网关运维侧配置缺失」的信号——客户端调了一个模型, 但 admin 没在 `prices` 表里配价。直接返 400 强制运维补齐, 比「按 0 计费悄悄白嫖」安全得多。

**网络错 → refund 全款**。fetch 抛异常意味着 TCP 层都没握上手, 上游没消耗任何算力, 100% 退。

**上游业务错 (4xx / 5xx) → refund 全款 + 透传上游 body**。上游业务错的语义复杂——4xx 是请求格式不对, 上游确实没真消耗算力; 5xx 是上游内部错, 算力可能消耗了一半。本书 v0.5 简化处理: 都按 refund 处理, 把上游的错误响应原样透传给客户端 (客户端在错误体里能看到具体错原因)。

**postConsume 自身抛错 → markFailed**。这是 DB 写不进去之类的内部故障, 不该影响主响应; usage_records 行被标 `status = failed`, 余额已经在 preConsume 阶段扣了, 留待人工对账。这种边角在实践中极少发生 (单机 SQLite 不挂的话), 但保留这条分支是为了让 status 机闭合: `reserved → finalized | refunded | failed` 三个终态各有对应触发条件。

**上游不返 usage → 双路对账兜底**。`irResponse.usage` 为 undefined 时 (部分国产 OpenAI 兼容上游会这样), 用 preConsume 阶段算出的 `estimatedPromptTokens` 当 prompt 数, 对 `message.content` 跑一次 `estimateCompletionTokens()` 当 completion 数。日志里会写 `billing_settled_no_upstream_usage` 警告, 运维可以按这个日志统计上游报告 usage 的可靠性。

## 5.7 UsageRecord 表的字段设计

`usage_records` 是本章的「账单存档」, 也是后续 Ch9 看板按 trace_id 反查的入口表。字段挑得不多但每个都有原因:

```ts
export const usageRecords = sqliteTable('usage_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  traceId: text('trace_id').notNull(),     // unique index, 32 字符 hex
  userId: integer('user_id').notNull(),
  orgId: integer('org_id').notNull(),
  keyId: integer('key_id').notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  estimatedPromptTokens: integer('estimated_prompt_tokens').notNull().default(0),
  promptCost: integer('prompt_cost').notNull().default(0),
  completionCost: integer('completion_cost').notNull().default(0),
  finalCost: integer('final_cost').notNull().default(0),
  preReservedCost: integer('pre_reserved_cost').notNull().default(0),
  multiplierSnapshot: integer('multiplier_snapshot').notNull().default(1_000_000_000),
  status: text('status').notNull().default('reserved'),
  isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
  finalizedAt: integer('finalized_at'),
});
```

**`trace_id` 单独 unique index**。每次请求一个 trace_id, 32 字符 hex 全局唯一。Ch9 看板的「按 trace_id 反查全链路」直接走这个索引, P99 在百万行表上仍是亚毫秒级。

**`userId / orgId / keyId` 三个归因维度**。看起来冗余 (keyId 已经能定位到 userId / orgId), 但反范式存储是故意的——后续按 org 出账单的 SQL 直接 `WHERE org_id = ?`, 不用 join `keys` 与 `users` 两次。one-api 的 `Log` 表用的也是同一套反范式 (`model/log.go:17-28` 同时存 `UserId / Username / TokenName / ChannelId`), 高频聚合查询场景下省 join 的工程价值大于「写时多几个字段」。

**input / output 拆开成 4 列**: `promptTokens / completionTokens / promptCost / completionCost`。运维要回答「output 太长了还是 prompt 太长了」时直接看 cost 拆分, 不用反推。这是相对 one-api 单一 `Quota` 字段最直接的工程改进。

**`estimatedPromptTokens` 独立列**。本地估算与上游回包并存, 月度审计时 `WHERE ABS(prompt_tokens - estimated_prompt_tokens) > 10` 能找到「估算偏差大」的请求, 用来评估 tokenizer 精度或上游 usage 可靠性。

**`multiplierSnapshot` 不是指针, 是当时的数值**。`user × channel × model` 三个千分位 integer 相乘得到的 9 位数 (1_000_000_000 = 1.0x), 一次性存进去。后续运营改用户折扣, 历史账单一行不动, 财务对账永远能拿到当时的真实倍率。

**`status` 状态机**: `reserved → finalized | refunded | failed`。每个终态对应不同处理路径:

- `reserved`: preConsume 写入即此状态, 等待 postConsume / refund 收尾。生产环境应当有定时任务扫描超过 N 分钟仍是 reserved 的行 (说明进程挂了未收尾) 主动 refund 之, v0.5 简化不做。
- `finalized`: postConsume 成功, 真实 usage / cost 都已写入。
- `refunded`: 上游失败, 预扣已全额退回, finalCost = 0, errorMessage 填上失败原因。
- `failed`: postConsume 自身异常, 预扣已扣, 留待人工对账 (`errorMessage` 写明原因)。

**索引设计**: 除了 `trace_id` 的 unique index, 还建了 `(user_id, created_at)` / `(key_id, created_at)` / `(model, created_at)` 三个复合索引——对应「按用户按时间」「按 Key 按时间」「按模型按时间」三种最高频的聚合查询。索引列顺序把 high-cardinality 列放前面, 让 query planner 在 `WHERE user_id = ? AND created_at >= ?` 时能走 index range scan。

## 5.8 流式 token 计数: 边收边算的 API 形态

本章不开启 stream=true (主路径直接 400), 但 StreamingTokenCounter 的 API 设计在此就位, 因为它的契约跨章节、与非流式完全不同。Ch7 SSE 透传层直接 import 本节的类, 不会再重新设计接口。

流式计费的核心 API 在本章就要建好的另一个原因: 它的边角处理 (客户端中途断 / 上游 usage 字段晚来 / 多退少补) 与非流式完全不同, 留到 Ch7 一起出会让 Ch7 既要讲 SSE 又要讲计费, 反而失焦。

流式计费的核心约束: **客户端可能中途断开**。已经发出去的 token 必须算钱 (上游已经消耗了对应的算力), 没发出去的 token 不算。这要求计费层在「流没结束」时就能拿到「已发出的 token 数」, 因此必须边收边算, 不能等流结束。

`src/billing/streaming-counter.ts` 提供的 API 形态:

```ts
export class StreamingTokenCounter {
  private upstreamPromptTokens: number | null = null;
  private upstreamCompletionTokens: number | null = null;
  private localCompletionText = '';
  private localCompletionTokens = 0;
  private aborted = false;

  constructor(model: string, fallbackPromptTokens: number) {
    this.model = model;
    this.fallbackPromptTokens = fallbackPromptTokens;
  }

  /** 收到一段 completion 文本 delta. 累加本地估算 */
  ingestDelta(deltaText: string): void {
    if (!deltaText) return;
    this.localCompletionText += deltaText;
    this.localCompletionTokens += estimateCompletionTokens(deltaText, this.model);
  }

  /** 上游送了 usage 事件 (OpenAI stream_options.include_usage / Anthropic message_delta.usage) */
  ingestUsage(usage: { prompt_tokens?: number; completion_tokens?: number }): void {
    if (typeof usage.prompt_tokens === 'number') this.upstreamPromptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number') this.upstreamCompletionTokens = usage.completion_tokens;
  }

  /** 客户端中途取消时调一次 */
  markAborted(): void {
    this.aborted = true;
  }

  /** 流结束 (含中断) 时返回最终 token 数, 喂给 postConsume */
  finalize(): StreamingFinalize {
    const promptTokens = this.upstreamPromptTokens ?? this.fallbackPromptTokens;
    const completionTokens = this.upstreamCompletionTokens ?? this.localCompletionTokens;
    return { promptTokens, completionTokens, abortedByClient: this.aborted };
  }
}
```

设计点逐条说明。

**双路并存**: `upstreamUsage` 优先, `localCompletionTokens` 兜底。上游送 usage 时 (OpenAI 的 stream_options.include_usage 在最后一个 chunk 里给; Anthropic 在 `message_delta` 事件里持续更新), `ingestUsage()` 把它存下来。`finalize()` 时优先用上游值, 没上游值就用本地估算累加结果。

**`ingestDelta()` 增量 encode**。每个 delta 单独跑一次 `estimateCompletionTokens(deltaText)`, 累加到 `localCompletionTokens`。比「每次都对全文 encode 一次」省 O(N²) 算力, 极少数情况下与「全文 encode」结果差 1-2 token, 在计费场景下完全可以接受 (`postConsume` 用上游 usage 修正)。

**`markAborted()` 幂等**。客户端断开时主循环可能在多处调它 (close 事件 / abort signal 触发 / cleanup finally), 设计成幂等避免多次调出问题。

**finalize 的契约**: 流结束 (正常 `[DONE]` 或客户端中断) 时, 主循环必须在 try/finally 或 abort 监听里调一次 `finalize() + postConsume()`, 否则 reserved 行永远停在 reserved 状态, 余额一直被压住。这是 Ch7 SSE 透传章必须正确实现的关键约束, 本章先把 API 立起来。

one-api 的流式 token 累计逻辑分散在每个 adaptor 的 StreamHandler 里 (例如 `relay/adaptor/anthropic/main.go:287-290` 在 `message_delta` 事件里读 `usage.input_tokens / output_tokens` 累加), 每家上游一份, 没有抽象统一的「流式计数器」。本书把这件事抽成独立的 `StreamingTokenCounter` 类, Ch3 已经写好的「Anthropic 流式六事件归一化器」会在 Ch7 把归一化后的事件统一喂给它, 不再每家上游各写一遍。

## 5.9 三种聚合查询: 月底报表的 SQL

`usage_records` 表设计完毕, 三种最高频的聚合查询的 SQL 直接能跑。

**按用户出账 (今天)**:

```sql
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
```

`status = 'finalized'` 过滤掉 reserved / refunded / failed 三类行——只有 finalized 是真正发生了消费的请求。`/ 1_000_000.0` 把微元转回元 (浮点除法只用在最终展示, 累加全程是 integer)。

**按模型 (本月)**:

```sql
SELECT
  model, provider,
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
```

注意 `prompt_cost` 与 `completion_cost` 分别汇总——这是 v0.5 比 one-api `Log` 表多出来的关键能力。看月度报表时能直接看出「这个模型上, prompt 占总成本多少 / completion 占多少」, 进而判断是 prompt 太长还是回答太长更值得优化。

**按天**:

```sql
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

SQLite 的日期函数有点啰嗦——`created_at` 是 unix ms, 要除 1000 转 unix s 后再 `datetime(..., 'unixepoch')` 转成日期字符串。换到 Postgres 这段 SQL 要改 (`to_timestamp(...)::date`), Drizzle ORM 的方言抽象在这里能省心。

后续 Ch9 看板章会基于这三条 SQL 做更丰富的视图 (Top 10 高消耗 Key、按时段的曲线图、错误率 Top 5 等); v0.5 先把数据底盘建好, 看板留到那时再做。

## 5.10 端到端验证

跑一遍完整链路。先按 v0.4 的方式起服务、签 Key, 然后看本章新增的账单链路:

```bash
cd examples/05-who-spent-my-money
cp .env.example .env
# 改 ADMIN_TOKEN; 上游 Key 暂时留 sk-replace-me (本章主要看计费链路, 上游失败属于预期)
npm install
npm run dev
```

启动日志:

```
INFO db_migrations_applied applied=["0001_init.sql","0002_billing.sql"]
INFO default_prices_seeded inserted=10
INFO Gateway v0.5 listening on http://localhost:3000
```

注意 `db_migrations_applied applied=["0001_init.sql","0002_billing.sql"]`——两份 migration 都应用了, 第二次启动 applied 会变空 (`__drizzle_migrations` 表已记录), 不重复执行。`default_prices_seeded inserted=10` 表示十条默认价格被灌入 `prices` 表, 涵盖 gpt-4o-mini / gpt-4o / o1-mini / o3-mini / deepseek-chat / deepseek-reasoner / claude-3-5-sonnet / claude-3-5-haiku / claude-3-opus / gpt-4-turbo。

建 org + user (注意 user 默认拿到 `INITIAL_BALANCE_CNY = 100` 元余额) + 签 Key:

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -s -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme Inc"}'
# {"id":1,"name":"Acme Inc","disabledAt":null,"createdAt":...}

curl -s -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
# {"id":1,"orgId":1,"name":"alice","balanceMicro":100000000,"userMultiplier":1000,...}

KEY=$(curl -s -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"smoke"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
```

`balanceMicro:100000000` 即 100 元 × 1_000_000 微元 / 元 = 1 亿微元。`userMultiplier: 1000` 是 1.0x 基线。

调一次网关 (上游会失败, 但 preConsume 会触发):

```bash
curl -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello world, this is a test message for billing"}]}'
# {"error":{"message":"upstream network error"}}
```

看账单:

```bash
curl -s "$BASE/admin/usage?userId=1" -H "Authorization: Bearer $ADMIN_TOKEN"
```

预期输出:

```json
{
  "data": [{
    "id": 1,
    "traceId": "dfa123480dcd949104eb0e6c18f74672",
    "userId": 1, "orgId": 1, "keyId": 1,
    "model": "gpt-4o-mini", "provider": "openai",
    "promptTokens": 0, "completionTokens": 0,
    "estimatedPromptTokens": 17,
    "promptCost": 0, "completionCost": 0, "finalCost": 0,
    "preReservedCost": 17713,
    "multiplierSnapshot": 1000000000,
    "status": "refunded",
    "isStream": false,
    "errorMessage": "network_error: fetch failed",
    "createdAt": ..., "finalizedAt": ...
  }]
}
```

可以看到完整链路兑现:

- `estimatedPromptTokens: 17`: tiktoken 算出来的 17 个 input token (实际包含 4×消息开销 + 角色 + 内容 + 2 回复引导 ≈ 17);
- `preReservedCost: 17713`: 预扣 17713 微元 ≈ 0.0177 元。算式: `(17 × 1050000/1M + 4096 × 4320000/1M) × 1.0` 微元 ≈ 17713;
- `status: refunded`: 上游网络错触发了 `refundReservation`, 17713 微元已经退回用户余额;
- `errorMessage: "network_error: fetch failed"`: 退款时把失败原因留档, 便于运维事后审计;
- `finalCost: 0`: refund 状态下不计费;
- `multiplierSnapshot: 1000000000`: 三合一倍率快照 1.0x × 1.0x × 1.0x。

验证余额没变 (依然 100 元):

```sql
SELECT id, name, balance_micro FROM users;
-- 1 | alice | 100000000  (一亿微元 = 100 元, 没动)
```

把余额改小, 触发余额不足 402:

```bash
curl -s -X POST $BASE/admin/users/1/balance -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"setCny":0.001}'

curl -i -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

```
HTTP/1.1 402 Payment Required
{"error":{"type":"insufficient_quota","message":"balance is not enough to cover the reservation","required_micro_cny":17704,"available_micro_cny":1000}}
```

402 + 携带「需要多少 / 当前多少」, 客户端 SDK 看到这条能直接判断需要充值多少。注意这个 402 是 preConsume 阶段的乐观锁 UPDATE 失败抛出的——单条 SQL 完成判断, 不会出现「读到余额 X 后决策, UPDATE 时余额已经被另一并发改了」的竞态。

如果真把上游 Key 填上, 调一次正常请求, 账单会变成:

```json
{
  "promptTokens": 17,
  "completionTokens": 23,
  "estimatedPromptTokens": 17,
  "promptCost": 18,
  "completionCost": 99,
  "finalCost": 117,
  "preReservedCost": 17713,
  "status": "finalized",
  "finalizedAt": 1715750999999
}
```

可以看到 `preReservedCost: 17713` (按 4096 max_tokens 预扣) 与 `finalCost: 117` 之间相差悬殊——这就是「预扣 → 实结 → 多退少补」: 17713 - 117 = 17596 微元 ≈ 0.0176 元退回了用户余额。

`token_diff = prompt_tokens - estimated_prompt_tokens` 这条信息在日志里也会输出, 长期累积可以看 tiktoken 与上游 tokenizer 的偏差是不是稳定; 偏差忽然变大可能意味着上游悄悄换了 tokenizer 或 prompt 处理逻辑。

## 5.11 v0.5 之后还差什么

v0.5 完成的能力清单:

- 每次请求都有完整账单, trace_id / user / model / token / cost / multiplier 全字段;
- 价格表与倍率体系彻底分离, 价格热加载, 倍率三维组合;
- 两阶段计费保证余额边界不出事故, 上游失败全额退回, postConsume 多退少补;
- 流式计费的核心 API 就位, Ch7 SSE 透传章直接接入;
- 三种聚合维度 (按用户 / 按模型 / 按天) 的 SQL 直接能跑。

但 v0.5 暴露的下一道工程缺口同样明显。把场景拉到月底, 看这条 SQL:

```sql
SELECT key_id, COUNT(*) AS req, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
FROM usage_records
WHERE created_at >= strftime('%s','now','-1 day') * 1000
GROUP BY key_id
HAVING req > 10000
ORDER BY req DESC;
```

如果有一行 `key_id = 7 req = 50000 first_seen - last_seen ≈ 10 分钟`——那是某把 Key 在 10 分钟内打了 5 万次请求。这种失控行为 (脚本死循环 / 客户端没加退避 / 被恶意盗用) 在 v0.5 下网关算得清账, 但拦不住——余额够就一直放过, 余额耗尽再拦, 但「这 10 分钟里上游配额已经被打爆」「其他用户跟着遭殃」的事实已经发生了。

Ch6 要补的就是限流: 按 API Key / 用户 / 模型多维度做 QPS 与 TPM 双重限流, 配合每月配额上限。QPS 用滑动窗口算法 (内存实现, 参考 Portkey 的 in-memory 模式), TPM 直接复用 v0.5 建好的「预扣 + 实结」两阶段思路 (请求开始按 max_tokens 预扣 TPM 额度, 结束按真实 usage 回填)。也就是说, Ch5 建的计费链路在 Ch6 不仅承担算钱的职责, 还要承担流量整形的职责——这是把「能算」推向「能控」的下一步。

## 配套代码

完整可运行的 v0.5 代码在 `examples/05-who-spent-my-money/`, 目录结构:

```
src/
  index.ts                  # Hono 入口, 主路径接入两阶段计费
  db/
    schema.ts               # (new) users 加 balance + multiplier; 新增 prices / usage_records
    migrate.ts              # 与 v0.4 一致
    client.ts               # 与 v0.4 一致
  billing/                  # (new) 本章新增
    prices.ts               # 价格表 + TTL 缓存 + 默认价灌库
    tokenizer.ts            # js-tiktoken 本地估算
    calculator.ts           # preConsume / postConsume / refund 三段式
    streaming-counter.ts    # 流式 token 计数器 (Ch7 接入 SSE 主循环)
    record.ts               # UsageRecord 查询辅助
  multiplier/
    registry.ts             # (new) user × channel × model 三合一倍率
  auth/                     # 与 v0.4 一致
  admin/
    routes.ts               # (new) 扩展: 调余额 / 改倍率 / 列价格 / 改价 / 查账单
  cli/
    issue-key.ts            # (new) 改动: 创建 user 时给初始余额
  adaptors/                 # 与 v0.4 一致
  streaming/                # 与 v0.4 一致
  types/                    # 与 v0.4 一致
  router.ts                 # 与 v0.4 一致
drizzle/
  0001_init.sql             # 与 v0.4 一致
  0002_billing.sql          # (new) 本章新增
```

按 README 指引 `npm install && npm run dev` 即可起服务, 启动会自动跑两份 migration 并灌入默认价格。`npm install` 会装 `js-tiktoken` (纯 JS 单文件, 无 native binding), 编译 `better-sqlite3` 沿用 v0.4 的工具链。

## 下一章预告

v0.5 之后, 网关从「能拦」走到「能算」: 每一分钱都能归因到具体的 Key、用户、模型、input/output 拆分, 流式场景的计费 API 也已就位等 Ch7 接入。但 v0.5 没回答「同一把 Key 短时间内打爆上游配额怎么办」——账单算得再清楚, 也防不住失控的客户端在 10 分钟内打 5 万次请求, 把上游配额耗光、影响所有其他用户。

第 6 章把分层限流补上: 按 API Key / 用户 / 模型多维度做 QPS 与 TPM 双重限流, 配合每月配额上限。QPS 用滑动窗口算法 (内存实现, 参考 Portkey 的 in-memory 模式), TPM 复用本章建好的「预扣 + 实结」两阶段思路——请求开始按 `max_tokens` 预扣 TPM 额度, 结束按真实 usage 回填。Ch5 建的 calculator 模块在 Ch6 不再只算钱, 还要承担流量整形的职责。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
