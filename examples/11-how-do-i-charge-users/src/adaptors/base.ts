// ProviderAdaptor 接口
//
// 设计参考:
//   - one-api: relay/adaptor/interface.go 的 Adaptor 接口 (Init / GetRequestURL /
//     SetupRequestHeader / ConvertRequest / DoRequest / DoResponse 等 9 个方法)
//   - LiteLLM: BaseConfig 的 get_complete_url / validate_environment /
//     transform_request / transform_response 四个核心钩子
//
// 本书 v0.2 把非流式抽象收敛到 4 个最小必要方法; v0.7 追加 3 个流式钩子:
//   - name              : 渠道名, 用于日志与后续 Channel 维度归因
//   - getEndpoint(ir)   : 计算上游完整 URL (含 path)
//   - buildRequest(ir)  : 非流式 headers + body
//   - parseResponse(r)  : 非流式响应归一化为 IRChatResponse
//   - buildStreamRequest(ir) : 流式 headers + body (与非流式的区别仅在请求体中
//                              stream=true, 以及部分上游要求的额外 header)
//   - newStreamState()        : 创建 adaptor 自管的流式状态对象 (Anthropic 用归一化器实例)
//   - parseStreamChunk(line)  : 把一行 raw SSE data 翻译成统一的 OpenAI delta chunk
//
// 暂不包含的能力 (留给后续章节扩展):
//   - 错误分类与自动禁用         -> Ch8 加 classifyError(httpStatus, body)
//   - 多 Key 轮询                -> Ch8 在 Channel 层处理, 不在 Adaptor 层

import type { IRChatRequest, IRChatResponse } from '../types/ir.js';
import type { OpenAIDeltaChunk } from '../streaming/anthropic-events.js';

/**
 * adaptor 处理一行 raw SSE data 时的内部状态. 每个 adaptor 自己定义形状,
 * sse-proxy 主循环持有引用并在多次 parseStreamChunk 之间传回.
 */
export type StreamState = Record<string, unknown>;

/**
 * parseStreamChunk 返回:
 *   - chunks: 归一化的 OpenAI delta chunk 数组 (0..N 条);
 *   - done:   true 表示上游流到此结束 (例如 OpenAI 的 [DONE] 或 Anthropic 的
 *             message_stop), 调用方应停止读上游并向客户端发出 [DONE].
 */
export interface StreamChunkOutput {
  chunks: OpenAIDeltaChunk[];
  done: boolean;
}

export interface ProviderAdaptor {
  /** 渠道名称, 用于日志、监控与后续 Channel 维度归因 */
  readonly name: string;

  /**
   * 计算上游完整 URL
   * 对 OpenAI 兼容族, 通常是 `${baseURL}/v1/chat/completions`
   * 对非兼容上游 (Anthropic), 可能是 `${baseURL}/v1/messages`
   */
  getEndpoint(ir: IRChatRequest): string;

  /**
   * 构造 fetch 的 headers + body (非流式)
   * 注入鉴权 (Bearer Token / x-api-key / JWT) 与 Content-Type
   * 把 IR 翻译成上游协议要求的请求体
   */
  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string };

  /**
   * 把上游 HTTP 响应归一化为 IRChatResponse (非流式)
   * 对 OpenAI 兼容族: 直接 JSON.parse 上游回包
   * 对非兼容上游: 需要做字段映射 (Ch3 处理 Anthropic 的 stop_reason / content blocks 等)
   */
  parseResponse(upstreamResp: Response, rawBody: string): Promise<IRChatResponse>;

  // ---------- v0.7 新增: 流式 ----------

  /**
   * 构造流式 fetch 的 headers + body. 强制 stream=true.
   * OpenAI 系: 额外加 stream_options.include_usage = true, 让上游在最后一个
   *   chunk 里送 usage (本地估算 + 上游真实, 双路对账).
   * Anthropic 系: stream: true 即可 (上游每个 message_delta 自带 usage).
   */
  buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string };

  /**
   * 创建一个 adaptor 自管的流式状态对象. 主循环在收到每个 raw chunk 时把
   * state 透传给 parseStreamChunk. 对 OpenAI 兼容族 state 是空对象,
   * 对 Anthropic 是 AnthropicEventNormalizer 实例的引用.
   */
  newStreamState(): StreamState;

  /**
   * 把一行 raw SSE data (已 strip 过 `data:` 前缀的 JSON 字符串, 或 `[DONE]` 标志)
   * 翻译成统一格式的 OpenAI delta chunk.
   *
   * 返回 done=true 时, 主循环立刻进入收尾分支 (commit + 写 usage + 写 [DONE]).
   */
  parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput;
}
