// 统一 IR (Intermediate Representation, 中间表示)
//
// 相对 Ch2 的变化:
//   1. IRChatRequest 仍以 OpenAI Chat Completions 为骨架, 用 passthrough 透传
//      原始字段 (tools / tool_choice / response_format ...).
//   2. 新增可选 derived 字段:
//        - system?: string                  // 把 messages 里 role=system 抽出来的拼接结果
//                                            // (Anthropic 顶层 system 字段所需)
//        - toolResults?: ToolResultMessage[]  // 把 role=tool 的消息按 tool_call_id 聚合,
//                                              // 留给 AnthropicAdaptor 重组成 user.tool_result
//      这些字段只是「适配 Anthropic 时方便取用的预提取结果」, 对 OpenAI 兼容族不影响.
//
// 注意: IR 仍然保持 OpenAI Chat Completions 字段语义, system 仍可以出现在 messages
// 里 (OpenAI 直接透传). adaptor 自己决定是用 messages 里的 system, 还是用顶层 system.

import { z } from 'zod';

// OpenAI message schema: role + content, 其余字段透传 (tool_calls / tool_call_id / name ...)
export const IRMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.any()), z.null()]),
  })
  .passthrough();

export const IRChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(IRMessageSchema).min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().optional(),
    stream: z.boolean().optional(),
    // OpenAI 风格 stream_options. v0.7 流式接入时, 网关会强制把 include_usage 设为 true,
    // 这样上游在最后一个 chunk 里送 usage, 网关用上游真实值校准本地 tiktoken 累加.
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .passthrough()
      .optional(),
    // OpenAI 风格 tool 声明; AnthropicAdaptor 会翻译成 input_schema
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    // v0.10 新增: 请求优先级. "low" 走 batch 异步通道 (50% 折扣, 5-15s 内返回).
    // 默认 normal, 与 v0.9 行为完全一致.
    // 这个字段是网关层私有, 不透传给上游 (上游不认).
    priority: z.enum(['low', 'normal', 'high']).optional(),
  })
  .passthrough();

export type IRMessage = z.infer<typeof IRMessageSchema>;
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>;

// 工具调用结果消息 (OpenAI role=tool 的消息)
export interface ToolResultMessage {
  tool_call_id: string;
  // OpenAI 的 content 是字符串; 用 unknown 兜底以兼容偶尔的 object 写法
  content: string | unknown;
}

// IRChatResponse: 对外 / 内部统一使用 OpenAI Chat Completions 响应结构
// 对 OpenAI 兼容族, 直接 JSON.parse;
// 对 Anthropic, AnthropicAdaptor 负责把 content blocks / stop_reason 翻译成此结构
export interface IRChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      // 工具调用时填充, 字段语义 = OpenAI tool_calls
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // 上游回包额外字段透传 (例如 DeepSeek 的 reasoning_content)
  [key: string]: unknown;
}
