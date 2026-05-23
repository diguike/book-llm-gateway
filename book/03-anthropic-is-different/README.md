---
title: 第 3 章 Anthropic 协议适配
feishu_url: "https://www.feishu.cn/wiki/DDsBwzyvgiFDUrk9gBgcLOO5n1b"
last_synced: "2026-05-16T18:28:36"
---

## 3.1 「换 base_url」为什么不行

v0.2 把 OpenAI 兼容族跑通了。DeepSeek 适配器只有 14 行，三句话能讲完原理：换 baseURL、继承基类、对外照常。当读者带着这套心智模型尝试接入第三家上游 Anthropic 时，问题会立刻显现。

最朴素的做法是这样：参照 DeepSeek 的写法，再加一个 `AnthropicAdaptor extends OpenAIAdaptor`，构造时把 baseURL 换成 `https://api.anthropic.com`，把鉴权 header 改成 `x-api-key`。然后发一次 `claude-sonnet-4-5` 的请求试试。结果是上游 404——`/v1/chat/completions` 这个 path 在 Anthropic 不存在。Anthropic Messages API 的入口是 `/v1/messages`。

把 path 改对，再发一次，这次上游回 400：

```json
{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: field required"}}
```

OpenAI 的 `max_tokens` 是可选的（实际上 OpenAI 已经迁移到 `max_completion_tokens`），Anthropic Messages API 把 `max_tokens` 列为必填字段。客户端不传，网关也得给个默认值兜底。

把 `max_tokens` 补上，再发一次，这次上游回的是 200 但客户端炸了：

```json
{
  "id": "msg_01...",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [{"type": "text", "text": "..."}],
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 12, "output_tokens": 24}
}
```

OpenAI 客户端 SDK 拿到这个回包后会去找 `choices[0].message.content`、`finish_reason`、`usage.prompt_tokens` 三个字段，一个都找不到。Anthropic 的字段名是 `content`（top-level 数组）/ `stop_reason` / `usage.input_tokens`。这是字段命名的差异。

把响应字段翻译过去，再加 system 消息试试。OpenAI 客户端习惯写 `messages:[{role:"system",content:"你只用中文"}, {role:"user",content:"..."}]`，Anthropic 直接 400：

```json
{"type":"error","error":{"type":"invalid_request_error","message":"messages: Roles must alternate between user and assistant, found system at index 0"}}
```

system 在 Anthropic 不允许出现在 messages 数组里——它是请求体顶层的独立字段。

再加上工具调用、工具结果回填、流式响应，每一处都会撞上新的差异。所以「Anthropic = OpenAI + 换 baseURL」是一条走不通的路。Anthropic Messages API 与 OpenAI Chat Completions 在 6 个维度存在结构性差异，每一处都必须在 adaptor 内部做显式翻译。本章的任务是把这 6 处差异逐一拆解，落地一个 `AnthropicAdaptor`，并用它压力测试 Ch2 定下来的 `ProviderAdaptor` 接口是否扛得住。

还有一件事在动手前要先说清楚：本章的翻译工作是**双向**的。客户端发请求时，是 OpenAI 形态翻译成 Anthropic 形态发上游；上游回响应时，是 Anthropic 形态翻译回 OpenAI 形态返给客户端。「双向」不是修辞，而是工程：请求方向的翻译错了，上游会 400；响应方向的翻译错了，客户端 SDK 解析失败抛异常。后者通常更难排查——上游 200 看似一切正常，客户端这边的报错栈又指向 SDK 内部。两个方向都要 case-by-case 写对，且每个差异都要有「请求方向怎么处理 / 响应方向怎么处理」的明确答案。

除了 OpenAI ↔ Anthropic 这条主路径之外，本章还要给「不愿意走翻译层」的客户端留一条旁路：直接对外暴露 `/v1/messages`，让 Claude Code 这类原生客户端把 base URL 指向网关就能用。旁路的实现要简单很多（只是反向代理 + 鉴权占位），但它的存在保证了网关不会因为翻译层的边角问题（thinking block 字段丢失、cache_control 元数据没法表示等）拒绝任何 Anthropic 生态的客户端。两条路径在后续章节会共用同一套鉴权、计费、限流中间件，对 Ch4 起的所有基础设施透明。

## 3.2 6 处差异速查表

调研报告 `research/protocol-adapter-design.md` 的 Part B 给出了完整对照表。本章关心其中 6 处与协议适配直接相关的差异：

| 编号 | 维度 | OpenAI | Anthropic |
|------|------|--------|-----------|
| 1 | system 字段 | `messages` 数组中 `role:"system"` 的一条 | 请求体顶层独立 `system` 字段 |
| 2 | messages 结构 | 单层 `{role, content}` | content 可为 block 数组；工具结果必须用 user 包装 |
| 3 | tools 字段 | `tools[].function.{name, description, parameters}` | `tools[].{name, description, input_schema}` |
| 4 | tool 结果回填 | 独立 `role:"tool"` 消息带 `tool_call_id` | `user.content` 里的 `tool_result` block |
| 5 | 结束原因字段 | `finish_reason`: stop / length / tool_calls / content_filter | `stop_reason`: end_turn / max_tokens / stop_sequence / tool_use |
| 6 | 流式事件 | 单一 `data: {...}` | 6 种事件：message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop |

外加 endpoint（`/v1/messages` 而不是 `/v1/chat/completions`）、鉴权（`x-api-key + anthropic-version` 而不是 `Authorization: Bearer`）、`max_tokens` 必填这三处「配置类差异」，本章 adaptor 内一并处理掉。

把这些差异和「OpenAI 兼容族只换 baseURL」对比一下，工作量的差距才直观：DeepSeek 适配器 14 行可以完工，是因为它和 OpenAI 在上面 6 + 3 = 9 个维度全部一致；Anthropic 这 9 个维度无一例外都需要显式翻译，落到代码上是 200 行起步。**协议差异不是「需要多写几行」的问题，而是「需要在适配器内部建一个完整的双向翻译器」的问题。** 这也是为什么 one-api 的 anthropic 目录有 4 个 Go 文件（adaptor.go + main.go + model.go + constants.go），portkey 的 anthropic 目录有 7 个 TS 文件——它们不是过度工程，是协议差异本身要求的代码量。

下面六节按编号逐个拆解，每节走「问题 → 现象 → 解法」三步结构。读完六节再看完整的 `AnthropicAdaptor` 代码就只剩组装。

## 3.3 差异 1：system 抽出顶层

问题。OpenAI 的 `system` 是 messages 数组里 `role:"system"` 的一条普通消息，可以出现在任意位置（虽然惯例放第一条），可以出现多次。Anthropic 的 `system` 是请求体顶层的独立字段，类型是字符串或 content block 数组，**不允许**出现在 messages 里。

现象。把 OpenAI 风格的 messages 原样转发给 Anthropic 会收到：

```
"Roles must alternate between user and assistant, found system at index 0"
```

解法。在 `buildRequest` 里扫描 messages，把所有 `role:"system"` 抽出来，按出现顺序拼接成顶层 `system` 字段；剩下的 messages 删掉这些条目再交给 messages 重组逻辑。

LiteLLM 用一个独立函数处理这件事，源码在 `litellm/llms/anthropic/chat/transformation.py:1594` 的 `translate_system_message`。one-api 则把这件事内联在 `ConvertRequest` 主循环里，`relay/adaptor/anthropic/main.go:91-94` 是这样写的：

```go
if message.Role == "system" && claudeRequest.System == "" {
    claudeRequest.System = message.StringContent()
    continue
}
```

注意 one-api 这段代码只取第一条 system 消息——后续的 system 会被当作普通 user/assistant 处理，这与 Anthropic 规范不严格一致（OpenAI 允许多条 system，Anthropic 应当合并）。本书的实现选择合并多条 system，与 LiteLLM 对齐：

```ts
const systemParts: string[] = [];
const restMessages: IRMessage[] = [];
for (const m of ir.messages) {
  if (m.role === 'system') {
    if (typeof m.content === 'string' && m.content.length > 0) {
      systemParts.push(m.content);
    } else if (Array.isArray(m.content)) {
      // OpenAI system 也可能是 [{type:'text', text:'...'}], 取所有 text 拼接
      for (const part of m.content) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
          const text = (part as { text?: string }).text;
          if (typeof text === 'string' && text.length > 0) systemParts.push(text);
        }
      }
    }
  } else {
    restMessages.push(m);
  }
}
```

后续的 messages 重组只看 `restMessages`。`systemParts` 在请求体最后阶段拼接成单字符串（用 `\n\n` 分隔多条）赋给顶层 `system` 字段；若所有 system 都是空字符串，直接不写 `system` 字段——Anthropic 收到空字符串的 `system` 会 400。

## 3.4 差异 2：messages 重组（tool_result 必须包装回 user）

问题。OpenAI 的 messages 是单层结构：`{role, content}`，role 取 `user / assistant / tool` 之一，content 是字符串（或字符串数组用于多模态）。Anthropic 的 messages 也是 `{role, content}`，但：

- `role` 只能是 `user` 或 `assistant`（没有独立的 `tool` 角色）。
- `content` 永远是 block 数组：`text` block、`tool_use` block、`tool_result` block、`image` block 等。
- 工具调用结果（OpenAI 写作 `{role:"tool", tool_call_id, content}`）必须包装成 `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}`。
- assistant 的工具调用（OpenAI 写作 `{role:"assistant", content:null, tool_calls:[...]}`）必须翻译成 `{role:"assistant", content:[{type:"text", text:"..."}, {type:"tool_use", id, name, input}]}`。

现象。把 OpenAI 多轮工具调用对话原样转发到 Anthropic，会收到「role must be user or assistant」或「unknown content type tool」之类的 400 错误。

解法。重写 messages 数组，按 role 分发：

- `role:"user"`：content 字符串 → `[{type:"text", text}]`；content 数组按 type 分发（本章只演示 text，多模态留给后续章节）。
- `role:"assistant"`：先把文本翻成 `text` block；如果还有 `tool_calls` 字段，按顺序追加 `tool_use` block。注意 `tool_calls[].function.arguments` 在 OpenAI 是 JSON 字符串，Anthropic 的 `input` 要求是结构化对象，**必须 `JSON.parse` 回来**。
- `role:"tool"`：必须包装回 user。注意连续多条 tool 消息（多个并行工具调用的结果）应该聚合到同一条 user 消息里——Anthropic 推荐这种写法。

聚合逻辑用一个 `pendingToolResults` 缓冲队列实现：每遇到一条 `role:"tool"` 就 push 到队列；遇到任何非 tool 消息前先 flush 成一条 `user.content` block 数组：

```ts
let pendingToolResults: AnthropicToolResultBlock[] = [];
const flushPendingToolResults = () => {
  if (pendingToolResults.length > 0) {
    result.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  }
};

for (const m of messages) {
  if (m.role === 'tool') {
    pendingToolResults.push({
      type: 'tool_result',
      tool_use_id: m.tool_call_id ?? '',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    });
    continue;
  }
  flushPendingToolResults();
  // ... 处理 user / assistant 分支
}
flushPendingToolResults(); // 末尾 flush 一次
```

Portkey v1.15.2 的实现在 `src/providers/anthropic/chatComplete.ts:184-196`，单条 tool 翻译做得很干净但没做多条聚合：

```ts
const transformToolMessage = (msg: Message): AnthropicMessage => {
  const tool_use_id = msg.tool_call_id ?? '';
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id, content: msg.content },
    ],
  };
};
```

每条 tool 消息独立成一条 user 消息在 Anthropic 也能跑通，只是不够地道。本书选择聚合写法，保持单元测试可以直接对照 Anthropic 官方文档的多轮工具调用样例。

assistant 分支同样要注意：OpenAI 的 `tool_calls[].function.arguments` 字段是 JSON **字符串**，Anthropic 的 `tool_use.input` 是结构化 **对象**。这一处方向翻转的细节非常容易写错：

```ts
let input: Record<string, unknown> = {};
if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
  try {
    input = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    input = { __raw: call.function.arguments };
  }
}
blocks.push({ type: 'tool_use', id: call.id ?? '', name: call.function?.name ?? '', input });
```

`try/catch` 不是为了静默吞错——模型偶尔会吐出残缺 JSON，这里把残缺 JSON 包成 `{__raw: ...}` 让 Anthropic 自己 400，比 adaptor 这层假装解析成功更安全。

one-api 在 `relay/adaptor/anthropic/main.go:111-119` 做同样的事，但没有 catch 分支：

```go
inputParam := make(map[string]any)
_ = json.Unmarshal([]byte(message.ToolCalls[i].Function.Arguments.(string)), &inputParam)
claudeMessage.Content = append(claudeMessage.Content, Content{
    Type:  "tool_use",
    Id:    message.ToolCalls[i].Id,
    Name:  message.ToolCalls[i].Function.Name,
    Input: inputParam,
})
```

`_ = json.Unmarshal` 把错误吞掉，残缺 JSON 会变成空 map 传给上游，Anthropic 那边的 tool 实际能跑但参数全丢。这种「错得无声」比直接 400 更难排查。在 TS 实现里加一个最小 catch 就能把信号保住。

## 3.5 差异 3：tools 字段命名与结构

问题。OpenAI 的工具定义：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "查询指定城市的天气",
    "parameters": {"type":"object","properties":{...},"required":[...]}
  }
}
```

Anthropic 的工具定义：

```json
{
  "name": "get_weather",
  "description": "查询指定城市的天气",
  "input_schema": {"type":"object","properties":{...},"required":[...]}
}
```

差异有三处：外层不需要 `{type:"function", function:{...}}` 这层包裹；字段名从 `parameters` 改成 `input_schema`；`input_schema` 的 type 字段必须是 `"object"`（OpenAI 也建议 object，但不强制）。

解法。`transformTools` 做一次字段重命名 + 平移：

```ts
function transformTools(tools: unknown[]): AnthropicTool[] {
  const result: AnthropicTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as {
      type?: string;
      function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
    };
    if (tool.type !== 'function' || !tool.function?.name) continue;
    const params = tool.function.parameters ?? { type: 'object', properties: {} };
    result.push({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        type: 'object',
        properties: (params as { properties?: Record<string, unknown> }).properties ?? {},
        required: (params as { required?: string[] }).required ?? [],
        ...Object.fromEntries(
          Object.entries(params).filter(
            ([k]) => k !== 'type' && k !== 'properties' && k !== 'required',
          ),
        ),
      },
    });
  }
  return result;
}
```

最后那个 `Object.fromEntries` 的存在是为了透传 `$defs` / `additionalProperties` / `enum` 这类 JSON Schema 字段——OpenAI 客户端有时会传完整的 JSON Schema 进来，Anthropic 也支持这些字段，直接透传比维护一份白名单稳。Portkey 的实现（`chatComplete.ts:368-414`）显式列举了 `$defs`，但漏掉了 `additionalProperties` 等不太常见但合法的字段；本书的写法更宽容。

`tool_choice` 同样要翻译。映射规则是：

- OpenAI `"auto"` → Anthropic `{type:"auto"}`
- OpenAI `"required"` → Anthropic `{type:"any"}`（注意 Anthropic 用 `any` 表示「必须挑一个工具」）
- OpenAI `"none"` → Anthropic `{type:"none"}`
- OpenAI `{type:"function", function:{name}}` → Anthropic `{type:"tool", name}`

`transformToolChoice` 函数把上面四种 case 平铺翻译就完事了，10 行代码。

工具名字段还有一个细节坑要提一下：OpenAI 对 `tools[].function.name` 的格式约束相对宽松，允许 `foo/bar`、`foo.bar` 这种带斜杠或点号的命名（LangChain 自动生成的工具名经常长这样）；Anthropic 的正则约束是 `^[a-zA-Z0-9_-]{1,128}$`，斜杠、点号、空格都会被 400 拒绝。LiteLLM 在 `transformation.py` 的 `_sanitize_tool_names_in_request` 里做了「替换非法字符 + 保存反向映射表」的处理，响应里再把原名映射回来。本书的 v0.3 不做这层防御——若客户端真的发了非法工具名，让 Anthropic 自己 400，把信号清晰地传回客户端比 adaptor 偷偷重命名更稳。等读者真在生产里遇到这种 case，再参照 LiteLLM 的实现加一个 sanitizer 即可。

## 3.6 差异 4：tool_result 回填机制

差异 4 与差异 2 紧密耦合：messages 重组里 `role:"tool"` → `user.tool_result` 这件事已经做了，这一节说清楚字段对应关系的细节。

OpenAI 的工具结果消息：

```json
{"role":"tool","tool_call_id":"call_abc123","content":"{\"temperature\":22,\"unit\":\"C\"}"}
```

Anthropic 的工具结果 block（包在 user 消息里）：

```json
{
  "role": "user",
  "content": [
    {"type":"tool_result","tool_use_id":"toolu_abc123","content":"{\"temperature\":22,\"unit\":\"C\"}"}
  ]
}
```

注意三件事：

- 字段名从 `tool_call_id` 改成 `tool_use_id`。
- ID 取值是同一个——它是上一轮 assistant tool_call 的 id。assistant 的 `tool_calls[].id` 在 OpenAI 与 Anthropic 双向翻译过程中保持原样透传，不需要重命名。也就是说，如果 assistant 是 OpenAI 自家生成的，id 形如 `call_xxx`；如果是 Anthropic 生成的（经过 `parseResponse` 翻译），id 形如 `toolu_xxx`。两种 id 在 Anthropic 那边都接受，因为它只校验「上一条 assistant 消息里出现过这个 id」这件事。
- content 仍然是字符串。Anthropic 也接受 content 是 block 数组（例如返回带图片的工具结果），但 OpenAI 标准协议里 tool 消息的 content 是字符串，本章保持字符串透传，多模态工具结果留给后续章节。

LiteLLM 的实现（`anthropic_messages_pt` 函数）会做更复杂的归一化——它把 content 是 list 的情况展开成多个 tool_result block。本书的 v0.3 不做这层展开，保持 1:1 映射，便于读者对照官方文档读代码。

工程上还要注意一处实测过才会发现的坑：**Anthropic 要求 messages 第一条必须是 user 角色**。如果客户端连续发送两轮工具调用对话，并且历史里 assistant 的 tool_use 在中间、tool 结果在后面，重组后的 messages 序列可能出现 `[assistant, user(tool_result), assistant, user(tool_result), ...]` 的结构——首条是 assistant，Anthropic 会 400。这种情况发生在客户端把第一轮的 system + user 都吃掉、只把 assistant 的 tool_use + tool 的结果发给网关时（典型场景：客户端做了对话压缩）。本书的 v0.3 不做兜底——这是客户端发请求的语义问题，adaptor 不该擅自补一条空 user。LiteLLM 选择「在最前面插一条空 user」兜底；one-api 不做处理。两种处理都可以，关键是文档里说清楚行为。

## 3.7 差异 5：stop_reason / finish_reason 映射

问题。两家协议的字段名与取值都不一样：

| OpenAI `finish_reason` | Anthropic `stop_reason` |
|------------------------|--------------------------|
| `stop` | `end_turn` |
| `stop` | `stop_sequence` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | （Anthropic 没有等价值，触发内容审查时返回 4xx 错误响应，不在 stop_reason 里） |

这处差异看起来是字段命名问题，实际牵涉的是「客户端怎么决定下一步动作」的关键信号。客户端 SDK 通常会基于 `finish_reason` 决定：`stop` 表示对话结束、`length` 表示需要 continue 续写、`tool_calls` 表示要执行工具再回灌结果、`content_filter` 表示要给用户提示被审查。这五个值的语义任何一个翻译错都会让客户端做错决策。所以 stop_reason 映射应当独立成一个函数，单元测试覆盖所有取值，错一处都是事故。

解法。一个纯函数搞定：

```ts
export function stopReasonToFinishReason(
  stopReason: AnthropicResponse['stop_reason'] | undefined,
): string | null {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return stopReason;
  }
}
```

`default` 分支把未知值原样透传——Anthropic 后续可能加新的 stop_reason 取值，让客户端看到比 adaptor 强制改写更安全。one-api 在 `main.go:21-37` 用同样的写法。

这个函数在两处复用：非流式 `parseResponse` 写 `choices[0].finish_reason` 时用，流式归一化器处理 `message_delta` 事件时用。提出来放在 adaptor 顶层供两处 import。

## 3.8 差异 6：流式 6 种事件归一化为 OpenAI delta chunk

问题。OpenAI 流式 SSE 只有一种事件结构：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"好"}}]}

data: [DONE]
```

Anthropic 流式 SSE 一共 6 种事件，每种事件携带不同语义：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","role":"assistant","model":"...","usage":{"input_tokens":12,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}
```

6 种事件分别承担：消息级的开始/增量/结束、内容块的开始/增量/结束。content_block_delta 的 `delta.type` 还会进一步分支为 `text_delta` / `input_json_delta` / `thinking_delta`——分别对应文本增量、工具调用参数 JSON 增量、扩展思考增量。

解法。本章不做 SSE 透传（Ch7 的任务），但**事件归一化器**先写好——把每个 Anthropic 事件压成 0..N 个 OpenAI delta chunk。归一化器需要跨事件维护状态（id / model / 当前 block 的类型 / tool_calls 数组索引），所以用 class 而非纯函数。

状态机入口签名：

```ts
export class AnthropicEventNormalizer {
  push(event: AnthropicStreamEvent): { chunks: OpenAIDeltaChunk[]; done: boolean };
}
```

每来一个 Anthropic 事件，归一化器返回 0..N 个 OpenAI chunk 和一个 `done` 标志。`done=true` 时上层应该发出 `data: [DONE]\n\n` 并关闭连接。

各事件的映射策略：

- `message_start`：保存 id / model / input_tokens；发首块 `{delta:{role:'assistant',content:''}}`，与 OpenAI 首块对齐。
- `content_block_start`（type 为 `text`）：不发 chunk，等 `content_block_delta`。
- `content_block_start`（type 为 `tool_use`）：发一块带 `tool_calls[].{index, id, type, function:{name, arguments:""}}` 的 delta，并把 block index 与 `tool_calls.index` 绑定，便于后续 `input_json_delta` 累加 arguments。
- `content_block_delta`（type 为 `text_delta`）：发 `{delta:{content:text}}`。
- `content_block_delta`（type 为 `input_json_delta`）：发 `{delta:{tool_calls:[{index, function:{arguments:partial_json}}]}}`。
- `content_block_delta`（type 为 `thinking_delta`）：发 `{delta:{reasoning_content:thinking}}`——借用 DeepSeek reasoner 已经在生态里推广的字段名，让客户端代码可以复用同一份「推理内容」处理逻辑。
- `content_block_stop`：吃掉，不发 chunk。OpenAI 没有「block 边界」的概念。
- `message_delta`：发一块带 `finish_reason` 与 `usage` 的 chunk。`finish_reason` 复用上一节的 `stopReasonToFinishReason`。
- `message_stop`：返回 `done:true`，上层补 `data: [DONE]\n\n`。
- `error`：发一块带 `finish_reason` 的终止 chunk，再补 `done:true`。

Portkey 在 `chatComplete.ts:636-832` 用一份 `streamState` 平铺写完整个归一化逻辑，逻辑正确但函数体偏长。one-api 的实现（`main.go:149-208`）走 switch case，但少了「Anthropic block index 与 OpenAI tool_calls index 的双向绑定」这层管理——并行多个 tool_use block 会出问题。LiteLLM 用 `ModelResponseIterator` 类封装状态（`handler.py:775`），结构最干净，本书的实现照这套思路写：

```ts
export class AnthropicEventNormalizer {
  private id = '';
  private model = '';
  private promptTokens = 0;
  private blockTypes = new Map<number, 'text' | 'tool_use' | 'thinking'>();
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;

  push(event: AnthropicStreamEvent): NormalizedOutput {
    switch (event.type) {
      case 'message_start':
        this.id = event.message.id;
        this.model = event.message.model;
        this.promptTokens = event.message.usage.input_tokens ?? 0;
        return {
          chunks: [this.makeChunk({ delta: { role: 'assistant', content: '' }, finish_reason: null })],
          done: false,
        };

      case 'content_block_start': {
        const block = event.content_block;
        this.blockTypes.set(event.index, block.type);
        if (block.type === 'tool_use') {
          const toolIdx = this.nextToolIndex++;
          this.toolIndexByBlock.set(event.index, toolIdx);
          // 发 tool_calls 首块: index + id + type + function.name + 空 arguments
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    { index: toolIdx, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        return { chunks: [], done: false };
      }

      case 'content_block_delta': {
        const delta = event.delta;
        // 三个 delta 子分支必须分别处理, 不能合并
        if (delta.type === 'text_delta') {
          return {
            chunks: [this.makeChunk({ delta: { content: delta.text }, finish_reason: null })],
            done: false,
          };
        }
        if (delta.type === 'input_json_delta') {
          // tool_use 参数 JSON 增量, 用 block.index 反查对应的 tool_calls 索引
          const toolIdx = this.toolIndexByBlock.get(event.index);
          if (toolIdx === undefined) return { chunks: [], done: false };
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    { index: toolIdx, function: { arguments: delta.partial_json } },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        if (delta.type === 'thinking_delta') {
          // 借用 DeepSeek reasoner 的 reasoning_content 字段名, 客户端可以复用同一份逻辑
          return {
            chunks: [this.makeChunk({ delta: { reasoning_content: delta.thinking }, finish_reason: null })],
            done: false,
          };
        }
        return { chunks: [], done: false };
      }

      case 'content_block_stop':
        // OpenAI 没有 block 边界概念, 吃掉
        return { chunks: [], done: false };

      case 'message_delta': {
        const stopReason = event.delta?.stop_reason ?? null;
        const finishReason = stopReason ? stopReasonToFinishReason(stopReason) : null;
        const usage = event.usage
          ? {
              prompt_tokens: this.promptTokens,
              completion_tokens: event.usage.output_tokens ?? 0,
              total_tokens: this.promptTokens + (event.usage.output_tokens ?? 0),
            }
          : undefined;
        return {
          chunks: [this.makeChunk({ delta: {}, finish_reason: finishReason, usage })],
          done: false,
        };
      }

      case 'message_stop':
        // 上层负责补 data: [DONE]\n\n
        return { chunks: [], done: true };

      case 'error':
        return {
          chunks: [this.makeChunk({ delta: {}, finish_reason: 'stop' })],
          done: true,
        };

      default:
        return { chunks: [], done: false };
    }
  }
}
```

`blockTypes` 与 `toolIndexByBlock` 这两张表是关键。Anthropic 的 `content_block_delta` 只带 block 的 index 数字，不带 block 的 type——归一化器必须自己在 `content_block_start` 时把 index 与 type 关联起来，否则 `input_json_delta` 来了不知道该塞到哪个 tool_calls 索引下。one-api 在并行多 tool_use 场景下出 bug 就是因为没维护这张索引表。

写好归一化器之后，Ch7 的 SSE 主循环会负责：从上游 ReadableStream 逐行读出 Anthropic SSE → 调用 `parseAnthropicSSELine` 解析成事件 → 喂给 `AnthropicEventNormalizer.push` → 把产出的 OpenAI chunk 序列化成 `data: ...\n\n` 写回客户端。本章只把归一化器写好，留作 Ch7 的输入。

## 3.9 落地 AnthropicAdaptor：把六处差异组装起来

四个 `ProviderAdaptor` 接口方法对 Anthropic 的实现长这样：

```ts
export class AnthropicAdaptor implements ProviderAdaptor {
  readonly name: string;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicAdaptorOptions) {
    this.name = opts.name ?? 'anthropic';
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  getEndpoint(_ir: IRChatRequest): string {
    return `${this.baseURL}/v1/messages`;
  }

  buildRequest(ir: IRChatRequest) {
    const body = irToAnthropicRequest(ir, this.defaultMaxTokens);
    return {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  }

  async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {
    const parsed = JSON.parse(rawBody) as AnthropicResponse;
    return anthropicResponseToIR(parsed);
  }
}
```

`irToAnthropicRequest` 调用前面 3.3 ~ 3.6 节的辅助函数把 IR 翻译成 Anthropic 请求体；`anthropicResponseToIR` 把 Anthropic 响应反向翻译回 OpenAI 结构。两个函数各 30 行左右，完整代码在 `examples/03-anthropic-is-different/src/adaptors/anthropic.ts`。

`anthropicResponseToIR` 是响应方向的统一入口，做的事是：

```ts
export function anthropicResponseToIR(resp: AnthropicResponse): IRChatResponse {
  let text = '';
  const toolCalls = [];

  for (const block of resp.content ?? []) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: IRChatResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: resp.id ?? '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model ?? '',
    choices: [{ index: 0, message, finish_reason: stopReasonToFinishReason(resp.stop_reason) }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}
```

content blocks 数组拍平到一段字符串放进 `message.content`，tool_use blocks 累积成 `tool_calls`，input 对象 `JSON.stringify` 成 arguments 字符串。usage 字段名重命名。stop_reason 走专用映射。整个函数没有任何状态，是个纯函数，便于单元测试。

要点提示一处：当响应里同时存在 `text` block 与 `tool_use` block 时（Claude 在生成工具调用前会先吐一段文本），`message.content` 应当是文本字符串，`message.tool_calls` 应当是非空数组，**两个字段同时存在**。OpenAI 自家协议是允许这种共存的（部分早期客户端 SDK 不处理这种 case，会忽略 content 只看 tool_calls，或者反过来）。本书的实现按规范双字段都写——客户端应自行处理。Portkey 在 `chatComplete.ts:586-620` 的实现同样保留两个字段，并额外暴露 `content_blocks` 给非严格 OpenAI 兼容模式。本书的 v0.3 不暴露 `content_blocks`，因为后续章节的鉴权与计费层不打算依赖这个非标字段。

注册到主流程只要一行——在 `src/index.ts` 的 router 数组里加一条：

```ts
const router = new ModelRouter([
  { prefix: 'deepseek-', adaptor: deepSeekAdaptor },
  { prefix: 'claude-',   adaptor: anthropicAdaptor },  // 本章新增
  { prefix: 'gpt-',      adaptor: openAIAdaptor },
  // ...
]);
```

`/v1/chat/completions` 入口的五步流程（校验 → 路由 → 构造 → 转发 → 归一化）一字未改。客户端发的 `model:"claude-sonnet-4-5"` 请求会自动落到 AnthropicAdaptor 上，进出协议都是 OpenAI。

## 3.10 旁路：`/v1/messages` 原生协议直通

并不是所有客户端都按 OpenAI 协议写。Anthropic 自家的 SDK、Claude Code、以及一部分 agent 框架（Cursor、Windsurf 部分模式）会直接发 Anthropic Messages 协议。给这些客户端做一遍 OpenAI ↔ Anthropic 双向翻译既无必要又会损失精度——`thinking` block、`cache_control` 元数据、`stop_sequences` 等字段在翻译过程中要么被吞掉要么走兼容字段，不如直接透传。

旁路实现起来很简单：在 Hono 入口多挂一个 `/v1/messages` 路由，做最小转发。以下示例不含鉴权（Ch4 引入鉴权 middleware 后旁路会与主路径共享同一套保护，本节这一版本只演示协议直通）：

```ts
app.post('/v1/messages', async (c) => {
  const rawBody = await c.req.text();
  const baseURL = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');

  const clientVersion =
    c.req.header('anthropic-version') ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const clientBeta = c.req.header('anthropic-beta');

  const headers: Record<string, string> = {
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': clientVersion,
    'Content-Type': 'application/json',
  };
  if (clientBeta) headers['anthropic-beta'] = clientBeta;

  const upstreamResp = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  const respText = await upstreamResp.text();
  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});
```

`anthropic-version` 与 `anthropic-beta` 两个 header 透传客户端的取值，没传时用默认值兜底。one-api 在 `relay/adaptor/anthropic/adaptor.go:27-44` 的 `SetupRequestHeader` 做同样的事，外加根据模型名补上 `max-tokens-3-5-sonnet-2024-07-15` 的 beta 标记——本书的实现把这个特化逻辑省掉，让客户端自己控制 beta header。

旁路与主路径共享上游 Key（都从 `ANTHROPIC_API_KEY` 环境变量读），后续章节加上鉴权（Ch4）和计费（Ch5）后，旁路与主路径都会经过同一套中间件——客户端是用 OpenAI 协议还是 Anthropic 协议，对鉴权与计费层都透明。

需要说明的是，旁路目前不做 SSE 流式透传。Anthropic 原生客户端通常默认 `stream:true`，本章的实现遇到流式请求会直接 400 拒绝（探测请求体里的 `"stream":true` 字符串），告诉调用方等 Ch7。Ch7 把 SSE 透传层做好之后，旁路与主路径都会复用同一套 SSE 转发逻辑。

## 3.11 用 Anthropic 压力测试 Ch2 的抽象：合格了吗

Ch2 末尾给 v0.2 的 `ProviderAdaptor` 接口下了一个判断——**接口设计是否合理，标准是它能不能在差异最大的 case 上撑住**。本章用 Anthropic 这个真正异构的协议把接口压一遍，对 4 个方法的胜任度做一次复盘：

| 方法 | Anthropic 实现的工作量 | 是否需要扩展接口 |
|------|---------------------|----------------|
| `name` | 一行字符串字面量 | 否 |
| `getEndpoint` | 一行返回 `/v1/messages` | 否 |
| `buildRequest` | 约 200 行（messages 重组 + tools 翻译 + system 抽出 + tool_choice 重命名 + 鉴权 header 切换） | 否——接口已经把 `headers + body` 作为返回值，足够灵活 |
| `parseResponse` | 约 40 行（content blocks 拍平 + tool_use → tool_calls + stop_reason 映射 + usage 字段重命名） | 否 |

四个方法都没需要在接口层加新签名。`buildRequest` 的工作量大是因为 Anthropic 协议本身复杂，不是接口设计的问题——这正是 Ch2 那条「**adaptor 只负责这一家上游的协议长什么样**」原则在起作用。

接口扛住了，但**两件事被发现必须放到 adaptor 之外**：

第一是流式归一化器（`streaming/anthropic-events.ts`）。它逻辑上属于 AnthropicAdaptor 的一部分（与 Anthropic 协议强绑定），但与 SSE 透传层（Ch7）耦合更紧，所以放在 `streaming/` 目录单独维护，AnthropicAdaptor 自己不持有归一化器实例——Ch7 接 SSE 时按需 new 一个。这是一种「适配器持有的逻辑」与「跨 adaptor 的网关基础设施」之间的边界，本章是第一次遇到，后续 Ch7、Ch8 还会反复出现。

第二是 IR 上的字段扩展。本章给 `IRChatRequest` schema 加了 `tools` 与 `tool_choice` 两个可选字段（zod schema 显式声明，便于客户端代码补全），它们对 OpenAI 兼容族而言原本就靠 `passthrough` 透传——加显式声明只是为了让 AnthropicAdaptor 内部不用 `(ir as any).tools` 这种取值。`ToolResultMessage` 类型定义也加在 `types/ir.ts`，但它不在 schema 里——它是 AnthropicAdaptor 内部 messages 重组的中间产物，与 IR 本身没有耦合。`system` 没有作为顶层字段加进 IR——OpenAI 协议把 system 放在 messages 里，IR 保留这个语义；adaptor 在 buildRequest 时自己抽出来即可。

这两条调整都没改 `ProviderAdaptor` 接口的 4 个方法签名。Ch2 的抽象通过了真正异构协议的压力测试。

LiteLLM 的演进路径也走过同样的过程：`BaseConfig` 早期只有 `transform_request / transform_response` 两个核心方法，Anthropic / Bedrock / Vertex 等异构上游接入之后陆续补了 `validate_environment`、`map_openai_params`、`get_model_response_iterator`（参见 `litellm/llms/base_llm/chat/transformation.py`）。但即便加到 8 个方法，核心动作仍然是「拼 URL → 注入鉴权 → 翻译请求 → 解析响应 → 处理流式 → 处理错误」六件事。本书的 4 方法接口已经覆盖前四件，流式与错误处理留到 Ch7、Ch8 再扩——同样的演进节奏。

## 3.12 v0.3 的运行验证

把 v0.3 跑起来需要一把 Anthropic Key。从 console.anthropic.com 注册即可，新账号有 $5 试用额度，本章实测全部样例花不到 $0.10。

```bash
cd examples/03-anthropic-is-different
cp .env.example .env
# 编辑 .env: ANTHROPIC_API_KEY=sk-ant-...
npm install
npm run dev
```

主路径测试——客户端发 OpenAI 协议，路由到 claude-*：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [
      {"role": "system", "content": "你只用中文回答"},
      {"role": "user", "content": "用一句话解释 LLM 中转站"}
    ]
  }'
```

客户端看到的响应是 OpenAI 风格：

```json
{
  "id": "msg_01abc...",
  "object": "chat.completion",
  "created": 1715750000,
  "model": "claude-sonnet-4-5",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "LLM 中转站是..."},
      "finish_reason": "stop"
    }
  ],
  "usage": {"prompt_tokens": 25, "completion_tokens": 42, "total_tokens": 67}
}
```

工具调用同样可用——客户端发 OpenAI 风格的 `tools[].function.parameters`，网关翻译成 Anthropic 风格的 `tools[].input_schema` 上行，回包里的 `tool_use` block 被翻成 `message.tool_calls`，arguments 是 JSON 字符串。

旁路测试——客户端直接发 `/v1/messages`：

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "system": "你只用中文回答",
    "messages": [{"role": "user", "content": "用一句话解释 LLM 中转站"}]
  }'
```

这次请求体里 system 在顶层、messages 不含 system——是 Anthropic 原生格式。网关只做鉴权占位与日志归因，请求与响应原样透传。Claude Code 之类的客户端把 base URL 指向 `http://localhost:3000` 即可工作。

健康检查：

```bash
curl http://localhost:3000/healthz
# {
#   "ok": true,
#   "version": "v0.3",
#   "routes": [
#     {"prefix":"deepseek-","provider":"deepseek"},
#     {"prefix":"claude-","provider":"anthropic"},
#     {"prefix":"gpt-","provider":"openai"},
#     ...
#   ],
#   "extra_endpoints": ["/v1/messages (Anthropic passthrough)"]
# }
```

异常路径：

- 缺 `messages` 字段：400 + zod 错误详情
- `model:"claude-sonnet-4-5"` 但 `ANTHROPIC_API_KEY` 为空或无效：透传 Anthropic 上游的 401 错误体
- 客户端发流式请求（`stream:true`）：400 + 「streaming will be added in Ch7」提示

## 3.13 协议适配中的工程陷阱

写完六处差异，回头看实际维护中最容易出错的几个点，单独拎出来给后续接入新异构上游（Gemini / Bedrock / Vertex AI）的读者做参考。

**陷阱一：双向类型转换的方向写反**

`tool_calls[].function.arguments` 在 OpenAI 是字符串，`tool_use.input` 在 Anthropic 是对象。请求方向要 `JSON.parse`，响应方向要 `JSON.stringify`。两边都很容易顺手写反——尤其是从 LLM 那里复制代码来改的情况。建议给两个方向的函数起明确的名字（`irToAnthropicRequest` / `anthropicResponseToIR`），看名字就知道方向，比 `transform` / `convert` 这种含糊的命名安全得多。

**陷阱二：默认值兜底的位置不对**

`max_tokens` 必填，缺省值放在哪里？放在 IR schema 里（zod 的 `.default(4096)`）会导致所有上游都被注入这个默认值——OpenAI 不需要，DeepSeek 不需要，只有 Anthropic 需要。本书把默认值放在 AnthropicAdaptor 的构造参数 `defaultMaxTokens` 上：只有走到这个 adaptor 才兜底。这种「provider 特有的默认值放在 adaptor 自己手里」的原则，对后续 Gemini 的 `maxOutputTokens`、Bedrock 的 `max_tokens_to_sample` 等同样适用。

**陷阱三：把网关里的错误吞掉**

`JSON.parse` 失败、`tool_calls.arguments` 残缺、上游响应里多出来一个不认识的字段——三件事的应对策略完全不同。`JSON.parse` 失败应当透传 500 让运维知道有 bug；`tool_calls.arguments` 残缺应当 400 让客户端修；多出来的字段应当透传给客户端（OpenAI / Anthropic 双方都在持续加字段，adaptor 不知道的字段不一定是错）。但是大多数实现里这三件事被混在一个 `try/catch` 里静默处理，结果是排查问题时找不到根因。本书在每个 catch 分支里都明确写清楚处理意图（重新 throw / 兜空值 / 包成 `__raw`），代码里看得到决策。

**陷阱四：流式状态机在并行 tool_use 时丢索引**

Anthropic 的 `content_block_delta` 只带 block index，不带 block type。如果同一次响应里出现两个并行的 `tool_use` block（index 0 是 text、index 1 是 tool_use #A、index 2 是 tool_use #B），归一化器必须自己在 `content_block_start` 时记录 index → tool_calls 数组索引的映射，否则 `input_json_delta` 来时不知道塞到哪个 tool_call 的 arguments 里。one-api 的实现在并行多工具场景下会把所有 arguments 拼到最后一个 tool_call 上，这是个真实存在的 bug——它的 `StreamResponseClaude2OpenAI` 函数没维护 index 映射表，只追加 `tools = append(tools, ...)`。本书的 `AnthropicEventNormalizer` 用 `toolIndexByBlock` 这张表显式管理映射，是为了避开这个坑。

**陷阱五：旁路 `/v1/messages` 的鉴权与计费容易遗漏**

旁路看起来只是反向代理，很多实现里就真的写成了「直接转发」——结果 Ch4 加鉴权时旁路不在保护范围内、Ch5 加计费时旁路不算进账单。本章的代码把旁路写成与主路径共用同一段 fetch + 日志逻辑，目的就是让后续中间件能一并覆盖。设计原则：**对外暴露的每一个 endpoint 都要走同一套鉴权、计费、限流中间件**，不允许某个路径绕过基础设施。

## 3.14 本章小结

v0.3 在 v0.2 之上加了三件事：

1. **AnthropicAdaptor**（`src/adaptors/anthropic.ts`）：实现 ProviderAdaptor 接口，覆盖 6 处协议差异。
2. **Anthropic 流式事件归一化器**（`src/streaming/anthropic-events.ts`）：把 6 种 Anthropic 事件压成 OpenAI delta chunk，Ch7 SSE 主循环复用。
3. **`/v1/messages` 旁路**（`src/index.ts`）：Anthropic 原生协议直通，Claude Code 等客户端可直接用。

读完本章，读者应该能够：

- 描述 OpenAI ↔ Anthropic 的 6 处协议差异，并指出每处在 adaptor 代码里的处理位置。
- 解释为什么 system 字段、tool_result 回填、流式事件归一化是协议适配中最容易出错的三处。
- 对照 one-api / Portkey / LiteLLM 三家实现，理解 Anthropic adaptor 的演化路径与陷阱。
- 在本地跑通 v0.3，用 OpenAI SDK 格式访问 claude-* 模型，并能让 Claude Code 直接接到自己的网关上。

## 配套代码

完整可运行的 v0.3 代码在 `examples/03-anthropic-is-different/`，目录结构：

```
src/
  index.ts                       # Hono 入口, 主路径 + /v1/messages 旁路
  types/ir.ts                    # IR 类型 (扩出 tools / ToolResultMessage)
  adaptors/
    base.ts                      # ProviderAdaptor 接口 (与 Ch2 一致)
    openai.ts                    # OpenAI 实现
    deepseek.ts                  # DeepSeek 实现
    anthropic.ts                 # 本章主新增
  streaming/
    anthropic-events.ts          # 6 种事件归一化器, Ch7 SSE 主循环会复用
  router.ts                      # 加 claude-* -> Anthropic 前缀
```

按 README 指引 `npm install && npm run dev` 即可起服务。准备一把 Anthropic Key（console.anthropic.com 注册，新账号有 $5 试用额度），先发 OpenAI 协议测主路径，再发 Anthropic 原生协议测旁路。

## 下一章预告

v0.3 之后，协议层已经具备三家上游（OpenAI / DeepSeek / Anthropic）的覆盖能力。但仔细看 `src/index.ts` 会发现一件事：对外暴露的 base URL（`http://localhost:3000`）没有任何鉴权。任何拿到 URL 的客户端都能消耗上游额度——这在企业基建场景下意味着 OpenAI / Anthropic 的 Key 实际被泄露给了所有内网用户，在对外卖 token 场景下意味着任何人都能白嫖。

第 4 章引入持久层（better-sqlite3 + Drizzle ORM），落地内部 API Key 体系：按用户或业务线签发独立的内部 Key（前缀 `sk-gw-`），支持元数据、过期时间、即时吊销；Hono middleware 做 Bearer Token 鉴权；外部上游 Key 与内部下游 Key 分两套生命周期管理。这是把网关从「能跑」推向「能对外暴露」的第一道关卡。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
