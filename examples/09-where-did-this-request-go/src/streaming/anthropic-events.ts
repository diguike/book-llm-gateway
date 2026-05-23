// Anthropic 流式事件归一化器
//
// Anthropic Messages API 的流式响应一共有 6 种事件:
//   1. message_start          - 标记消息开始, 携带 id / model / 初始 usage.input_tokens
//   2. content_block_start    - 一个内容块开始 (text / tool_use / thinking)
//   3. content_block_delta    - 内容块增量 (text_delta / input_json_delta / thinking_delta)
//   4. content_block_stop     - 内容块结束
//   5. message_delta          - 消息级增量, 携带 stop_reason 与最终 output_tokens
//   6. message_stop           - 消息结束
//
// OpenAI 流式只有一种事件结构 (data: {choices:[{delta:{...}}]}\n\n + data: [DONE]\n\n).
//
// 本归一化器把 6 种 Anthropic 事件压成一串 OpenAI chunk:
//   message_start         -> {delta:{role:'assistant',content:''}}
//   content_block_start   -> tool_use 时发一块带 tool_calls[].id / function.name 的 delta;
//                            text 时不发独立 chunk (等 content_block_delta).
//   content_block_delta   - text_delta       -> {delta:{content:'...'}}
//                         - input_json_delta -> {delta:{tool_calls:[{function:{arguments:'...'}}]}}
//                         - thinking_delta   -> {delta:{reasoning_content:'...'}} (额外字段, 透传)
//   content_block_stop    -> 不发独立 chunk
//   message_delta         -> {delta:{},finish_reason:'...',usage:{...}}
//   message_stop          -> '[DONE]'
//
// 这套归一化逻辑会在 Ch7 接进 SSE 主循环. 本章先把它写好, 在非流式入口里也用得到
// (例如本章用归一化结果做 mock 测试).
//
// 参考实现:
//   - one-api: relay/adaptor/anthropic/main.go StreamResponseClaude2OpenAI (149-208 行)
//   - Portkey v1.15.2: src/providers/anthropic/chatComplete.ts
//     getAnthropicStreamChunkTransform (636 行起, 含 streamState 状态机)
//   - LiteLLM: litellm/llms/anthropic/chat/handler.py ModelResponseIterator.chunk_parser (775 行起)

import { stopReasonToFinishReason } from '../adaptors/anthropic.js';

// ---------- Anthropic 流式事件类型 ----------

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    role: 'assistant';
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };
}

interface AnthropicContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'thinking'; thinking: string };
}

interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string };
}

interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

interface AnthropicPingEvent {
  type: 'ping';
}

interface AnthropicErrorEvent {
  type: 'error';
  error: { type: string; message: string };
}

// ---------- OpenAI 流式 chunk ----------

export interface OpenAIDeltaChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
      // 透传 reasoning_content (DeepSeek 兼容字段, Anthropic thinking 借这条通路)
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------- 归一化器: 状态机 ----------

/**
 * 归一化器需要跨多个事件维护状态, 因此用 class 封装而不是单纯的纯函数:
 *   - id / model / created / promptTokens: 在 message_start 时拿到, 后续 chunk 复用
 *   - blockTypes[index]: 记录每个 content block 是 text / tool_use / thinking, 以便
 *                        content_block_delta 时分发到不同 OpenAI 字段
 *   - toolIndexByBlock[index]: tool_use 在 OpenAI tool_calls 数组里的索引 (按出现顺序自增)
 *
 * 每次 push 一个 Anthropic 事件, normalizer 产出 0..N 个 OpenAI chunk + 可选的 [DONE] 标志.
 */
export interface NormalizedOutput {
  chunks: OpenAIDeltaChunk[];
  /** true 表示流到此结束, 调用方应该发出 data: [DONE]\n\n 并关闭连接 */
  done: boolean;
}

export class AnthropicEventNormalizer {
  private id = '';
  private model = '';
  private created = Math.floor(Date.now() / 1000);
  private promptTokens = 0;
  private blockTypes = new Map<number, 'text' | 'tool_use' | 'thinking'>();
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;

  /** 处理单个 Anthropic 事件, 返回 0..N 个 OpenAI chunk */
  push(event: AnthropicStreamEvent): NormalizedOutput {
    switch (event.type) {
      case 'ping':
        return { chunks: [], done: false };

      case 'message_start':
        this.id = event.message.id;
        this.model = event.message.model;
        this.created = Math.floor(Date.now() / 1000);
        this.promptTokens = event.message.usage.input_tokens ?? 0;
        // 发首块, 带 role:'assistant' + 空 content, 与 OpenAI 首块对齐
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
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    {
                      index: toolIdx,
                      id: block.id,
                      type: 'function',
                      function: { name: block.name, arguments: '' },
                    },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        // text / thinking block 不在 start 时发 chunk, 等 delta
        return { chunks: [], done: false };
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          return {
            chunks: [this.makeChunk({ delta: { content: delta.text }, finish_reason: null })],
            done: false,
          };
        }
        if (delta.type === 'input_json_delta') {
          const toolIdx = this.toolIndexByBlock.get(event.index);
          if (toolIdx === undefined) return { chunks: [], done: false };
          return {
            chunks: [
              this.makeChunk({
                delta: {
                  tool_calls: [
                    {
                      index: toolIdx,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        if (delta.type === 'thinking_delta') {
          // thinking 映射到 reasoning_content (与 DeepSeek reasoner 同一通路)
          return {
            chunks: [
              this.makeChunk({
                delta: { reasoning_content: delta.thinking },
                finish_reason: null,
              }),
            ],
            done: false,
          };
        }
        return { chunks: [], done: false };
      }

      case 'content_block_stop':
        // OpenAI 没有「block 边界」的概念, 直接吃掉
        return { chunks: [], done: false };

      case 'message_delta': {
        const finishReason = stopReasonToFinishReason(event.delta.stop_reason);
        const outputTokens = event.usage?.output_tokens ?? 0;
        const chunk = this.makeChunk({
          delta: {},
          finish_reason: finishReason,
          usage: {
            prompt_tokens: this.promptTokens,
            completion_tokens: outputTokens,
            total_tokens: this.promptTokens + outputTokens,
          },
        });
        return { chunks: [chunk], done: false };
      }

      case 'message_stop':
        // 该发 [DONE] 了, 这里不再追加 chunk
        return { chunks: [], done: true };

      case 'error':
        // 错误事件: 转成一个带 finish_reason 的终止 chunk, 再让上层补 [DONE]
        return {
          chunks: [
            this.makeChunk({
              delta: { content: '' },
              finish_reason: event.error?.type ?? 'error',
            }),
          ],
          done: true,
        };

      default:
        return { chunks: [], done: false };
    }
  }

  private makeChunk(opts: {
    delta: OpenAIDeltaChunk['choices'][number]['delta'];
    finish_reason: string | null;
    usage?: OpenAIDeltaChunk['usage'];
  }): OpenAIDeltaChunk {
    const chunk: OpenAIDeltaChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: opts.delta,
          finish_reason: opts.finish_reason,
        },
      ],
    };
    if (opts.usage) chunk.usage = opts.usage;
    return chunk;
  }
}

// ---------- SSE 行解析 ----------

/**
 * Anthropic SSE 一行形如:
 *   event: content_block_delta\n
 *   data: {"type":"content_block_delta","index":0,"delta":{...}}\n
 *   \n
 *
 * 仅 data: 行携带 JSON. event: 行可以忽略 (data 里也有 type 字段).
 * Ch7 的 SSE 透传层会做完整的逐行扫描; 本章给出一个最小 parser 方便单测 + Ch7 复用.
 */
export function parseAnthropicSSELine(line: string): AnthropicStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const json = trimmed.slice(5).trim();
  if (json.length === 0 || json === '[DONE]') return null;
  try {
    return JSON.parse(json) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}
