// ProviderAdaptor 接口
//
// 设计参考:
//   - one-api: relay/adaptor/interface.go 的 Adaptor 接口 (Init / GetRequestURL /
//     SetupRequestHeader / ConvertRequest / DoRequest / DoResponse 等 9 个方法)
//   - LiteLLM: BaseConfig 的 get_complete_url / validate_environment /
//     transform_request / transform_response 四个核心钩子
//
// 本书 v0.2 把这两套抽象收敛到 4 个最小必要方法:
//   - name              : 渠道名, 用于日志与后续 Channel 维度归因
//   - getEndpoint(ir)   : 计算上游完整 URL (含 path)
//   - buildRequest(ir)  : 构造 fetch 的 RequestInit (headers + body)
//   - parseResponse(r)  : 把上游 HTTP 响应归一化为 IRChatResponse
//
// 暂不包含的能力 (留给后续章节扩展):
//   - 流式响应 chunk 解析       -> Ch7 加 streamResponse(ir, upstreamStream)
//   - 错误分类与自动禁用         -> Ch8 加 classifyError(httpStatus, body)
//   - token 计数 (本地估算)     -> Ch5 加 countTokens(ir)
//   - 多 Key 轮询                -> Ch8 在 Channel 层处理, 不在 Adaptor 层

import type { IRChatRequest, IRChatResponse } from '../types/ir.js';

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
   * 构造 fetch 的 headers + body
   * 注入鉴权 (Bearer Token / x-api-key / JWT) 与 Content-Type
   * 把 IR 翻译成上游协议要求的请求体
   */
  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string };

  /**
   * 把上游 HTTP 响应归一化为 IRChatResponse
   * 对 OpenAI 兼容族: 直接 JSON.parse 上游回包
   * 对非兼容上游: 需要做字段映射 (Ch3 处理 Anthropic 的 stop_reason / content blocks 等)
   */
  parseResponse(upstreamResp: Response, rawBody: string): Promise<IRChatResponse>;
}
