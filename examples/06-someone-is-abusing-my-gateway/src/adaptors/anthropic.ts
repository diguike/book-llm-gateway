// Anthropic Messages API 适配器
//
// 本章新增. AnthropicAdaptor 实现 ProviderAdaptor 接口, 同时承担两个方向的翻译:
//
//   1) 入站 OpenAI 协议 -> 上游 Anthropic 协议  (buildRequest)
//      - system 抽出顶层
//      - messages 重组 (role=tool -> 包装回 user.tool_result; assistant 的 tool_calls
//        翻成 content block 数组里的 tool_use)
//      - tools[].function.parameters -> tools[].input_schema
//      - tool_choice 重命名 (auto/required/none/object -> auto/any/none/tool)
//      - max_tokens 必填: 缺省兜底 4096
//      - 鉴权切 x-api-key + anthropic-version
//
//   2) 上游 Anthropic 响应 -> OpenAI 协议  (parseResponse)
//      - content blocks 数组拍平成 message.content + tool_calls
//      - tool_use.input (object) -> tool_calls[].function.arguments (JSON 字符串)
//      - stop_reason 映射: end_turn/stop_sequence -> stop, max_tokens -> length,
//                          tool_use -> tool_calls
//      - usage.input_tokens/output_tokens -> prompt_tokens/completion_tokens
//
// 设计参考:
//   - one-api: relay/adaptor/anthropic/main.go ConvertRequest / ResponseClaude2OpenAI
//   - Portkey v1.15.2: src/providers/anthropic/chatComplete.ts
//   - LiteLLM: litellm/llms/anthropic/chat/transformation.py
//
// 流式事件归一化在 ../streaming/anthropic-events.ts; 本 adaptor 只处理非流式.

import type { ProviderAdaptor } from './base.js';
import type { IRChatRequest, IRChatResponse, IRMessage } from '../types/ir.js';

export interface AnthropicAdaptorOptions {
  /** 渠道名, 默认 'anthropic' */
  name?: string;
  /** 上游基础 URL, 默认 https://api.anthropic.com */
  baseURL: string;
  /** Anthropic API Key */
  apiKey: string;
  /** anthropic-version header, 默认 2023-06-01 */
  anthropicVersion?: string;
  /** Anthropic Messages 必填的 max_tokens 兜底值, 默认 4096 */
  defaultMaxTokens?: number;
}

// ---------- Anthropic 协议类型 (子集, 与官方文档字段一致) ----------

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------- stop_reason / finish_reason 映射 ----------

/**
 * Anthropic stop_reason -> OpenAI finish_reason
 * 这是 6 处差异里最简单的一处, 但每个分支都要在 parseResponse / 流式归一化器里复用.
 */
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

// ---------- 主体: AnthropicAdaptor ----------

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
    // 差异 #endpoint: OpenAI 是 /v1/chat/completions, Anthropic 是 /v1/messages
    return `${this.baseURL}/v1/messages`;
  }

  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
    const body = irToAnthropicRequest(ir, this.defaultMaxTokens);
    return {
      headers: {
        // 差异 #鉴权: OpenAI 用 Authorization Bearer; Anthropic 用 x-api-key + anthropic-version
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

// ---------- 请求方向: IR (OpenAI) -> Anthropic ----------

/**
 * 把 IR (OpenAI Chat Completions) 翻译成 Anthropic Messages 请求.
 * 6 处关键差异在此体现:
 *   1. system 抽出顶层
 *   2. messages 重组 (tool_result 包装回 user)
 *   3. tools[].function.parameters -> tools[].input_schema
 *   4. tool_choice 重命名
 *   5. (响应方向的 stop_reason 映射不在这里)
 *   6. (流式归一化也不在这里)
 */
export function irToAnthropicRequest(
  ir: IRChatRequest,
  defaultMaxTokens: number,
): AnthropicRequest {
  // 1) 抽 system: 扫一遍 messages, 把所有 role=system 拼接成顶层 system 字符串
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

  // 2) 重组 messages
  const anthropicMessages = transformMessages(restMessages);

  // 3) 翻译 tools
  const tools = ir.tools ? transformTools(ir.tools) : undefined;
  // 4) 翻译 tool_choice
  const toolChoice =
    ir.tool_choice !== undefined ? transformToolChoice(ir.tool_choice) : undefined;

  const req: AnthropicRequest = {
    model: ir.model,
    // max_tokens 必填 (差异之一): IR 没指定时兜底
    max_tokens: ir.max_tokens ?? defaultMaxTokens,
    messages: anthropicMessages,
  };
  if (systemParts.length > 0) req.system = systemParts.join('\n\n');
  if (typeof ir.temperature === 'number') req.temperature = ir.temperature;
  if (typeof ir.top_p === 'number') req.top_p = ir.top_p;
  if (typeof ir.stream === 'boolean') req.stream = ir.stream;
  if (tools && tools.length > 0) req.tools = tools;
  if (toolChoice) req.tool_choice = toolChoice;
  // stop 字段 OpenAI 写 stop, Anthropic 写 stop_sequences. 这里仅在 IR 显式给出时透传.
  const irAny = ir as unknown as { stop?: string | string[] };
  if (irAny.stop !== undefined) {
    req.stop_sequences = Array.isArray(irAny.stop) ? irAny.stop : [irAny.stop];
  }

  return req;
}

/**
 * messages 重组核心逻辑:
 *   - role=user      : content 字符串 -> [{type:'text',text}]; 数组按 type 分发 (本 demo 只演示 text)
 *   - role=assistant : 普通文本走 text block; 若有 tool_calls, 追加 tool_use blocks (注意 input 要把
 *                      arguments JSON 字符串 parse 回 object)
 *   - role=tool      : 必须包装回 user role, content 写成 [{type:'tool_result', tool_use_id, content}]
 *                      连续的多条 tool 消息聚合到同一条 user 消息 (Anthropic 的官方推荐写法).
 */
function transformMessages(messages: IRMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      // tool 结果消息 -> 包装回 user.tool_result
      const toolCallId =
        typeof (m as IRMessage & { tool_call_id?: unknown }).tool_call_id === 'string'
          ? ((m as IRMessage & { tool_call_id?: string }).tool_call_id as string)
          : '';
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }

    // 出现非 tool 消息前, 先把已聚合的 tool_results flush 成一条 user 消息
    flushPendingToolResults();

    if (m.role === 'user') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof m.content === 'string') {
        if (m.content.length > 0) blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object') {
            const p = part as { type?: string; text?: string };
            if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text });
            }
            // 多模态 image_url -> Anthropic image 的转换不在 v0.3 范围内, 留给后续章节.
          }
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      result.push({ role: 'user', content: blocks });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object') {
            const p = part as { type?: string; text?: string };
            if (p.type === 'text' && typeof p.text === 'string') {
              blocks.push({ type: 'text', text: p.text });
            }
          }
        }
      }
      // assistant 的 tool_calls -> tool_use blocks
      const toolCalls = (m as IRMessage & { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          const call = tc as {
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          let input: Record<string, unknown> = {};
          if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
            try {
              input = JSON.parse(call.function.arguments) as Record<string, unknown>;
            } catch {
              // 模型偶尔吐出残缺 JSON, 这里宁可让上游 400 也不静默吞错
              input = { __raw: call.function.arguments };
            }
          }
          blocks.push({
            type: 'tool_use',
            id: call.id ?? '',
            name: call.function?.name ?? '',
            input,
          });
        }
      }
      if (blocks.length === 0) {
        // Anthropic 不接受空 content, 兜一个空 text
        blocks.push({ type: 'text', text: '' });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  // 末尾若还有未 flush 的 tool_results, flush 出去
  flushPendingToolResults();

  return result;
}

/**
 * OpenAI tools[].function.{name, description, parameters} -> Anthropic tools[].{name, description, input_schema}
 */
function transformTools(tools: unknown[]): AnthropicTool[] {
  const result: AnthropicTool[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as {
      type?: string;
      function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
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
          Object.entries(params).filter(([k]) => k !== 'type' && k !== 'properties' && k !== 'required'),
        ),
      },
    });
  }
  return result;
}

/**
 * OpenAI tool_choice -> Anthropic tool_choice
 *   - 'auto'    -> {type:'auto'}
 *   - 'required'-> {type:'any'}    (Anthropic 用 'any' 表示「必须挑一个工具」)
 *   - 'none'    -> {type:'none'}
 *   - {type:'function',function:{name}} -> {type:'tool',name}
 */
function transformToolChoice(choice: unknown): AnthropicToolChoice | undefined {
  if (typeof choice === 'string') {
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return undefined;
  }
  if (choice && typeof choice === 'object') {
    const c = choice as { type?: string; function?: { name?: string } };
    if (c.type === 'function' && c.function?.name) {
      return { type: 'tool', name: c.function.name };
    }
  }
  return undefined;
}

// ---------- 响应方向: Anthropic -> IR (OpenAI) ----------

/**
 * 把 Anthropic 非流式响应翻译回 OpenAI Chat Completions 结构.
 *   - content blocks 数组拍平: text 拼成 message.content; tool_use 累积成 tool_calls
 *   - usage.input_tokens / output_tokens -> prompt_tokens / completion_tokens
 *   - stop_reason -> finish_reason 走 stopReasonToFinishReason
 */
export function anthropicResponseToIR(resp: AnthropicResponse): IRChatResponse {
  let text = '';
  const toolCalls: NonNullable<IRChatResponse['choices'][number]['message']['tool_calls']> = [];

  for (const block of resp.content ?? []) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const finishReason = stopReasonToFinishReason(resp.stop_reason);

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
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens:
        (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}
