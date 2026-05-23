// 统一 IR (Intermediate Representation, 中间表示)
//
// 本书选择 OpenAI Chat Completions 协议作为 IR, 理由有三:
//   1. 事实标准: OpenAI 协议是市面客户端 SDK 默认对接的协议;
//   2. 零额外约束: 几乎所有上游都已经提供 OpenAI 兼容模式;
//   3. 可扩展: 用 zod 的 passthrough 允许字段透传, 后续章节再按需加字段.
//
// 后续章节会在 IR 上增量增加字段 (Ch3 system 顶层化, Ch5 计费元数据, Ch7 流式...).
// 本章先把最小必需字段定下来.

import { z } from 'zod';

// OpenAI message: role 与 content 是协议骨架, 其余字段用 passthrough 透传
export const IRMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.any()), z.null()]),
  })
  .passthrough();

// IRChatRequest 是网关内部用来代表「一次对话补全请求」的归一化结构
// 客户端 -> Hono 入口 -> zod 校验 -> IRChatRequest -> adaptor.buildRequest -> 上游
export const IRChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(IRMessageSchema).min(1),
    // 以下字段非必填, 由具体 adaptor 决定如何映射到上游
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().optional(),
    // stream 字段虽然定义了, 但本章 v0.2 暂不支持流式 (留给 Ch7)
    stream: z.boolean().optional(),
  })
  .passthrough();

export type IRMessage = z.infer<typeof IRMessageSchema>;
export type IRChatRequest = z.infer<typeof IRChatRequestSchema>;

// IRChatResponse 是上游响应归一化到 OpenAI Chat Completions 结构后的内部表示
// 对 OpenAI 兼容上游来说 (含 DeepSeek), 这个结构本质就是上游回包原样透传
// 对非兼容上游 (Ch3 Anthropic), 需要在 adaptor.parseResponse 里做字段映射
export interface IRChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // 允许上游回包额外字段透传, 不强校验
  [key: string]: unknown;
}
