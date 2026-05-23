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
// v0.7 追加的流式钩子:
//   - buildStreamRequest(ir): 注入 stream:true + stream_options.include_usage:true,
//     让上游在最后一个 chunk 里送 usage (没有 usage 字段时, streaming-counter 用
//     本地 tiktoken 累加值兜底).
//   - parseStreamChunk(line): OpenAI 流式 chunk 本身就是统一格式, 直接 JSON.parse,
//     送上游 [DONE] 时返回 done=true.
//
// 参考:
//   - one-api: relay/adaptor/openai/main.go StreamHandler (流式 scanner + data:
//     行扫描 + [DONE] 哨兵识别);
//   - Portkey v1.15.2: src/handlers/streamHandler.ts readStream (TextDecoder +
//     splitPattern 切分);
//   - OpenAI 官方 SDK: stream_options.include_usage 才能拿到 usage 字段.

import type { ProviderAdaptor, StreamChunkOutput, StreamState } from './base.js';
import type { IRChatRequest, IRChatResponse } from '../types/ir.js';
import type { OpenAIDeltaChunk } from '../streaming/anthropic-events.js';

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

  // ---------- v0.7 流式 ----------

  buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
    // 强制 stream + 让上游在最后一个 chunk 送 usage (OpenAI 官方语义).
    // 不修改入参 ir, 避免污染调用方的对象.
    const streamIR: IRChatRequest = {
      ...ir,
      stream: true,
      stream_options: { include_usage: true, ...(ir as { stream_options?: object }).stream_options },
    } as IRChatRequest;
    return {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        // Accept 不必传, OpenAI 上游会按请求体 stream 字段决定 Content-Type.
      },
      body: JSON.stringify(streamIR),
    };
  }

  newStreamState(): StreamState {
    // OpenAI 流式不需要状态, 每行 chunk 自包含 (delta + finish_reason + 偶尔 usage)
    return {};
  }

  parseStreamChunk(rawLine: string, _state: StreamState): StreamChunkOutput {
    // 主循环已经把 `data:` 前缀剥掉, 这里直接判 [DONE] 或 JSON.parse
    const line = rawLine.trim();
    if (line.length === 0) return { chunks: [], done: false };
    if (line === '[DONE]') {
      return { chunks: [], done: true };
    }
    let parsed: OpenAIDeltaChunk;
    try {
      parsed = JSON.parse(line) as OpenAIDeltaChunk;
    } catch {
      // 上游偶尔会插入心跳行 / 空行, 跳过.
      return { chunks: [], done: false };
    }
    // OpenAI 风格 chunk 直接透传 (id / object / created / choices / usage 都已就绪)
    return { chunks: [parsed], done: false };
  }
}
