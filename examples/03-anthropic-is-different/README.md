# 第 3 章 v0.3 配套代码

v0.2 的 `ProviderAdaptor` 抽象只在 OpenAI 兼容族内验证过。v0.3 接入 Anthropic Messages API：
真正异构的协议（6 处结构差异），用一个完整的 AnthropicAdaptor 把抽象层压力测一遍。

## 目录结构

```
src/
  index.ts                       # Hono 入口, 主路径 + /v1/messages 旁路
  types/ir.ts                    # IR 类型 (扩出 system / tool 概念)
  adaptors/
    base.ts                      # ProviderAdaptor 接口 (与 Ch2 一致)
    openai.ts                    # OpenAI 实现
    deepseek.ts                  # DeepSeek 实现 (继承 OpenAIAdaptor)
    anthropic.ts                 # ★ 本章主新增: OpenAI ↔ Anthropic 双向翻译
  streaming/
    anthropic-events.ts          # ★ 本章新增: 6 种事件归一化器, Ch7 SSE 主循环会复用
  router.ts                      # 加 claude-* -> Anthropic 前缀
```

## 依赖

- Node.js 20+
- npm

## 启动

```bash
cp .env.example .env
# 编辑 .env, 至少填一家上游的 Key:
#   ANTHROPIC_API_KEY=sk-ant-...     (从 console.anthropic.com 拿)
#   OPENAI_API_KEY=sk-...
#   DEEPSEEK_API_KEY=sk-...

npm install
npm run dev
```

服务监听 `http://localhost:3000`。

## 主路径：客户端发 OpenAI 协议，按 model 路由到 claude-*

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

客户端发的是 OpenAI Chat Completions 格式（system 在 messages 里），网关把它翻译成 Anthropic
Messages 格式（system 抽到顶层）发给上游，再把 Anthropic 响应翻译回 OpenAI 结构返回。

带工具调用的请求同样可以走 claude-*：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "北京今天天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

返回里 `choices[0].message.tool_calls[0].function.arguments` 是 JSON 字符串，
与 OpenAI 自家的 tool_calls 完全同形。

## 旁路：直接发 /v1/messages

适用客户端：Claude Code / Anthropic SDK / 任何写死 Messages 协议的程序。
网关不做协议翻译，只做鉴权与日志归因。

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "system": "你只用中文回答",
    "messages": [
      {"role": "user", "content": "用一句话解释 LLM 中转站"}
    ]
  }'
```

注意：这条路径上 system 已经在请求体顶层，messages 不含 system；这是 Anthropic 原生格式。

## 健康检查

```bash
curl http://localhost:3000/healthz
```

返回 v0.3 已注册的路由表与额外端点列表。

## 6 处差异速查表

| 编号 | 维度 | OpenAI | Anthropic | 代码处理位置 |
|------|------|--------|-----------|------------|
| 1 | system 字段 | `messages` 数组里 `role:"system"` 的一条 | 请求体顶层独立 `system` 字段 | `adaptors/anthropic.ts` `irToAnthropicRequest` 扫描 messages 抽出 |
| 2 | messages 结构 | 单层 `{role, content}` | content 是 block 数组 + 工具结果必须用 user 包装 | `adaptors/anthropic.ts` `transformMessages` |
| 3 | tools 字段 | `tools[].function.{name, description, parameters}` | `tools[].{name, description, input_schema}` | `adaptors/anthropic.ts` `transformTools` |
| 4 | tool 结果回填 | 独立 `role:"tool"` 消息带 `tool_call_id` | `user.content` 里的 `tool_result` block | `adaptors/anthropic.ts` `transformMessages` 聚合分支 |
| 5 | 结束原因字段 | `finish_reason`: stop / length / tool_calls | `stop_reason`: end_turn / max_tokens / tool_use | `adaptors/anthropic.ts` `stopReasonToFinishReason` |
| 6 | 流式事件 | 单一 `data: {...}` | 6 种事件 (message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop) | `streaming/anthropic-events.ts` `AnthropicEventNormalizer` |

额外差异（端点 / 鉴权 / max_tokens 必填）都收敛在 `AnthropicAdaptor` 的构造与 `getEndpoint` / `buildRequest` 三个方法里。

## 相对 v0.2 的核心变化

| 变化 | 文件 | 说明 |
|------|------|------|
| AnthropicAdaptor | `src/adaptors/anthropic.ts` | 实现 ProviderAdaptor 接口；OpenAI ↔ Anthropic 双向翻译 |
| IR 扩展 | `src/types/ir.ts` | 新增 `tools` / `tool_choice` 声明，新增 `ToolResultMessage` 概念 |
| 流式事件归一化器 | `src/streaming/anthropic-events.ts` | 6 种 Anthropic 事件 → OpenAI delta chunk；Ch7 SSE 主循环会复用 |
| 路由表新增 claude-* | `src/router.ts` | claude-* 前缀路由到 AnthropicAdaptor |
| /v1/messages 旁路 | `src/index.ts` | Anthropic 原生协议直通，Claude Code 等客户端可直接用 |

## 暂不支持的能力

| 缺陷 | 解决章节 |
|------|---------|
| SSE 流式透传（事件归一化器已就位） | 第 7 章 |
| 多模态（image / pdf） | 后续章节 |
| 错误体 Anthropic ↔ OpenAI 统一 | 第 7 / 8 章 |
| 鉴权、计费、限流、可观测 | 第 4-9 章 |
| 多 Key 渠道与故障转移 | 第 8 章 |
