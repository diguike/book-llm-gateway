---
title: 第 8 章 渠道池与故障转移
feishu_url: "https://www.feishu.cn/wiki/PFx8wsVwMiGtQpkpa9scn4Uinkf"
last_synced: "2026-05-16T18:29:02"
---

## 8.1 v0.7 之后还差一根备份线路

v0.7 把流式响应跑通了，但全网关挂在一根细线上。整套配置只有一把上游 Key. 几种典型场景下这根线立刻断:

- **上游风控**. OpenAI / Anthropic / DeepSeek 都有自动风控。触发条件可能是「短时间内大量请求来自同一个 API Key」「请求 prompt 命中违规关键词」「账号绑定的支付方式被拒」，上游立刻返 401, body 里写 `account has been deactivated` 或 `your access was terminated`. 网关后续每一个请求继续命中同一把 Key, 继续 401, 直到运维手动改 `OPENAI_API_KEY` + 重启。
- **维护窗口**. OpenAI us-east-1 有过几次维护，持续 30 分钟到 2 小时，期间 5xx 大量出现。网关把 502 透给客户端，业务方电话打爆。
- **账户 TPM / RPM 限速**. 上游每个账号都有分钟级配额。单 Key 打满之后返 429, 后续请求继续 429. 网关没有「切到另一把 Key」的逻辑，客户端拿不到任何响应。

这三种故障的共同特征。故障源在「单一资源」(一把 Key / 一个 provider) 层面，而网关只有这一根线路。在企业基建场景下意味着所有内部用户被影响，在对外卖 token 场景下意味着 SLA 违约。半夜被叫起来的工单基本就是这一类。

v0.8 的目标只有一句话: **同一个 model 背后挂多个 channel, 一个挂了自动切**. 围绕这件事衍生出几个具体问题:

1. 「同一个 model 背后多个 channel」需要一种数据模型。同 provider 多 Key 的场景 (一个 OpenAI 账号挂多把 Key) 与 不同 provider 等价模型的场景 (gpt-4o-mini 可以用官方，也可以用 Azure OpenAI, 也可以用第三方代理。必须在同一套模型里统一表达;
2. 「自动切」需要一个判定: 上游响应里什么样的错算「这条线路死了，切走」，什么样的错算「客户端的错，不切」. 这是错误分类器;
3. 「死了的线路」不能永远死。上游风控可能 5 分钟后放开，限速过了 1 分钟就过。需要后台 worker 定期探活，死而复生;
4. 「同 model 多 channel」中怎么挑一个。简单轮询不够，实际项目里运营要按 priority + weight 控制流量配比 (主用走便宜 channel, 备用走贵的);
5. 流式响应过程中 channel 挂了怎么办。这是 Ch7 章末埋的边角, v0.8 必须收口。

这一章把这五件事讲完。配套代码 (`examples/08-the-key-just-got-banned/`) 增量约 800 LOC, 核心是一个 `src/channels/` 子目录，与 `src/streaming/` `src/billing/` `src/limit/` 同级。

## 8.2 引入 Channel 这个领域对象

`Channel` 是贯穿全书的核心领域对象之四 (截止本章为 4 个。之一 `IR` (Ch2)、之二 `Key` (Ch4)、之三 `UsageRecord` (Ch5)、之四本章 `Channel`). 前三个对象都属于「业务侧」(协议、身份、账单), Channel 是「基础设施侧」第一个核心对象，描述「网关与上游之间的一根线路」. 此外 Ch4 顺带引入的 `User / Org` 是 Key 体系的辅助实体，不计入这 4 个核心对象。

一个 Channel 包含的字段，按数据模型抽象:

```ts
interface Channel {
  id: number;
  name: string;                 // 人类可读, 例: "OpenAI 主号" / "Azure 备用"
  provider: string;             // openai / anthropic / deepseek / 各种第三方代理
  apiKey: string;               // 上游真实 Key
  baseUrl: string;              // 上游 endpoint
  enabledModels: string[];      // 这条 channel 支持哪些 model
  groupName: string;            // 用户分组 (按 group 维度区分计费档位 / 可用渠道)
  priority: number;             // 优先级, 越大越优先
  weight: number;               // 同优先级内的加权随机权重
  channelMultiplier: number;    // 渠道倍率, 与 user × model 三合一进计费
  status: 'active' | 'disabled' | 'probing';
  disabledAt: number | null;
  disabledReason: string | null;
  lastProbedAt: number | null;
}
```

四个字段值得逐个说说。

**enabledModels 是一个数组**. 一个 OpenAI channel 通常支持十几个模型 (gpt-4o / gpt-4o-mini / gpt-4-turbo / o1-mini / o3-mini ...), 我们不为每个 model 单独建一个 channel 行——重复填 `apiKey` / `baseUrl` 是冗余的，改一个 Key 要 update 十几行也容易漏改。一个 channel 一条 Key, 它能开的模型清单是个数组。

**priority + weight 两层**. priority 是层级, weight 是同层内的加权。设计意图。让运营可以做这样的配置——

- 主用层 (priority=100): OpenAI 主号 weight=5, OpenAI 备号 weight=5. 流量 50/50 在两把 Key 间分摊;
- 备用层 (priority=50): Azure OpenAI weight=1. 主用层全挂时才用;
- 终极兜底 (priority=10): 第三方代理 weight=1. 质量不保，但便宜。

只要主用层有一把 Key 还活着，流量永远不下沉。如果不分层、所有 channel 混在一起按 weight 选，流量永远有 1/12 概率打到第三方代理，整体平均质量被拉低。这是分层带来的可控性, one-api 的 `ignoreFirstPriority` 跳层机制 (`model/cache.go:227` 起。本质上就是在做这件事。

**channelMultiplier 不是必需，但留接口**. 渠道倍率用于「同样的 model 在不同 channel 上单价不同」的场景——主号是官方价 ×1.0, Azure 折扣 ×0.7, 第三方代理 ×0.3. v0.8 范围内不接进计费快照 (multiplier_snapshot 还是 user × model 两路), 但 schema 里留好字段, Ch10 成本优化时用它做套利定价。

**status 三态**, 不是简单的 active/disabled 两态。加 `probing` 状态是为了让 health-checker 探活时有一个中间态: 「正在试探，还没结果」，别的请求线程不要同时也尝试它。这是 one-api 没做的——`monitor/manage.go` 直接 `status=AutoDisabled`, 探活时再翻 `ChannelStatusEnabled`, 期间存在「另一个请求线程同时也来探活」的小概率竞态。

数据库 schema (Drizzle, 见 `examples/08/src/db/schema.ts` 的 `channels` 表。就是把上面这个 interface 一比一映射: 注意一个边角:

```ts
enabledModels: text('enabled_models').notNull().default('[]'),
```

`enabled_models` 字段是 JSON 字符串. SQLite 不支持原生 array, 也不支持 jsonb, 但支持 `json_extract` 函数: 这里为什么不存成 jsonb? 答案在下一节——所有「按 model 查 channel」的热查询根本不走 channels 表，走另一张索引表。

## 8.3 Ability 反范式索引表。为什么不直接 JOIN

「按 model 查所有可用 channel」是热路径，每个请求都要跑一次。直觉上的做法是范式化设计——多对多关系拆一张中间表:

```sql
CREATE TABLE channels (id, name, api_key, ...);
CREATE TABLE channel_models (channel_id, model);
```

查询是:

```sql
SELECT c.* FROM channels c
JOIN channel_models cm ON cm.channel_id = c.id
WHERE c.status = 'active' AND cm.model = ?
ORDER BY c.priority DESC;
```

这套设计语义正确，高 QPS 下也跑得动。但 one-api 不这么做，它额外加了一张 `Ability` 表 (`_references/one-api/model/ability.go:14`).

为什么不直接用 `channels.enabled_models` 一个 JSON 字段 + SQLite 的 `json_each` 查询: 语法上完全可行，写起来更短:

```sql
SELECT c.* FROM channels c, json_each(c.enabled_models)
WHERE c.status = 'active' AND json_each.value = ?;
```

但这会废掉索引——`json_each` 是表函数，上面这条 SQL 在 SQLite 里走的是 channels 全表扫 + 每行展开 json. 100 个 channel 时单次查询 200-500μs, 1000 个 channel 时退化到几毫秒。反观把 (group, model, channel_id) 抽成独立行，可以建联合索引，单次查询不到 50μs 且与总 channel 数无关. PostgreSQL 的 `jsonb` + GIN 索引能加速 JSON 字段查询, SQLite 的 `json_each` 没有等价能力，索引列优势仍然完胜。

```go
type Ability struct {
    Group     string `gorm:"primaryKey"`
    Model     string `gorm:"primaryKey"`
    ChannelId int    `gorm:"primaryKey;index"`
    Enabled   bool
    Priority  *int64 `gorm:"index"`
}
```

(group, model, channel_id) 三元组联合主键，每次 channel 新增 / 修改时，把 (group × enabled_models) 笛卡儿积全部展开成 Ability 行 (`ability.go:53::AddAbilities`). 然后:

```sql
SELECT * FROM abilities
WHERE group = ? AND model = ? AND enabled = 1
ORDER BY priority DESC;
```

一张表搞定，没有 JOIN. 这是典型的反范式优化——用写放大换读优化。

为什么愿意付写放大的代价。看读写比。一个网关的典型工作负载。每秒 100-1000 次请求 (读路径), 每天几次到几十次 channel CRUD (写路径). 读写比 10^5:1. 写一次贵 10 倍 vs 读每次便宜 1.5 倍，整体收益压倒性. one-api 的 `UpdateAbilities` 是 quick and dirty 的「先删全部再 add 全部」(`ability.go:79`), 写 amplification 大但绝对量极低，不构成压力。

更深一层的原因是「索引列 vs 数据列」的区分. channels 表里有 api_key (敏感) / base_url (有时含 token) / config (大字段 JSON), 这些列每次读一遍都浪费 IO. abilities 表只装索引相关字段 (group / model / channel_id / priority / enabled), 一行约 50 字节，一万个 (group, model, channel_id) 三元组也才 500KB——可以全表加载到内存做 O(1) Map 索引。

本章的 `channels/registry.ts::ChannelRegistry` 就在做这件事。启动时把 channels + abilities 两张表全量读出来，构建一个三层 Map:

```ts
group2model2channels: Map<group, Map<model, ChannelEntry[]>>
```

运行时选 channel 的路径只读这个内存 Map, 不查 DB:

```ts
const list = registry.lookup(group, model);
const picked = pickChannel(list, { excludeIds });
```

`lookup` 是 O(1), `pickChannel` 在候选数 N 个内是 O(N) 加权随机，整体一次选 channel < 5 微秒。数据库一次查询带索引也得 50-200 微秒，中间还可能跟写路径抢锁。

admin API 改 channel 之后，调用 `invalidateChannelRegistry()` 触发全量重建 (本章实现简化版，直接 rebuild; one-api 是 `model/cache.go::SyncChannelCache` 增量更新，工程复杂度高，教学场景过度优化). 重建只读两张表全量，在百级 channel 下 < 10ms, admin 改完后下一次请求就拿到新配置。

abilities 还有一个隐藏的工程价值: 它把「channel 的 status」与「ability 的可用性」拆开了. channel.status 是 active / disabled / probing 三态, ability.enabled 是 bool. 当 channel 被禁用时，我们不删 ability 行，只把 enabled 翻成 false; 恢复时翻回 true. 这样的好处:

1. 减少写放大。一次禁用 = N 个 ability 行翻 enabled 字段 (不是 DELETE + INSERT);
2. 恢复链路简单。一行 UPDATE 就回到原始拓扑，不会丢失 priority 信息;
3. 历史可审计. ability 表始终能反映「这个 channel 历史上支持过哪些 model」，即使中间被禁用。

## 8.4 错误分类器。四类错误四条路径

故障转移的核心判定是「这个错算什么类型」. 不分类只看 status code 不够——同样是 401, 上游可能是 invalid_api_key (Key 真的死了), 也可能是 token 刚过期 (会自动续期，暂时性). 同样是 200, body 里可能写着 `error: account_deactivated` (上游用 200 + error.body 表达鉴权失败, OpenAI 兼容上游常见做法).

本章把错误归到四类:

```
transparent : 4xx 业务错 (400/404/422 等). 客户端的请求体不合规, 与 channel 健康度无关.
              -> 不重试 / 不禁用 / 透传给客户端

retryable   : 5xx 上游故障 / 网络层错. 上游临时挂.
              -> 同 channel 不重试 (避免同一错误立刻复现);
              -> 允许换 channel 重试.

disable     : 401/403 / invalid_api_key / account_deactivated / insufficient_quota.
              -> 立即禁用该 channel, 进入 disabled 状态;
              -> 触发后台 health-checker 探活恢复 (最小间隔 60s).

throttle    : 429 / rate_limit_exceeded.
              -> 短期禁用 channel (默认 5 分钟);
              -> 5 分钟后 health-checker 自动尝试恢复.
```

disable 与 throttle 的区别值得展开。都是「这个 channel 暂时不可用」，但探活策略不同:

- disable 一般是 Key 真的死了 (账号欠费 / 风控吊销 / 权限被撤). 这种状态通常需要人工解决，探活频率太高反而触发上游升级风控. **60 秒探一次，谨慎试探**.
- throttle 是上游主动限速 (RPM/TPM 桶满). 1 分钟过去桶就回了，没必要 60s 间隔的低频探活. **5 分钟到点直接恢复，不需要探活验证** (因为 throttle 的根本原因是流量，探活流量很小不会再触发).

错误分类的具体策略 (见 `examples/08/src/channels/classifier.ts::classifyError`):

```ts
function classifyError(input): ClassifyResult {
  if (input.networkError) {
    // DNS / TCP RST / connect timeout 都属于网络层错
    return { class: 'retryable', reason: `network_error: ${...}` };
  }

  const status = input.status;
  const body = input.body ?? '';

  if (status === 401 || status === 403) return { class: 'disable', reason: `upstream_${status}` };
  if (status === 429) return { class: 'throttle', reason: 'upstream_429_rate_limited' };

  // 关键字扫描: 用 200 + error.body 表达鉴权失败的兜底
  const lowerBody = body.toLowerCase().slice(0, 4096);
  const disableKeywords = [
    'invalid_api_key', 'invalid api key', 'api key not valid', 'api key expired',
    'account_deactivated', 'account has been deactivated', 'authentication_error',
    'organization has been disabled', 'organization has been restricted',
    'insufficient_quota', 'your credit balance is too low', '已欠费',
    'permission_error', 'permission denied',
  ];
  for (const kw of disableKeywords) {
    if (lowerBody.includes(kw)) return { class: 'disable', reason: `body_keyword: ${kw}` };
  }

  if (status >= 500 && status < 600) return { class: 'retryable', reason: `upstream_${status}` };
  if (status >= 400 && status < 500) return { class: 'transparent', reason: `upstream_${status}` };

  return { class: 'transparent', reason: `unexpected_status: ${status}` };
}
```

关键字字典直接抄自 one-api `monitor/manage.go:11::ShouldDisableChannel`. 这是真金白银踩出来的，涵盖 OpenAI / Anthropic / Gemini / Groq 等主流上游用过的所有「不可恢复错误」表达。自己重新枚举要踩半年坑，直接抄过来省 90% 工作量。

字典里有几条值得单独说. `your access was terminated` / `violation of our policies` 对应 OpenAI 内容政策违规，整个账号被永久封禁，跟 invalid_api_key 不同档次——这种 Key 不会自动恢复，探活也是徒劳，但本章不区分这一层，一并按 disable 处理. `organization has been disabled` 对应组织级别封禁 (整个 OpenAI organization 被锁), 这种 Key 即使换组织也救不回来. `已欠费` 是国产模型 (智谱 / 月之暗面。的常见表达，走中文关键字命中. `your credit balance is too low` 是 Anthropic 余额不足的特征字符串，充值后探活才能恢复，不充就永远 disabled. 这些细节决定了 health-checker 的探活策略不能太激进——给真死的 Key 反复探活毫无意义，反而增加无效流量。

错误分类还有一个边角情况: parse error. 上游返 200 但 body 是无效 JSON (或者中间链路坏了，返回了 HTML 错误页), `adaptor.parseResponse` 会抛异常: 本章把这种情况也丢给 classifyError, 用 `parse_error: ${msg}` 作为 body 让关键字字典扫一遍 (通常不命中，落到 retryable). 落 retryable 意味着「换 channel 重试」是合理选择——这种情况大概率是 channel 自己出问题，换一个就好。

为什么 5xx 是 retryable 而不是 disable? 因为 5xx 通常是「上游服务端临时挂」(例如 OpenAI 节点重启 / 后端 GPU 故障切换), 不是「这把 Key 死了」. 几秒后再请求大概率好了。把 5xx disable 掉，健康 channel 会被一次抖动拉走，反而扩大故障面。

为什么关键字命中放在 status 判断之后。因为有些上游 (especially Anthropic, Gemini 早期版本: 会把 invalid_api_key 错误以 status=200 + body 里 `error.type=invalid_request_error` 返回。不扫 body 关键字，这种 channel 永远 disable 不掉，持续吃流量但全失败。

## 8.5 故障转移主循环。流式 / 非流式两条路径

错误分类拿到后，网关主路径就能做决策了。主循环结构 (见 `examples/08/src/index.ts`):

```ts
const excludeIds = new Set<number>();
const attemptedChannels: number[] = [];

for (let attempt = 0; attempt < MAX_CHANNEL_ATTEMPTS; attempt++) {
  const picked = pickChannelForModel(group, model, excludeIds);
  if (!picked) {
    // 所有 channel 都试过了, 退预扣, 返 502
    refundReservation(reservation.recordId, 'all_channels_failed');
    return c.json({ error: { type: 'all_channels_failed', ... } }, 502);
  }
  attemptedChannels.push(picked.channel.id);

  if (ir.stream) {
    const result = await tryConnectStream(picked.adaptor, ir);
    if (result.kind === 'failed') {
      handleClassification(result.classification, picked.channel.id);
      continue; // 换下一个 channel
    }
    return streamFromConnected({ /* ... */ });
  }

  const result = await tryNonStreamUpstream(picked.adaptor, ir);
  if (result.kind === 'success') {
    return c.json(result.response, 200);
  }
  handleClassification(result.classification, picked.channel.id);
}

// 重试上限耗尽
return c.json({ error: { type: 'max_attempts_exceeded', ... } }, 502);
```

`handleClassification` 是个伪代码概念，实际在循环体里:

- `transparent`: 立刻 break, 返 上游原始 status + body 给客户端，退预扣;
- `disable` / `throttle`: 调 `markChannelDisabled(channel.id, reason)` 把 channel 切到 disabled 状态;
- `retryable`: 不禁用，但 `excludeIds.add(channel.id)` 让这次请求不再选它。

不管哪一类，后两类都会进入 `continue`, 让循环挑下一个 channel.

MAX_CHANNEL_ATTEMPTS 默认 3. 这个上限不是性能考虑，是防御性的。即使有 10 个 channel, 一次请求最多换 3 个。超过 3 个还失败，大概率是请求本身有问题 (例如 prompt 触发 content_filter, 所有 channel 都拒绝), 继续换没意义，该让客户端看到错误了。

### 流式分支的两段式

流式分支比非流式复杂一档. v0.7 章末埋的边角:

> 流式响应过程中渠道挂掉的两段式处理:
>   - 首字节前。还没把任何 SSE 帧 enqueue 给客户端，客户端只是在等响应头。这时换 channel 完全透明，可以重试。
>   - 已开始 stream: 客户端已经收到一部分 chunk 了，这时换 channel 会让客户端看到「上半段是 channel A 的输出，下半段是 channel B 的输出」，内容前后矛盾。

「首字节前」具体怎么界定? v0.8 的实现把 v0.7 的 `proxySSE` 拆成两段:

1. `tryConnectStream(adaptor, ir)`: 只做 fetch + 响应头判定: 拿到 status 2xx 才算「连接成功」.
2. `streamFromConnected({ upstreamResp, ... })`: 拿着已连接的 Response, 做边读边发。一旦 `controller.enqueue` 第一个 chunk, 客户端就已经收到 SSE 帧，不再能换 channel.

两段拆开后，主循环就能在 `tryConnectStream` 失败时换 channel 重试 (客户端还没拿到任何数据，切上游完全透明), 在 `streamFromConnected` 内部出错时只能透传 error event 给客户端 (内容矛盾不可恢复). 这两条路径分别对应 sse-proxy.ts 的两层封装，主路径不需要关心 SSE 协议细节。

跟 v0.7 的一段式调用对比，差异长这样:

```diff
- // v0.7: 一段式, 拿到 picked.adaptor 直接发 + 流式透传, 失败无路可走
- await proxySSE({
-   adaptor: picked.adaptor,
-   ir,
-   onFinalize: async (fin) => { /* postConsumeStream */ },
- });
-
+ // v0.8: 两段式, 第一段 fetch + 响应头判定, 第二段才把流接到客户端
+ const result = await tryConnectStream(picked.adaptor, ir);
+ if (result.kind === 'failed') {
+   // 此时还没 enqueue 任何 chunk 给客户端, 主循环可以 continue 换 channel
+   handleClassification(result.classification, picked.channel.id);
+   continue;
+ }
+ return streamFromConnected({
+   upstreamResp: result.upstreamResp,
+   onFinalize: async (fin) => { /* postConsumeStream, 已经不可换 channel */ },
+ });
```

「为什么必须拆」体现在这两行: v0.7 的 `proxySSE` 内部一旦 fetch 拿到响应，就立刻开始 enqueue chunk 给客户端的 ReadableStream. 此时即使发现是 401, 也没法换 channel——客户端已经收到 200 + 部分 SSE 帧 (有些 SSE 透传实现会在拿到响应头时就 flush headers). 必须把「fetch + 响应头判定」与「enqueue chunk」拆成两个原子动作，主循环才有窗口决定要不要换 channel.

实际代码 (流式分支，见 `examples/08/src/index.ts`):

```ts
if (ir.stream) {
  const result = await tryConnectStream(picked.adaptor, ir);

  if (result.kind === 'failed') {
    const cls = result.classification;
    if (cls.class === 'transparent') {
      refundReservation(reservation.recordId, ...);
      return new Response(result.body, { status: result.status, ... });
    }
    if (cls.class === 'disable' || cls.class === 'throttle') {
      markChannelDisabled(picked.channel.id, cls.reason);
    }
    excludeIds.add(picked.channel.id);
    continue;
  }

  return streamFromConnected({ /* 一旦走到这, 不再换 channel */ });
}
```

`streamFromConnected` 内部如果上游中途断 (TCP 连接被远端 reset, 或上游开始流但中途异常), 会进入 v0.7 已经实现的 `terminalStatus: 'partial'` 路径——已收到的 token 计费，给客户端透传一个错误信号 (实际实现里是流提前 close), 客户端 SDK 看到流提前结束，自己做 UI 处理。

这两段拆分后, sse-proxy.ts 的代码反而比 v0.7 更清晰。它只负责「已经握手成功的上游 -> 下游」，没有任何 fetch 逻辑: 整个流式系统的可测试性提高一个档次——可以单独测 `tryConnectStream`、单独测 `streamFromConnected`, 不需要起完整服务。

### 非流式分支

非流式分支结构上更简单，因为没有「首字节前 vs 已开始」的窗口区分. fetch 拿到完整 body 后，整个响应是 atomic 的。要么成功 (kind=success), 要么失败 (kind=failed). 失败时一律可以换 channel, 不存在「客户端已经看到上半段」的问题。

一个边角: 即使 status 是 200, 也要扫一遍 body 做错误分类: 因为有些 OpenAI 兼容上游 (Anthropic / Gemini 在早期版本里，一些国产模型现在还在干。会用 200 + error.body 表达鉴权失败:

```json
HTTP/1.1 200 OK
Content-Type: application/json

{"error": {"type": "invalid_request_error", "code": "invalid_api_key", "message": "..."}}
```

不扫 body 的话，这种 channel 永远不会被分类成 disable, 持续吃流量但每次客户端拿到的都是 `{"error": ...}` 而不是 chat 响应: 本章在 `tryNonStreamUpstream` 里加了一行:

```ts
const cls = classifyError({ status: resp.status, body: rawBody });
if (cls.class === 'disable' || cls.class === 'throttle') {
  return { kind: 'failed', classification: cls, ... };
}
```

200 + 关键字命中 disable / throttle, 同样进失败路径。

## 8.6 加权轮询: priority 分层 + 同层 weight 随机

`pickChannel` 的实现 (`examples/08/src/channels/weighted-picker.ts`) 30 行不到，但每一行都对应一个具体的需求:

```ts
export function pickChannel(list, options) {
  const exclude = options?.excludeIds;

  let i = 0;
  while (i < list.length) {
    const currentPriority = list[i]!.priority;
    const layer: ChannelEntry[] = [];
    while (i < list.length && list[i]!.priority === currentPriority) {
      const c = list[i]!;
      if (!exclude || !exclude.has(c.id)) layer.push(c);
      i++;
    }
    if (layer.length === 0) continue;

    const totalWeight = layer.reduce((acc, c) => acc + Math.max(0, c.weight), 0);
    if (totalWeight <= 0) continue;
    let r = Math.random() * totalWeight;
    for (const c of layer) {
      r -= Math.max(0, c.weight);
      if (r <= 0) return c;
    }
    // 浮点累减误差可能导致循环结束时 r 仍然略 > 0 (例如 weights=[0.1, 0.2, 0.7],
    // totalWeight=1.0 但 0.1+0.2+0.7 在 IEEE 754 下可能等于 0.9999999...).
    // 兜底返回最后一个 channel, 避免逻辑上「权重和为 1 但选不出 channel」的反直觉.
    return layer[layer.length - 1]!;
  }
  return null;
}
```

`list` 是 `ChannelRegistry.lookup(group, model)` 返回的，已经按 priority desc 排好序。算法用单次扫描切片，找到第一个有可用 channel 的 priority 层。同层内累加 weight 做加权随机。

累加权重 (`r -= weight`) 而不是「平均概率随机选一个」的原因: 让 weight 这个字段对运营有意义。配 [1, 1, 8] 就是第三个 channel 占 80% 流量，配 [5, 5] 就是 50/50. 这是 nginx upstream 模块、HAProxy `weight` 参数、Envoy `weighted_clusters` 都在用的同一套算法。

为什么不用「严格轮询」(round-robin)? 严格轮询需要保留一个游标，进程内多线程访问要加锁。重启游标归零，流量分配会向第一个 channel 倾斜。加权随机无状态，长程统计上等价于严格加权，工程复杂度低一档。

为什么不用一致性哈希 (consistent hashing)? 一致性哈希适合「同一个 user 永远路由到同一个 channel」的场景，例如要利用上游 prompt cache 时，同一用户的连续请求落到同一 Key 命中率更高. new-api 的 `service/channel_affinity.go` 做了这件事 (`research/one-api-arch-extract.md` 第 271-279 行). 本书 v0.8 暂不引入会话粘性，等 Ch10 成本优化时再处理。

portkey-gateway v1.15.2 的多 provider fallback 走的是另一条路 (`src/handlers/handleAPICall.ts` 起的 retry 循环), 它在请求级别配置 `[provider_a, provider_b, provider_c]` 数组，按数组顺序顺次尝试，不引入 priority + weight 的二维概念。这套设计适合「每次请求都显式声明用哪几个 provider」的客户端友好场景，但运营拉不出全局视图——一个 Key 突然失效时无法集中切换。本书选 channel 表 + 加权轮询是因为「网关侧统一治理」更接近企业基建的实际需求，客户端只关心 model, 选 channel 是网关运营的事。

`excludeIds` 这个参数也值得说一句。它不是「下次请求不要选这些 channel」的全局设置，而是「这次请求已经试过，别重复试」的请求级状态。重试期间累加 excludeIds, 请求结束就丢弃。这个设计让 picker 是无状态的——同样的 `(list, excludeIds)` 输入永远给同样的输出分布 (除随机数外), 不存在「时间相关的副作用」. 单元测试时只要 mock Math.random, 整个加权选择逻辑可以完全确定地测。

## 8.7 后台健康检查: disabled 怎么自动复活

健康检查解决的是「死了的 channel 怎么活回来」. 没有这个机制，一次 5 分钟的 OpenAI 风控会让 channel 永久 disabled, 必须人工干预——这违背了「自动故障转移」的初衷。

`health-checker.ts` 的核心循环:

```ts
async function runOnce() {
  const disabled = listDisabledChannels();
  const now = Date.now();

  for (const row of disabled) {
    const isThrottle = row.disabledReason === 'upstream_429_rate_limited';
    const cooldown = isThrottle ? THROTTLE_COOLDOWN_MS : DISABLE_PROBE_INTERVAL_MS;
    const since = row.disabledAt ?? row.lastProbedAt ?? 0;
    if (now - since < cooldown) continue;

    markChannelProbing(row.id);
    const result = await probe(row, probeTimeoutMs);
    if (result.ok) {
      markChannelActive(row.id);
    } else {
      markChannelDisabledAfterProbe(row.id, result.reason);
    }
  }
}
```

主循环每 60 秒触发一次 (可配置，测试场景调到 2-5 秒便于观察). 每次扫一遍 disabled 表，看哪些到了冷却时间，发探针请求。

探针请求是一个 `max_tokens: 1` 的最小 chat completion:

```ts
const ir = {
  model: entry.enabledModels[0]!,
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 1,
  stream: false,
};
```

为什么是 chat completion 而不是 `/v1/models` 这种「列模型」接口: 因为列模型在大多数上游是免费的，不消耗 quota. 我们需要验证的是「这把 Key 还能用来花钱」——也就是 chat 请求能否走通。只有真发一次 chat, 才能确认账号没欠费、没被风控. `max_tokens: 1` 让探活本身的花销大约 0.0001 元，对账单影响可以忽略。

探活结果用 `classifyError` 再过一遍。同样的分类逻辑: 网络错或 5xx 仍算「探活失败」(下次再试), 2xx 不命中关键字才算「真复活」，命中关键字 (例如 body 还有 `account_deactivated`) 仍然 disabled.

`status` 三态在这里的价值显出来: channel 被禁后从 `disabled` 切到 `probing` 再切到 `active` 或 `disabled`. probing 中间态让其他请求线程不会同时尝试同一个 channel——它的 ability 仍然 enabled=false, 主路径选不到它. health-checker 自己跑完，再决定切到哪个终态。

最小探活间隔的两档 (`DISABLE_PROBE_INTERVAL_MS = 60s`, `THROTTLE_COOLDOWN_MS = 5min`) 是经验值. 60s 对应 OpenAI 单 Key 解封的最短观察窗口 (大多数风控放行是分钟级), 5min 对应 RPM/TPM 桶的常见重置周期。实际项目里这两个值可以从配置读，按上游特性调。

一个工程细节: health-checker 启动时立刻跑一次 (`void tick()` 在 `setInterval` 之前). 不这样写的话，进程刚启动时如果 DB 里已经有 disabled 行，要等 60s 才会被扫到。进程重启场景下这是常见问题——上一个进程已经把 channel 标 disabled 了，新进程启动后第 60s 内一直不可用。

`_timer.unref()` 让 setInterval 不阻塞进程退出。没这一行的话, `npm run start` 之后 Ctrl+C 退出会卡 60 秒等下一次 tick. unref 是 Node setInterval / setTimeout 的进程退出钩子，非常常见但容易忘。

## 8.8 一次完整请求的故障转移现场

把上面这些拼起来看一次具体的请求. mock 上游里我们做了一个细节: 校验 `Authorization: Bearer` 头, token 不是 `mock` 时返 401 + `invalid_api_key` 错误体。配套代码默认 seed 三个 channel:

| id | name | api_key | priority |
|----|------|---------|---------|
| 1 | mock-primary | `mock` | 100 |
| 2 | mock-bad-key | `will-fail-401` | 100 |
| 3 | mock-network-unreachable | `mock` | 50 (baseUrl 指向不存在的端口) |

跑一次客户端流式请求 (model=mock-gpt-4o-mini), 实测网关日志:

```
INFO billing_pre_consumed
  trace_id: 70e47a4036d9844b02c3d353afe92a43
  first_channel_id: 2

WARN stream_upstream_failed_pre_byte
  trace_id: 70e47a4036d9844b02c3d353afe92a43
  attempt: 0
  channel_id: 2
  channel_name: "mock-bad-key"
  status: 401
  class: "disable"
  reason: "upstream_401"

INFO stream_upstream_connected
  trace_id: 70e47a4036d9844b02c3d353afe92a43
  attempt: 1
  channel_id: 1
  attempted: [2, 1]

INFO stream_settled
  trace_id: 70e47a4036d9844b02c3d353afe92a43
  channel_id: 1
  terminal_status: "finalized"
  prompt_tokens: 1
  completion_tokens: 17
  attempted_channels: [2, 1]
```

picker 在 ch1 / ch2 之间 50/50 加权随机，这次抽到 ch2. tryConnectStream 拿到 401, classifier 返 `disable` + reason=`upstream_401`. 主路径调 `markChannelDisabled(2, 'upstream_401')`, 把 ch2 切到 disabled, abilities 表的对应行 enabled=false. 然后 `excludeIds.add(2)` + `continue`, attempt=1. picker 这次只剩 ch1 (ch2 已经被排除, ch3 priority 更低还轮不到), 选 ch1 -> tryConnectStream 成功 -> streamFromConnected 开始边读边发。客户端拿到完整的 mock-gpt-4o-mini 输出，完全不知道中间换了 channel.

把这次请求和「单 Key 网关」的同等场景对比. v0.7 的话。这把 Key 被风控 -> 返 401 -> 网关把 401 透给客户端 -> 客户端报错 -> 业务方电话打来 -> 运维查上游 dashboard -> 改 OPENAI_API_KEY 环境变量 -> 重启网关。中间至少 15 分钟. v0.8: 几毫秒，客户端完全无感。

`admin/channels` 接口能查到当前所有 channel 的 status:

```bash
curl -sS $BASE/admin/channels -H "Authorization: Bearer $ADMIN_TOKEN"
```

输出 (实测):

```json
[
  { "id": 1, "name": "mock-primary", "status": "active" },
  { "id": 2, "name": "mock-bad-key", "status": "disabled" },
  { "id": 3, "name": "mock-network-unreachable", "status": "active" }
]
```

把 ch2 的 api_key 改回 `mock` 之后，健康检查会在下一次 tick 把它复活:

```bash
curl -sS -X PATCH $BASE/admin/channels/2 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"mock"}'

# 等 60s, 或手动 probe-now
curl -sS -X POST $BASE/admin/channels/probe-now \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"scanned":1,"recovered":[2],"stillDisabled":[]}
```

`channel_recovered` 日志:

```
INFO channel_recovered
  channel_id: 2
  channel_name: "mock-bad-key"
  provider: "mock"
  previous_reason: "upstream_401"
```

ch2 重新进 active, abilities 行 enabled=true, picker 又能选它了。整条链路自动闭环。

## 8.9 跨多副本部署时的一致性

单进程内 ChannelRegistry 是内存 Map, admin 改完后 `invalidateChannelRegistry()` rebuild 一次即可生效。但在多副本部署 (Ch12 上线整合时讨论的场景: 下，一个副本 A 把 ch2 标 disabled, 副本 B 还不知道，仍然会选到 ch2 然后再失败一次。

工程上有几种处理方式，复杂度从低到高:

1. **副本各自 detection**. 副本 B 自己尝试时也会拿到 401, 也会把 ch2 标 disabled. 牺牲一些请求质量 (副本数 × 1 次重复 disable), 换零跨副本通信。实际项目通常足够，因为单次错误重试上限内大概率能成功。
2. **DB 轮询**. 每个副本每 5 秒查一次 channels.status 字段，发现变化就 rebuild registry. 简单但延迟 5 秒。
3. **pub/sub 广播**. admin 改完后通过 Redis pub/sub 通知所有副本立即 rebuild. 复杂度提一档，但同步几乎实时 (< 100ms).
4. **共享内存**. 所有副本读同一个 Redis hash 做配置中心, registry 不存内存。极端情况下用，但每个请求多一次网络往返，一般不上。

本书选 1 + 2 的组合，不上 Redis. 教学项目内单进程足够，真要上多副本时用 Ch12 给的方案. one-api 走的是「Redis 缓存 + 副本各自 SyncChannelCache」的路子，本质是 2 + 3, 工程上偏成熟产品。

abilities 表的反范式索引在多副本下的好处。即使副本间临时不一致，单次请求看到的状态仍然是自洽的 (一次 lookup 是原子的，不会拿到「half-updated」的状态). 这种「最终一致」的语义比「强一致 + 性能差」在网关这种场景下更合适——网关本来就是「best-effort 重试 + 故障转移」的工程，不需要事务级一致。

## 8.10 v0.8 之后还差什么

v0.8 完成的能力清单:

- Channel 数据模型。一个 model 背后挂多个 channel, channel 有 priority + weight + status + multiplier;
- abilities 反范式索引表: (group, model, channel_id) 三元组联合主键，选 channel 走 O(1) 内存 Map;
- 错误分类: 4 类 (transparent / retryable / disable / throttle), 各走不同恢复路径;
- 故障转移主循环。流式 + 非流式两条路径，流式分两段处理「首字节前」与「已开始」;
- 后台健康检查: 60s 扫一遍 disabled, 探活恢复; throttle 类 5 分钟自动恢复，不需要探活验证;
- admin API: channels CRUD + 手动 disable/enable + probe-now.

但 v0.8 之后，当某次请求出现异常需要回溯时——例如产品方反馈「某个对话回答质量异常」——现有日志能告诉我们什么? `console.log` 加 `pino` 的默认 transport, 日志是给人看的文本流，没有结构化字段索引: 想按 `trace_id` 反查一次请求经过的所有 channel、计费金额、上游耗时，只能 `grep`:

```bash
grep "70e47a4036d9844b02c3d353afe92a43" /var/log/gateway.log
```

这条命令能拿到 5-10 行相关日志，但没法做聚合 (例如「最近 1 小时哪个 channel 失败率最高」), 没法跨日期反查 (日志被切割了), 没法关联 usage_records 表 (日志里的 trace_id 与 DB 里的 trace_id 没有索引). 一旦运营开始问「上周三下午客户 X 的对话用量为什么突然涨了」，现有日志就废了——没人能从几百万行 `console.log` 里捞出来。

更糟的是，现在的日志输出是为本地开发优化的 (`pino-pretty` 加颜色加格式). 生产环境应该输出 JSON 一行一条，接进 ELK / Datadog / Loki 这种聚合系统。这两套用法本质上是不同的传输层，需要在配置层切换。现在的代码没这个分层。

第三件事。全链路 trace_id 是有了 (Ch5 加进去的), 但只在 usage_records 表里。上游耗时 (从 fetch 开始到上游返第一个 byte / 第一个 chunk) 没记录, channel_id 没记录，错误类型没记录。想做「按 channel 维度的健康度看板」根本没有数据源。

v0.9 引入 pino 结构化日志 + trace_id 全链路注入 + `/admin/dashboard` SSR 看板。把 console.log 全部替换为 pino structured logging, 每条日志带 `trace_id` / `request_id` / `key_id` / `channel_id` / `upstream_latency_ms` / `tokens_in/out` / `error_code` 等字段. usage_records 表加 `trace_id` / `channel_id` / `upstream_latency_ms` 字段 (已有 trace_id, 补另两个). 看板后端用最小 HTTP + SSR 模板渲染「今日 QPS / 今日花费 / Top 10 Key / Channel 健康度 / 错误率 Top 5」，不引入前端框架。

## 配套代码

完整可运行的 v0.8 代码在 `examples/08-the-key-just-got-banned/`. 目录结构:

```
src/
  index.ts                          # (new) 主路径加 attemptWithFailover 循环
  channels/                         # (new) 本章核心
    classifier.ts                   # 错误分类 (transparent / retryable / disable / throttle)
    registry.ts                     # ChannelRegistry, 启动时全量从 DB 加载到内存
    weighted-picker.ts              # priority 分层 + 同层 weight 加权随机
    router.ts                       # pickChannelForModel + buildAdaptorForChannel
    store.ts                        # channels + abilities 双表 CRUD, 全部包在事务里
    health-checker.ts               # 后台 worker, 60s 扫 disabled 探活恢复
    seed.ts                         # 默认 3 个演示 channel
  streaming/
    sse-connect.ts                  # (new) 把流式 fetch + 状态判定抽出来, 让主路径能在首字节前换 channel
    sse-proxy.ts                    # (new) 改成接受「已连接的 Response」做边读边发
  scripts/
    mock-upstream.ts                # (new) 增加 Bearer 头校验 + 非流式 probe 分支
    failover-test.ts                # (new) 端到端验证脚本
  admin/routes.ts                   # (new) 新增 /admin/channels CRUD + /admin/channels/probe-now
  db/schema.ts                      # (new) 新增 channels / abilities 表 + 类型
drizzle/0004_channels.sql           # (new) 本章新增的 migration
```

启动:

```bash
cd examples/08-the-key-just-got-banned
npm install
npm run migrate       # 0001/0002/0003/0004, 共 4 份
npm run mock          # terminal 1: 监听 :4010
npm run start         # terminal 2: 监听 :3000
```

默认 seed 3 个 channel: mock-primary (正常)、mock-bad-key (mock 上游会返 401)、mock-network-unreachable (端口不存在). 跑 `npx tsx src/scripts/failover-test.ts` 看一遍完整的「请求 -> 故障转移 -> channel 自动禁用 -> health-checker 探活恢复」流程，与上面 8.8 节描述的现场对得上。

## 下一章预告

v0.8 之后，渠道切换是自动的。单 Key 故障时网关在毫秒级换到另一把 Key, 客户端完全无感。但当某次请求出现异常需要回溯时——产品方反馈「某个对话回答质量异常」——现有日志是非结构化的 `console.log`, 无法按 trace_id 反查完整链路 (哪个用户、哪个渠道、哪个上游、是否切换过、计费金额、耗时分布). 一旦上线进入运维阶段，这种「问题溯源」是日常工作量最大的一类，没结构化日志就是抓瞎。

第 9 章把日志换成 pino 结构化输出，每条日志带 `trace_id` / `request_id` / `key_id` / `channel_id` / `upstream_latency_ms` / `tokens_in/out` / `error_code` 字段; trace_id 在 Hono middleware 里生成，贯穿所有下游调用. usage_records 表加 `trace_id` / `channel_id` / `upstream_latency_ms` 字段: 再加一个最小可用的 SSR 看板，输出「今日 QPS / 今日花费 / Top 10 Key / Channel 健康度 / 错误率 Top 5」.

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)
