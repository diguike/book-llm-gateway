// OpenAI 适配器
//
// OpenAI Chat Completions 协议是本书 IR 的「金标准」, 所以这个适配器近乎透传:
//   - endpoint: ${baseURL}/v1/chat/completions
//   - 鉴权:    Authorization: Bearer ${apiKey}
//   - 请求体:  IR 直接 JSON.stringify
//   - 响应:    上游回包结构本来就是 IRChatResponse, 直接 parse
//
// 这个类被设计为「OpenAI 兼容族基类」, DeepSeek / Moonshot / 智谱 等只需继承并
// 覆盖 baseURL (有时也覆盖 auth header) 就能复用.
//
// 参考: one-api relay/adaptor/openai/adaptor.go 的 SetupRequestHeader 与
// GetRequestURL; Portkey v1.15.2 src/providers/openai/api.ts 的 getEndpoint.

import type { ProviderAdaptor } from './base.js';
import type { IRChatRequest, IRChatResponse } from '../types/ir.js';

export interface OpenAICompatibleOptions {
  /** 渠道名, 用于日志归因 */
  name: string;
  /** 上游基础 URL, 不含 /v1 路径 */
  baseURL: string;
  /** 上游账号 Key */
  apiKey: string;
}

export class OpenAIAdaptor implements ProviderAdaptor {
  readonly name: string;
  protected readonly baseURL: string;
  protected readonly apiKey: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    // 去掉结尾斜杠, 避免拼接时出现 //v1
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  getEndpoint(_ir: IRChatRequest): string {
    return `${this.baseURL}/v1/chat/completions`;
  }

  buildRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
    return {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      // OpenAI 协议作为 IR, 请求体直接序列化即可
      body: JSON.stringify(ir),
    };
  }

  async parseResponse(_upstreamResp: Response, rawBody: string): Promise<IRChatResponse> {
    // OpenAI 兼容上游的回包本身就是 IRChatResponse 形状, 不做字段改写
    // 即使上游返回的是错误响应 (status 非 2xx), 也按 JSON 解析,
    // 让上层路由把上游的 error 对象原样透传给客户端
    return JSON.parse(rawBody) as IRChatResponse;
  }
}
