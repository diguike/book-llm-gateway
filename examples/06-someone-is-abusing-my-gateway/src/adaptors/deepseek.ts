// DeepSeek 适配器
//
// DeepSeek 官方 API 100% 兼容 OpenAI Chat Completions 协议:
//   - endpoint: https://api.deepseek.com/v1/chat/completions
//   - 鉴权:    Authorization: Bearer ${apiKey}     (与 OpenAI 完全一致)
//   - 请求体:  与 OpenAI 完全一致
//   - 响应:    与 OpenAI 完全一致 (额外的 reasoning_content 字段透传即可)
//
// 所以实现上「继承 OpenAIAdaptor, 只换 baseURL」即可. 这恰好演示了
// OpenAICompatible 基类的价值: 接入新的 OpenAI 兼容上游 (Moonshot / 智谱 /
// 阶跃 / Together / SiliconFlow ...) 都只需要几行配置.
//
// 对照参考:
//   - one-api: relay/adaptor/deepseek/constants.go 全文只有 5 行 ModelList,
//     适配器实现直接复用 relay/adaptor/openai/adaptor.go (见 compatible.go
//     的 CompatibleChannels 列表, DeepSeek 是其中之一).
//   - LiteLLM: litellm/llms/deepseek/chat/transformation.py 共 123 行,
//     `class DeepSeekChatConfig(OpenAIGPTConfig)` 只覆盖 thinking / reasoning_effort
//     两个差异参数.
//   - Portkey v1.15.2: src/providers/deepseek/api.ts 也仅声明 baseURL 与
//     Authorization header.

import { OpenAIAdaptor, type OpenAICompatibleOptions } from './openai.js';

export class DeepSeekAdaptor extends OpenAIAdaptor {
  constructor(opts: Omit<OpenAICompatibleOptions, 'name'> & { name?: string }) {
    super({ name: opts.name ?? 'deepseek', baseURL: opts.baseURL, apiKey: opts.apiKey });
  }
}

// 如果有第三家 OpenAI 兼容上游 (例如 Moonshot), 这里也只需:
//
//   export class MoonshotAdaptor extends OpenAIAdaptor {
//     constructor(opts) {
//       super({ name: 'moonshot', baseURL: 'https://api.moonshot.cn', apiKey: opts.apiKey });
//     }
//   }
//
// 真正复杂的适配器留给 Ch3 的 Anthropic.
