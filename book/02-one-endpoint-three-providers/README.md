---
title: 第 2 章 一个入口，多家上游
feishu_url: "https://www.feishu.cn/wiki/S8ROw40BpiqnbBkNzfccFiiynye"
last_synced: "2026-05-16T18:28:28"
---

## 2.1 v0.1 在第二家上游面前的崩塌

第 1 章的 v0.1 是这样一段代码：客户端把 OpenAI 协议的请求发到网关，网关把它原样转发给 `process.env.OPENAI_BASE_URL` 指向的上游，再把响应原样回给客户端。配置改一行 `OPENAI_BASE_URL=https://api.deepseek.com`，整套就能从转发 OpenAI 切换到转发 DeepSeek。

只要全公司只用一家上游，这就是足够的实现。问题出在第二家上游接入的那一刻。

设想这样的需求清单：客服机器人继续用 `gpt-4o-mini`，因为 OpenAI 的稳定性最好；文档摘要任务想换成 `deepseek-chat`，单价能压到原来的 5%；新接的代码助手想试试 `claude-sonnet-4-5`，看看长上下文处理是否更好。三个业务方都不愿意改自己的客户端代码——它们已经接入了 `openai-node` SDK，希望网关能根据请求体里的 `model` 字段把流量分发到对的上游。这是中转站价值最直接的体现：一份 SDK、一个 base URL，上游变化对客户端透明。

回头看 v0.1 的实现，至少有三处硬伤：

1. **`upstream` 是一个常量**，无法按 `model` 字段路由到不同 provider。要支持第二家上游，唯一办法是改环境变量并重启服务，所有业务线被迫一起切——这与「让每个业务自己挑模型」的需求完全相反。
2. **鉴权 header 写死成 `Bearer ${process.env.OPENAI_API_KEY}`**，DeepSeek 的 Key 与 OpenAI 是两套体系，硬塞同一个变量会让其中一家彻底用不了。即便协议字段都是 `Authorization: Bearer ${key}`，Key 本身也必须按 provider 分桶保存。
3. **响应直接 `await resp.json()` 转发**，看似透传，实则隐含了「上游响应结构已经是 OpenAI Chat Completions 形状」的假设。等到 Anthropic 这种结构不同的上游接入时，这条假设会立刻断裂——Anthropic 回包的字段名是 `stop_reason` 而不是 `finish_reason`，内容是 `content` block 数组而不是 `message.content` 字符串。

要解决这三件事，需要在 v0.1 与上游之间插入一层抽象——这层抽象在 one-api 里叫 `Adaptor`，在 LiteLLM 里叫 `BaseConfig`，在 Portkey 里叫 `Provider`。三者命名不同，本质是同一件事：**把上游差异收口到一个明确的接口背后**。抽象建好之后，新增上游就只剩「实现接口的几十行代码 + 在路由表里注册一行」两件事；不再需要改主流程，不再需要重启时停整套服务。

本章把这层抽象立起来，并用 OpenAI 与 DeepSeek 两家上游验证它跑得通。Anthropic 留给第 3 章——理由会在 2.6 节解释。

## 2.2 IR：先定一种「内部语言」

抽象上游差异之前，需要先确定网关内部用什么数据结构表达「一次对话请求」。这个内部结构在编译器领域有个现成的名字：**Intermediate Representation（中间表示，简称 IR）**。

IR 在网关里的角色与编译器一致：作为「上游 A 协议 → IR → 上游 B 协议」的中转格式。客户端发来的请求先归一化为 IR，再由 Adaptor 把 IR 翻译成各家上游要的协议；上游响应回来后，Adaptor 把它再翻译回 IR，统一对外暴露。

IR 的设计空间里有两个主流选项。

**选项 A：自定义中性 IR**。设计一份与具体 provider 无关的字段集合，例如：

```ts
interface NeutralRequest {
  systemPrompt?: string;
  conversation: Array<{ speaker: 'user' | 'agent' | 'tool'; text: string }>;
  toolDefinitions?: ToolDef[];
  maxOutputLength?: number;
  // ...
}
```

这套设计在「向上兼容性」上最干净——加入新的 provider 时不偏袒任何一家，所有上游都是 IR 的「翻译目标」。代价是巨大的：

- 网关入口的客户端是按 OpenAI 协议写的，要先把 OpenAI 翻译成中性 IR，再把中性 IR 翻译成 OpenAI——一次「无意义的来回翻译」就发生在最热路径上。
- 流式响应每个 chunk 都要做两轮转换，CPU 占用与延迟都不划算。
- 不熟悉中性协议的工程师无法直接读懂代码，每次新增字段都要在「中性命名 vs OpenAI 命名」之间做一次权衡，团队内部约定成本高。

**选项 B：直接拿 OpenAI Chat Completions 协议当 IR**。把 OpenAI 协议作为内部「金标准」，新增 provider 等价于「写一个 OpenAI 与该 provider 之间的双向翻译器」。

这个选项的工程性比 A 强得多，理由有三：

1. **事实标准带来的零额外约束**。OpenAI 的 `/v1/chat/completions` 已经是市面绝大多数客户端 SDK（openai-python、openai-node、LangChain、LlamaIndex、Cherry Studio、Open WebUI、Cline、Continue 等）默认对接的协议。网关入口接受 OpenAI 协议、内部 IR 也是 OpenAI 协议，意味着入站方向几乎不需要翻译——客户端的请求体直接通过 zod 校验后就是 IR。
2. **绝大多数上游已经提供 OpenAI 兼容模式**。DeepSeek、Moonshot、智谱 GLM、阶跃、Together、SiliconFlow、xAI、Mistral、Groq……这些上游主动把自己包装成「OpenAI 兼容 endpoint」。对这些上游而言，IR → 上游协议的翻译几乎是 no-op。
3. **协议演进有上游兜底**。OpenAI 加新字段（如 `response_format`、`reasoning_effort`、`max_completion_tokens`），各家兼容上游会陆续跟进。网关不需要自己设计协议演进策略——跟着 OpenAI 走即可。

成熟项目几乎都做了同样的选择：

- **LiteLLM** 的 `BaseConfig`（`litellm/llms/base_llm/chat/transformation.py`）的接口签名全部以 OpenAI 概念命名：`AllMessageValues`、`get_supported_openai_params`、`map_openai_params`、`transform_request(model, messages, ...)`。
- **one-api** 的 `Adaptor.ConvertRequest`（`relay/adaptor/interface.go`）的入参 `request *model.GeneralOpenAIRequest` 就是 OpenAI 请求体的 Go 结构。
- **Portkey v1.15.2** 的内部签名同样把 OpenAI Chat Completions 当作 canonical 形态。

本书的 IR 因此定义为 OpenAI Chat Completions 协议，配套代码放在 `src/types/ir.ts`：

```ts
export const IRChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(IRMessageSchema).min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();
```

注意三个细节：

- **`.passthrough()`**：允许未声明字段透传到上游。新字段（`response_format`、`tools`、`tool_choice` 等）出现时不需要改 IR schema，上游自己会处理。**这是一条贯穿全书的约定**——「网关不认识的字段一律透传，不假装自己懂」。Ch10 的 prompt caching 用 `cache_control` breakpoint 时，正是靠这一行 `passthrough()` 直接把 `cache_control` 字段送到 Anthropic 上游，网关层零改动。
- **`messages` 与 `model` 强校验**：缺这两个字段任何上游都会 400，提前拦在网关。
- **`stream` 声明但本章不支持**：v0.2 检测到 `stream: true` 直接拒绝，告诉客户端「这个能力第 7 章再加」。

IR 是贯穿全书的核心领域对象之一（截止本章为 1 个：`IR`；后续章节按顺序登场 `Key` (Ch4)、`UsageRecord` (Ch5)、`Channel` (Ch8)，全书共 4 个核心领域对象）。在每一章它都会增量增加字段：第 3 章为了适配 Anthropic 加入 `system` 在顶层、`tool_results` 字段；第 5 章为计费加入 `usage` 元数据；第 7 章为流式加入 chunk 类型枚举。本章先把最小骨架立稳，剩下的字段按需迭代。

响应侧也定义一个 `IRChatResponse` 类型，本质就是 OpenAI Chat Completions 返回结构的 TypeScript 化版本——`id` / `object` / `created` / `model` / `choices` / `usage` 几个字段，外加 `[key: string]: unknown` 兜底允许上游回包的额外字段透传给客户端（例如 DeepSeek 的 `reasoning_content`）。OpenAI 兼容上游的响应可以直接 `JSON.parse` 成 `IRChatResponse`，Anthropic 上游则要在 adaptor 内部做字段映射。无论哪种上游，对外暴露给客户端的最终响应都是同一个 `IRChatResponse`。

## 2.3 ProviderAdaptor 接口的最小形态

IR 定下来之后，「上游差异」要藏在哪里就清楚了——藏在 `ProviderAdaptor` 接口背后。

先看 one-api 的版本。`relay/adaptor/interface.go` 是这样定义的：

```go
type Adaptor interface {
    Init(meta *meta.Meta)
    GetRequestURL(meta *meta.Meta) (string, error)
    SetupRequestHeader(c *gin.Context, req *http.Request, meta *meta.Meta) error
    ConvertRequest(c *gin.Context, relayMode int, request *model.GeneralOpenAIRequest) (any, error)
    ConvertImageRequest(request *model.ImageRequest) (any, error)
    DoRequest(c *gin.Context, meta *meta.Meta, requestBody io.Reader) (*http.Response, error)
    DoResponse(c *gin.Context, resp *http.Response, meta *meta.Meta) (usage *model.Usage, err *model.ErrorWithStatusCode)
    GetModelList() []string
    GetChannelName() string
}
```

9 个方法。`Init` 与 `meta.Meta` 是 one-api 自己的上下文容器，承载请求 ID、用户 ID、channel 信息等。`GetRequestURL` 与 `SetupRequestHeader` 负责拼上游 URL 与注入鉴权。`ConvertRequest` / `ConvertImageRequest` 把 OpenAI 风格请求翻译成上游协议要求的结构。`DoRequest` / `DoResponse` 是实际发请求与解析响应。`GetModelList` / `GetChannelName` 是元信息查询接口。

LiteLLM 的 `BaseConfig` 抽出来的核心钩子是另一组（参见 `litellm/llms/base_llm/chat/transformation.py`）：

| 方法 | 职责 |
|------|------|
| `get_supported_openai_params(model)` | 声明 provider 支持的 OpenAI 参数白名单 |
| `map_openai_params(...)` | 把 OpenAI 风格 optional_params 翻译成本家 provider 字段 |
| `validate_environment(headers, ...)` | 注入鉴权 header、API version 等环境信息 |
| `get_complete_url(api_base, model, ...)` | 拼接完整 endpoint |
| `transform_request(model, messages, ...)` | 把 OpenAI messages + params 转成上游请求体 |
| `transform_response(raw_response, model_response, ...)` | 把上游响应转回 OpenAI ModelResponse |
| `get_model_response_iterator(...)` | 返回流式 chunk 迭代器 |
| `get_error_class(error_message, status_code, headers)` | 把上游 HTTP 错误转成异常类 |

两套设计共享一组核心动作：**拼 URL → 注入鉴权 → 翻译请求 → 解析响应 → 处理错误 → 处理流式**。设计思路是一致的，方法切分粒度不同——one-api 切得粗（请求侧合并成 `ConvertRequest` 一个方法），LiteLLM 切得细（请求侧拆成 `validate_environment` + `get_complete_url` + `map_openai_params` + `transform_request` 四个方法）。粒度选择背后是「灵活性 vs 心智负担」的权衡：粒度细的接口给后续扩展留出更多注入点，但每写一个新 adaptor 都要面对更多空方法；粒度粗的接口写起来轻松，但增加新能力时容易把方法塞臃肿。

本章 v0.2 的接口只取其中 4 个，留出后续章节扩展空间：

```ts
// examples/02-one-endpoint-three-providers/src/adaptors/base.ts
export interface ProviderAdaptor {
  readonly name: string;
  getEndpoint(ir: IRChatRequest): string;
  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string };
  parseResponse(upstreamResp: Response, rawBody: string): Promise<IRChatResponse>;
}
```

四个方法对应四件事：

- **`name`**：渠道名，用于日志归因。第 8 章引入 `Channel` 概念之后，同一个 `name` 可能对应多个 Key 实例，但 adaptor 本身仍是无状态的逻辑。
- **`getEndpoint(ir)`**：计算上游完整 URL。对 OpenAI 兼容族通常是 `${baseURL}/v1/chat/completions`；对 Anthropic 是 `${baseURL}/v1/messages`；对 Azure 还要在 path 里拼上 deployment name 和 api-version。
- **`buildRequest(ir)`**：返回 fetch 需要的 `headers` 与 `body`。鉴权 header（`Bearer ${key}` 还是 `x-api-key: ${key}`）、Content-Type、把 IR 翻译成上游请求体——三件事都在这一步完成。
- **`parseResponse(resp, rawBody)`**：把上游 HTTP 响应归一化为 `IRChatResponse`。OpenAI 兼容族近乎 `JSON.parse`；Anthropic 则要做 `stop_reason` → `finish_reason`、`content blocks` → `message.content` 之类的字段映射。

特意没有放进 v0.2 接口的能力：

- **流式响应解析**：流式涉及 chunk 边界处理、事件归一化、反向取消，复杂度足以独占一章。第 7 章会给接口加 `streamResponse(ir, upstreamStream)` 方法。
- **错误分类与自动禁用**：第 8 章 `Channel` 与故障转移要用，那时会加 `classifyError(status, body)`。
- **token 计数**：第 5 章计费用，独立成 `countTokens(ir)`。
- **多 Key 轮询**：是 `Channel` 层的事，不是 `Adaptor` 层的事。Adaptor 拿到的 Key 永远只有一个，由 Channel 层提前选好传进来。

把不属于「上游协议翻译」的事踢出 Adaptor 接口，是这一版抽象最关键的取舍。one-api 把 `DoRequest` 与 `DoResponse` 直接放进 Adaptor，导致后续加流式、加 channel 切换、加可观测时需要在每个 adaptor 里重复写相同的样板代码（参见 `relay/adaptor/openai/adaptor.go` 的 `DoResponse` 方法，几十行里大半是流式与非流式分支判断）。本书的版本把这些动作留在 Hono 主流程，adaptor 保持纯粹。

这条取舍背后有一个简单原则：**adaptor 只负责「这一家上游的协议长什么样」，不负责「网关怎么把请求发出去、怎么计费、怎么切渠道」**。前者是与 provider 强绑定的领域知识，后者是网关本身的工程逻辑。把两件事混在一起，每接入一家新 provider 都要重写一遍网关主流程，工作量呈乘法增长。分开之后，主流程写一遍即可服务所有 adaptor，新增 provider 只需要实现 3-4 个方法。

## 2.4 OpenAI 适配器：兼容族的「基类」

OpenAI 适配器是 IR 的「身份证」——既然 IR 选择了 OpenAI 协议，OpenAI 上游本身的适配器就近乎透传：

```ts
// examples/02-one-endpoint-three-providers/src/adaptors/openai.ts
export class OpenAIAdaptor implements ProviderAdaptor {
  readonly name: string;
  protected readonly baseURL: string;
  protected readonly apiKey: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  getEndpoint(_ir: IRChatRequest): string {
    return `${this.baseURL}/v1/chat/completions`;
  }

  buildRequest(ir: IRChatRequest) {
    return {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ir),
    };
  }

  async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {
    return JSON.parse(rawBody) as IRChatResponse;
  }
}
```

四个方法每个都贴着「OpenAI 协议本身就是 IR」这一前提：

- `getEndpoint` 拼 `${baseURL}/v1/chat/completions` 固定路径。
- `buildRequest` 用 `Bearer` 注入鉴权，请求体直接 `JSON.stringify(ir)`——因为 IR 字段就是 OpenAI 期望的字段。
- `parseResponse` 直接 `JSON.parse`——因为上游回包结构就是 `IRChatResponse`。

这个类的真正价值不在 OpenAI 自家，而在它被设计成「OpenAI 兼容族基类」。

DeepSeek 与 OpenAI 在协议上 100% 兼容（详见 `research/protocol-adapter-design.md` Part B 的对照表）：

- Endpoint 路径相同：`/v1/chat/completions`
- 鉴权方式相同：`Authorization: Bearer ${apiKey}`
- 请求体字段相同：`model`、`messages`、`temperature`、`max_tokens`、`tools`、`tool_choice`
- 响应结构相同：`choices[0].message`、`usage.prompt_tokens` / `completion_tokens`
- 流式格式相同：`data: {...}\n\ndata: [DONE]\n\n`

差异只有 `deepseek-reasoner` 模型上的 `reasoning_content` 字段（额外字段，不破坏 OpenAI 协议）与 baseURL 不同。在网关侧，这两条差异都不需要在 adaptor 里做处理——`reasoning_content` 用 IR 的 `passthrough` 直接透传给客户端，baseURL 通过构造参数注入。

所以 DeepSeek 适配器的全部实现是：

```ts
// examples/02-one-endpoint-three-providers/src/adaptors/deepseek.ts
export class DeepSeekAdaptor extends OpenAIAdaptor {
  constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
    super({ name: opts.name ?? 'deepseek', baseURL: opts.baseURL, apiKey: opts.apiKey });
  }
}
```

14 行。其中真正有意义的代码只有 1 行——给 `name` 字段一个默认值 `'deepseek'`，其余全是构造函数转发。

这套「继承换 baseURL」的写法不是本书的发明。三家成熟项目都在用同一思路：

- **one-api**：DeepSeek 没有独立适配器目录。`relay/adaptor/deepseek/` 整个目录只有一个 `constants.go` 5 行 ModelList。实际的适配逻辑由 `relay/adaptor/openai/compatible.go` 的 `CompatibleChannels` 列表统一接管，DeepSeek 是其中一员，与 Moonshot、SiliconFlow、xAI、Groq 等共享同一份 OpenAI adaptor。
- **LiteLLM**：`litellm/llms/deepseek/chat/transformation.py` 共 123 行，第 16 行 `class DeepSeekChatConfig(OpenAIGPTConfig):` 直接继承 OpenAI 配置，其余 100 多行只为了处理 `thinking` 与 `reasoning_effort` 两个差异参数。
- **Portkey v1.15.2**：`src/providers/deepseek/api.ts` 全文 18 行，声明 `getBaseURL` 与 `Authorization` header 就完事，`chatComplete` 配置直接复用 OpenAI 风格的字段定义。

DeepSeek 在本书里担任的角色其实是**反例**——它太兼容了，写适配器没难度。这恰好用来证明 v0.2 的抽象在 OpenAI 兼容族内是过关的：接入第三家、第四家、第 N 家兼容上游，都只是「继承 + 换 baseURL」的几十行代码。

要接入 Moonshot、智谱、xAI、Groq 中的任何一家，模板都是：

```ts
export class MoonshotAdaptor extends OpenAIAdaptor {
  constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
    super({ name: opts.name ?? 'moonshot', baseURL: opts.baseURL, apiKey: opts.apiKey });
  }
}
```

智谱 GLM 比 Moonshot 稍复杂一点——它的鉴权是把 API Key 拼装成 JWT 而不是直接当 Bearer Token 用，但这点差异也只是在子类里重写 `buildRequest` 加一段 `jwt.sign(payload, secret, { algorithm: 'HS256' })` 而已，不影响接口本身。换言之，OpenAI 兼容族的所有 provider，差异都集中在「baseURL 与 鉴权细节」这两件事上，对 IR 与响应结构没有冲击。

写完 adaptor，剩下的事就交给路由表。

## 2.5 ModelRouter：按 model 前缀分发

路由层负责把客户端请求里的 `model` 字段映射到具体 adaptor。v0.2 用最简单的实现：一张前缀匹配表。

```ts
// examples/02-one-endpoint-three-providers/src/router.ts
export interface RouteRule {
  prefix: string;
  adaptor: ProviderAdaptor;
}

export class ModelRouter {
  private readonly rules: RouteRule[];

  constructor(rules: RouteRule[]) {
    this.rules = rules;
  }

  resolve(model: string): ProviderAdaptor | undefined {
    for (const rule of this.rules) {
      if (model.startsWith(rule.prefix)) {
        return rule.adaptor;
      }
    }
    return undefined;
  }

  /** healthz 用: 把当前路由表的「前缀 → provider name」摊平出来 */
  describe(): Array<{ prefix: string; provider: string }> {
    return this.rules.map((r) => ({ prefix: r.prefix, provider: r.adaptor.name }));
  }
}
```

装配在 Hono 入口里：

```ts
// examples/02-one-endpoint-three-providers/src/index.ts
const router = new ModelRouter([
  {
    prefix: 'deepseek-',
    adaptor: new DeepSeekAdaptor({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    }),
  },
  {
    prefix: 'gpt-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  // o1-* / o3-* 同样路由到 OpenAI, 此处省略
]);
```

请求处理变成五个清晰步骤：

```ts
app.post('/v1/chat/completions', async (c) => {
  // 1) 入参校验
  const parsed = IRChatRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: '...' }, 400);
  const ir = parsed.data;

  // 2) 按 model 字段路由
  const adaptor = router.resolve(ir.model);
  if (!adaptor) return c.json({ error: 'no provider matched' }, 400);

  // 3) 构造上游请求
  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);

  // 4) 转发
  const upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  const rawBody = await upstreamResp.text();

  // 5) 归一化响应 + 结构化日志
  logger.info({ provider: adaptor.name, model: ir.model, status: upstreamResp.status }, 'relay');
  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  return c.json(irResponse);
});
```

「校验 → 路由 → 构造 → 转发 → 归一化」五步是后续所有章节的主干结构。第 4 章加鉴权（在第 1 步之前插入 middleware），第 5 章加计费（在第 5 步之后写 `UsageRecord`），第 7 章为流式拆出独立分支（第 4 步和第 5 步合并成流式管道），第 8 章为故障转移把第 2 步从单 adaptor 升级为「先选 Channel 再拿 adaptor」。骨架不变，每章在合适的位置插入新模块。

前缀匹配表的设计在生产网关里普遍存在但形态略有不同：

- **one-api** 的等价机制是 `Ability` 反范式索引表（数据库的 `abilities` 表）。一行 `(group, model, channel_id, enabled, priority, weight)` 表示「某个用户组下，某个模型可由哪个渠道在哪个优先级提供」。查询是 `SELECT channel_id FROM abilities WHERE group = ? AND model = ? AND enabled = 1 ORDER BY priority DESC`。这套设计在第 8 章会复刻进本书。
- **Portkey** 用 `conf.json` 配置 + 内存路由表，按 model + virtualKey 多维匹配。
- **LiteLLM** 通过 `litellm.model_list` 配置数组，每个条目带 `model_name`、`litellm_params.model`、`litellm_params.api_base` 等字段，加载到内存后做精确匹配。

本书 v0.2 选用前缀匹配是因为它满足当前需要——`gpt-4o-mini`、`gpt-4o`、`gpt-4-turbo` 都属于 OpenAI，`deepseek-chat`、`deepseek-reasoner` 都属于 DeepSeek。等到第 8 章引入 Channel 之后，路由表会迁移到数据库，匹配规则升级为精确 model 名 + 优先级 + 权重，前缀只是兜底。

`resolve` 方法刻意写成「按声明顺序找到第一个匹配的规则」而不是「最长前缀匹配」。这是因为 v0.2 阶段路由规则数量极少（4 条），按声明顺序更容易让作者控制优先级——把更具体的前缀写在前面，更通用的兜底前缀写在后面即可。当规则数量增长到几十条时，再切换到精确表查询配 trie 索引。这种「先做对，再做快」的演进节奏，比一开始就上数据结构课更符合工程现实。

健康检查接口顺便把当前路由表暴露出来，方便调试：

```ts
app.get('/healthz', (c) =>
  c.json({ ok: true, version: 'v0.2', routes: router.describe() }),
);
```

`curl http://localhost:3000/healthz` 会返回：

```json
{
  "ok": true,
  "version": "v0.2",
  "routes": [
    {"prefix": "deepseek-", "provider": "deepseek"},
    {"prefix": "gpt-", "provider": "openai"},
    {"prefix": "o1-", "provider": "openai"},
    {"prefix": "o3-", "provider": "openai"}
  ]
}
```

## 2.6 为什么不一起把 Anthropic 写了

读到这里，一个合理的疑问是：既然 IR 与 Adaptor 抽象都立起来了，为什么不顺手把第三家 Anthropic 一起加进来？理由是 Anthropic 与 OpenAI 协议在 6 个维度存在结构性差异，每一处都不能用「换 baseURL」糊弄过去。

调研报告 `research/protocol-adapter-design.md` 的 Part B 给出完整对照表，挑出与本章 Adaptor 接口直接相关的 6 条：

| 维度 | OpenAI | Anthropic |
|------|--------|-----------|
| `system` 字段位置 | `messages` 数组里 `role:"system"` 的一条 | 请求体顶层独立字段 `system` |
| `max_tokens` | 可选 | **必填** |
| Endpoint | `/v1/chat/completions` | `/v1/messages` |
| 鉴权 | `Authorization: Bearer $KEY` | `x-api-key: $KEY` + `anthropic-version: 2023-06-01` |
| 工具调用响应 | `message.tool_calls:[{id, function:{name, arguments}}]` | content block `{type:"tool_use", id, name, input}` |
| 流式格式 | 单一 `data: {...}` 事件 | 6 种事件：`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` |

这 6 处差异里：

- `system` 字段位置与 endpoint / 鉴权的差异，可以在本章接口下加一个 `AnthropicAdaptor` 解决（重写 `getEndpoint` 与 `buildRequest`）。
- `max_tokens` 必填要在 `buildRequest` 里做默认值兜底，否则 Anthropic 直接 400。
- 工具调用响应映射要在 `parseResponse` 里做字段重组——`content blocks` 数组 → `message.tool_calls`，每个 `input` 对象 → `arguments` JSON 字符串。
- 工具结果回填方向（OpenAI 的 `role:"tool"` 单独一条 → Anthropic 聚合到一条 user 消息的 `tool_result` block 数组）要在 `buildRequest` 里做 messages 数组重组。
- **流式归一化是真正的难点**：Anthropic 6 种事件类型需要压平成 OpenAI 单一 delta 流，每种事件对应一段状态机逻辑。这部分内容与 SSE 透传层（第 7 章）耦合，本章的 v0.2 接口里压根没有 `streamResponse` 方法。

如果在本章把 Anthropic 一起写了，会发生这样的事：

1. 为了让 Anthropic adaptor 跑通，临时给 `ProviderAdaptor` 接口加流式方法、加 system 提取逻辑、加 tool 字段映射。
2. 这些方法在 OpenAI / DeepSeek adaptor 里要么是 no-op 要么是占位符。
3. 第 3 章「Anthropic 协议适配」剩下的内容只能是「把第 2 章已经写过的几个方法详细讲一遍」，章节失去存在意义。

更糟糕的是，**本章无法验证 Adaptor 接口设计是否真的合理**——只在 OpenAI 兼容族里测，每家都长得跟 IR 一模一样，接口设计得好不好根本看不出来。一个接口设计是否合理，标准从来不是「能不能让相似的 case 跑起来」，而是「能不能在差异最大的 case 上撑住」。前一个标准下任何接口都能过关，后一个标准才有筛选力。

正确的做法是：本章用 OpenAI + DeepSeek 把抽象立起来，然后让第 3 章用 Anthropic 这个「真正异构的上游」对抽象做一次完整压力测试。如果接口在 Anthropic 面前扛不住，第 3 章会修正它——这是抽象设计的常规迭代节奏，比第一次就追求完美靠谱得多。Linus Torvalds 在内核接口设计上的经验是「先让简单 case 跑起来、再用复杂 case 把接口撑开」，这套方法在网关的 provider 抽象上同样适用。

LiteLLM 的演化路径恰好印证这一点。`BaseConfig` 早期只有 `transform_request` / `transform_response` 两个核心方法，是后续 Anthropic、Bedrock、Vertex 等异构上游接入时陆续加上了 `validate_environment`、`map_openai_params`、`get_model_response_iterator`。先有 OpenAI 兼容族的简单 case 立 baseline，再用复杂 case 把接口撑开，最后停在一个能服务 100+ provider 的稳定形态。one-api 的 `Adaptor` 接口同样经历了从 5 个方法扩展到 9 个方法的过程，每一次扩展都伴随一类新上游（图像生成、Embedding、Realtime API）的接入。本书的演进路线与这两家保持一致：v0.2 立最小骨架，v0.3 用 Anthropic 撑开它，v0.7 再加流式相关的方法。

## 2.7 v0.2 的运行验证

把 v0.2 跑起来需要做两件事：填好 `.env`、启动服务。

```bash
cd examples/02-one-endpoint-three-providers
cp .env.example .env
# 编辑 .env:
#   OPENAI_API_KEY=sk-...          (从 platform.openai.com 拿)
#   DEEPSEEK_API_KEY=sk-...        (从 platform.deepseek.com 拿, 充值 ¥10 可用很久)
npm install
npm run dev
```

启动成功后控制台打印 `Gateway v0.2 listening on http://localhost:3000`。

测试同一份请求体只改 `model` 字段：

```bash
# 发到 OpenAI
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"用一句话解释 LLM 中转站"}]}'

# 发到 DeepSeek (只改 model 字段)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"用一句话解释 LLM 中转站"}]}'
```

两次响应的 JSON 结构完全一致——`id` / `object` / `created` / `model` / `choices` / `usage` 字段齐全。客户端代码无需任何修改。

服务端日志会区分 provider：

```
[12:34:56.789] INFO: relay
    provider: "openai"
    model: "gpt-4o-mini"
    status: 200
    latency_ms: 812

[12:34:58.012] INFO: relay
    provider: "deepseek"
    model: "deepseek-chat"
    status: 200
    latency_ms: 1456
```

`provider` 字段从 v0.2 开始出现在每条日志里，后续章节会在它的基础上加 `trace_id`、`channel_id`、`key_id`、`tokens_in/out`。

异常路径也覆盖到了：

- 缺 `messages` 字段：400 + zod 错误详情
- `model` 没有匹配任何前缀（例如 `claude-sonnet-4-5`）：400 + 当前可用路由列表
- 上游网络层错误（DNS / TCP / 超时）：502
- 上游业务错误（Key 无效、模型不存在）：原样透传上游的 status 与 error body
- 流式请求（`stream: true`）：400 + 「streaming is not supported in v0.2, will be added in Ch7」

这里有一个值得专门讨论的细节：上游返回 4xx / 5xx 时，v0.2 选择把上游原始错误体透传给客户端，而不是统一翻译成网关自己的错误格式。理由是 OpenAI 的错误结构（`{ error: { type, code, message } }`）本身就是事实标准，客户端 SDK（如 openai-node）会按这套结构解析错误信息。把上游错误透传，对 OpenAI 兼容族而言天然兼容；对 Anthropic 这种异构上游，第 3 章会在 `parseResponse` 的兄弟方法 `parseError` 里做错误归一化。在 v0.2 这一版，「2xx 走 parseResponse、非 2xx 原样透传」是最简单也最不容易出错的策略。

## 2.8 一个常见的设计陷阱：过早抽象

读到这里值得停下来想一个问题：为什么 v0.2 的接口只有 4 个方法、不多不少？

经验上有一个很容易踩的坑：在接入第二家上游时就想清楚未来 N 家上游的所有差异，把接口一次性设计完整。结果是接口长出十几个方法，多数方法在多数 adaptor 里都是占位实现，新接入一家上游要先看懂这十几个方法分别干什么——对读者和后续维护者都是巨大负担。

更稳的做法是「接口跟着真实需求长」。v0.2 只接入 OpenAI 与 DeepSeek，所有真实需求合并起来就是 4 个方法。v0.3 接入 Anthropic 时会发现需要加方法（流式、错误归一），那时再加。v0.7 引入流式专章时再加 `streamResponse`。每一次扩展都有明确的真实需求驱动，没有为想象中的未来需求买单。

这种做法的代价是接口会经历几次重构，但每次重构都是「在已经跑起来的 4 个方法上加 1-2 个」，而不是「在 15 个方法的废墟里挖出真正需要的 5 个」。前者的工作量远小于后者，因为前者的每一步都有真实代码作为验证依据。

`research/protocol-adapter-design.md` 在 Part A 末尾总结的设计模式里，第 1 条「OpenAI 当作金标准协议」和第 3 条「协议不兼容的走完整实现」其实暗含一个前提：**不要试图为所有 provider 设计一个完美中立的接口**，而是「先服务最常见的 provider，再用最异构的 provider 撑开它」。OpenAI 兼容族走基类继承，异构协议走完整实现——这恰恰是 v0.2 与 v0.3 两章的分工。

## 2.9 本章小结

v0.2 在 v0.1 之上加了三件事：

1. **统一 IR（`src/types/ir.ts`）**：用 OpenAI Chat Completions 协议作为网关内部的中间表示。这是事实标准带来的工程优势，也是 one-api / Portkey / LiteLLM 共同的选择。
2. **`ProviderAdaptor` 接口（`src/adaptors/base.ts`）**：四个最小方法 `name` / `getEndpoint` / `buildRequest` / `parseResponse`。OpenAI 兼容族走基类 + 继承，差异只在 baseURL；异构协议要重写多个方法，但接口契约不变。
3. **`ModelRouter`（`src/router.ts`）**：按 `model` 字段前缀分发。第 8 章会把它升级为「Channel 反范式索引表」。

读完本章，读者应该能够：

- 解释 IR 为何选 OpenAI 兼容协议而非自定义协议
- 对照 one-api / LiteLLM / Portkey 的源码组织方式，理解三家项目在同一组核心动作上的命名差异与共同点
- 用约 30 行代码为任何 OpenAI 兼容上游（Moonshot、智谱、xAI、Groq、SiliconFlow……）补一个适配器
- 在本地跑通 v0.2，用同一份请求体只改 `model` 字段切换 OpenAI 与 DeepSeek

## 配套代码

完整可运行的 v0.2 代码在 `examples/02-one-endpoint-three-providers/`，目录结构：

```
src/
  index.ts           # Hono 入口, 按 model 路由
  types/ir.ts        # IR 类型定义
  adaptors/
    base.ts          # ProviderAdaptor 接口
    openai.ts        # OpenAI 实现 (兼容族基类)
    deepseek.ts      # DeepSeek 实现 (继承 OpenAIAdaptor, 14 行)
  router.ts          # 模型路由表
```

按 README 指引 `npm install && npm run dev` 即可起服务。准备两把 Key（OpenAI 与 DeepSeek 任一可只填一家用，另一家请求会被上游拒绝但服务本身能跑起来），用同一份请求体只改 `model` 字段验证路由生效。

## 下一章预告

v0.2 的 `ProviderAdaptor` 抽象只在 OpenAI 兼容族内验证过——这一族的所有上游本质上都是「把 OpenAI 协议换个 baseURL 重新对外暴露」，对抽象本身不构成压力。

第 3 章接入 Anthropic Messages API，这是与 OpenAI 在 6 个维度存在结构性差异的真正异构协议：`system` 在顶层、`max_tokens` 必填、endpoint 是 `/v1/messages`、鉴权用 `x-api-key`、工具调用走 content block、流式格式分 6 种事件。这套差异会逼着本章定下的 4 个接口方法重新审视——`buildRequest` 要做 messages 数组重组、`parseResponse` 要做 content block 拍平、整个接口还要加上目前没有的 `streamResponse` 方法。

第 3 章读完，读者将得到一套已经经过异构协议压力测试的稳定抽象，以及一份覆盖三家上游（OpenAI / DeepSeek / Anthropic）的 v0.3 网关。这是后续每一章引入鉴权、计费、限流、流式时都会复用的基础设施。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
