// 跨上游 chunk 统一接口
//
// 主循环不直接关心「上游是 OpenAI 风格还是 Anthropic 风格」, 这层薄包装把两家
// 的 raw SSE line 都映射成统一的 OpenAIDeltaChunk 数组 + done 标志:
//
//   OpenAI 风格    -> JSON.parse(line) 直接得到 OpenAIDeltaChunk;
//   Anthropic 风格 -> 走 AnthropicEventNormalizer 的有限状态机 (Ch3 已实现).
//
// 接口契约本身已经在 adaptors/base.ts 的 ProviderAdaptor 上挂了
// buildStreamRequest / newStreamState / parseStreamChunk 三个钩子, adaptor 自己
// 决定如何归一化. 本文件提供「从 chunk 提 completion 文本 / usage」的纯函数,
// 主循环用它喂给 StreamingTokenCounter, 不依赖具体上游.
//
// 设计参考:
//   - one-api: relay/adaptor/anthropic/main.go StreamResponseClaude2OpenAI
//     (149-208 行) 同样把 Anthropic 流式 6 事件压成 OpenAI chunk;
//   - Portkey v1.15.2: src/handlers/streamHandler.ts 的 transformFunction 概念,
//     每家 provider 自己负责 chunk 翻译.

import type { OpenAIDeltaChunk } from './anthropic-events.js';

/**
 * 从一个归一化后的 OpenAI chunk 里抽出 completion 文本 (供 streaming-counter
 * 做本地 tiktoken 累加).
 *
 * - delta.content      : 标准 OpenAI / Anthropic text 通路
 * - delta.reasoning_content : DeepSeek reasoner / Anthropic thinking
 *                             也计入 completion (上游对它一样收费)
 * - tool_calls function.arguments : tool 参数本身也是 completion 的一部分
 */
export function extractCompletionText(chunk: OpenAIDeltaChunk): string {
  let text = '';
  for (const ch of chunk.choices ?? []) {
    const delta = ch.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (typeof delta.reasoning_content === 'string') text += delta.reasoning_content;
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const args = tc.function?.arguments;
        if (typeof args === 'string') text += args;
      }
    }
  }
  return text;
}

/** 从一个归一化后的 chunk 里取 usage (上游真实值, 优先于本地估算) */
export function extractUsage(
  chunk: OpenAIDeltaChunk,
): { prompt_tokens: number; completion_tokens: number } | null {
  if (!chunk.usage) return null;
  return {
    prompt_tokens: chunk.usage.prompt_tokens ?? 0,
    completion_tokens: chunk.usage.completion_tokens ?? 0,
  };
}

/**
 * 把一个归一化后的 chunk 重新 stringify 成 SSE wire format:
 *   data: {...}\n\n
 *
 * 主循环用它把 chunk 发回给客户端. 一行 SSE event 必须以 \n\n 结尾,
 * 缺一个换行符客户端就会一直等下一帧.
 */
export function encodeSseChunk(chunk: OpenAIDeltaChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** SSE 终止信号. 不管哪家上游, 网关对下游都用这一行收尾. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** SSE 心跳行 (comment line, 客户端会忽略, 但保持连接不被 Nginx / LB 超时切掉) */
export const SSE_HEARTBEAT = ': keepalive\n\n';
