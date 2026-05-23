// 流式 token 计数器
//
// 工作场景: SSE 流式响应过程中, 客户端可能中途断开. 那一刻已经发出的 token 必须算钱
// (上游已经消耗了对应的算力), 没发出的 token 不算.
//
// 工作模式:
//   1. SSE 主循环每收到一个 delta (含 content 文本片段), 调 ingestDelta();
//   2. 计数器内部按当前 model 跑 tiktoken, 累加 completionTokens;
//   3. 上游若发了 usage 事件, 调 ingestUsage() 用上游真实值校准;
//   4. 流结束 (含客户端中断) 时, 调 finalize() 拿到本次累计的 (input, output) token,
//      作为 postConsume 的输入.
//
// 关键: 客户端断开时, 主循环必须捕获 abort 信号并立刻调 finalize() + postConsume(),
// 否则这次请求的 reserved record 永远停在 reserved 状态, 余额一直被压住.
// 本章在 Ch7 之前的「非流式 + 流式 disabled」状态下用不到这个类, 但 API 已经稳定,
// Ch7 直接 import 接入.
//
// 与 one-api 的对比:
//   - one-api 的 anthropic StreamHandler (relay/adaptor/anthropic/main.go:287) 在每个
//     message_delta 事件里读 usage.input_tokens / output_tokens 累加; 它依赖上游事件,
//     不做本地 fallback;
//   - 本章的 StreamingTokenCounter 同时支持「上游 usage 事件」与「本地 tiktoken 估算」,
//     ingestDelta 先用本地估; 上游送 usage 事件时再校准.

import { estimateCompletionTokens } from './tokenizer.js';

export interface StreamingFinalize {
  /** 真实 prompt tokens (从上游 usage 拿到的, 优先) 或 preConsume 阶段的本地估算 */
  promptTokens: number;
  /** 累计 completion tokens (上游 usage 优先, 否则本地累加) */
  completionTokens: number;
  /** 客户端是否中途断开 (true 时主循环应该立刻 postConsume) */
  abortedByClient: boolean;
}

export class StreamingTokenCounter {
  private readonly model: string;
  /** preConsume 阶段的 prompt token 数, 作为兜底值 */
  private readonly fallbackPromptTokens: number;

  private upstreamPromptTokens: number | null = null;
  private upstreamCompletionTokens: number | null = null;
  /** 本地按 delta 累加的 completion 文本累计 */
  private localCompletionText = '';
  /** 本地估算的累计值 (按 delta encode 累加; 比对最终 localCompletionText 的精确值时取较准的) */
  private localCompletionTokens = 0;
  private aborted = false;

  constructor(model: string, fallbackPromptTokens: number) {
    this.model = model;
    this.fallbackPromptTokens = fallbackPromptTokens;
  }

  /**
   * 收到一段 completion 文本 delta (SSE choices[0].delta.content 拼起来的字面). 累加本地估算.
   *
   * 性能注意: 每个 delta encode 一次是 O(len(delta)), 累加策略避免每次都 encode 全文.
   */
  ingestDelta(deltaText: string): void {
    if (!deltaText) return;
    this.localCompletionText += deltaText;
    // 简化策略: 每个 delta 单独估, 累加. 极少数情况下与「全文 encode」结果差 1-2 token,
    // 计费场景下这点误差可忽略 (postConsume 用上游 usage 修正).
    this.localCompletionTokens += estimateCompletionTokens(deltaText, this.model);
  }

  /** 上游送了 usage 事件 (OpenAI 的 stream_options.include_usage; Anthropic 的 message_delta.usage) */
  ingestUsage(usage: { prompt_tokens?: number; completion_tokens?: number }): void {
    if (typeof usage.prompt_tokens === 'number') {
      this.upstreamPromptTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === 'number') {
      this.upstreamCompletionTokens = usage.completion_tokens;
    }
  }

  /** 客户端中途取消时调一次. 也可以多次调, 幂等. */
  markAborted(): void {
    this.aborted = true;
  }

  /** 流结束 (正常 [DONE] 或客户端中断) 时返回最终的 token 数, 喂给 postConsume */
  finalize(): StreamingFinalize {
    const promptTokens = this.upstreamPromptTokens ?? this.fallbackPromptTokens;
    const completionTokens =
      // 优先用上游 usage (最准); 退一步用本地累计 (上游中断时拿不到 usage)
      this.upstreamCompletionTokens ?? this.localCompletionTokens;
    return {
      promptTokens,
      completionTokens,
      abortedByClient: this.aborted,
    };
  }
}
