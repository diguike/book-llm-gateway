// 本地 token 估算
//
// 用 js-tiktoken 离线算输入 token 数. 为什么需要本地估算:
//   1. preConsume 阶段还没调上游, 拿不到上游回包里的 usage. 必须用本地估算
//      input tokens, 才能算预扣金额, 拦截「余额不足」的请求;
//   2. 上游回包不一定带 usage. OpenAI 流式响应在没传 stream_options.include_usage
//      时不会返回 usage; 部分国产 OpenAI 兼容上游 (尤其老版本) 完全不返 usage.
//      本地估算是兜底的最后一道防线;
//   3. 双路对账: 本地估算值与上游回包 usage 入库分两列存, 月度审计时可以发现
//      上游悄悄虚报 token 数的情况.
//
// 为什么选 js-tiktoken 而不是 tiktoken (Rust binding):
//   - tiktoken 需要 napi-rs, native binding, Cloudflare Workers 部署不可用;
//   - js-tiktoken 是纯 JS 实现, 单文件 npm install 即可, 性能足够 (单条消息 < 1ms);
//   - 精度对计费场景够用. tiktoken 本地估算 vs 上游真实 usage 的 diff 通常在 1-3%,
//     这个数量级被 multiplier 吞掉了.
//
// 关于 Anthropic / Claude:
//   - Claude 没有公开的 BPE tokenizer, 严格意义上无法本地精确算 token;
//   - 业界惯例是用 cl100k_base 估算 + 经验系数 (大约 1.0-1.2x);
//   - 本章用 cl100k 直接估, 误差由 postConsume 的真实 usage 修正.

import { Tiktoken, getEncodingNameForModel, type TiktokenEncoding } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

import type { IRMessage } from '../types/ir.js';

// 缓存编码器实例. js-tiktoken/lite 没自带缓存, 创建有几毫秒开销.
const ENCODERS = new Map<TiktokenEncoding, Tiktoken>();

function getEncoder(name: TiktokenEncoding): Tiktoken {
  let enc = ENCODERS.get(name);
  if (enc) return enc;
  const ranks = name === 'o200k_base' ? o200k_base : cl100k_base;
  enc = new Tiktoken(ranks);
  ENCODERS.set(name, enc);
  return enc;
}

/** 根据 model 选合适的编码器名. 未知模型用 cl100k_base 兜底. */
function pickEncoding(model: string): TiktokenEncoding {
  try {
    // js-tiktoken 内置了 model -> encoding 映射, 覆盖 gpt-4 / gpt-4o / gpt-3.5 等
    return getEncodingNameForModel(model as never);
  } catch {
    // gpt-4o / o1 / o3 用 o200k_base; 其他兜底 cl100k_base
    if (/^(o1|o3|gpt-4o|gpt-5)/.test(model)) return 'o200k_base';
    return 'cl100k_base';
  }
}

/**
 * 估算一条消息列表的 prompt token 数.
 *
 * 算法参考 OpenAI 官方 cookbook 的 num_tokens_from_messages:
 *   - 每条消息有固定开销 (role / content 字段封装), 约 3-4 token;
 *   - tools 字段大致按 JSON 字面长度计 (粗略);
 *   - 系统消息 / 工具调用结果按字符串 encode.
 *
 * 误差通常在 1-3% 以内. 流式 / 非流式 input 估算同此函数.
 */
export function estimatePromptTokens(messages: IRMessage[], model: string): number {
  const enc = getEncoder(pickEncoding(model));
  let tokens = 0;
  for (const m of messages) {
    // 每条消息固定 4 token 开销 (粗估: <im_start>role\ncontent<im_end>\n)
    tokens += 4;
    // role
    tokens += enc.encode(m.role).length;
    // content
    const c = m.content;
    if (typeof c === 'string') {
      tokens += enc.encode(c).length;
    } else if (Array.isArray(c)) {
      // multimodal: 取 type=text 段累加; image_url 段固定 85 token 兜底
      for (const part of c as Array<{ type?: string; text?: string }>) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          tokens += enc.encode(part.text).length;
        } else {
          tokens += 85;
        }
      }
    }
  }
  // assistant 回复的引导 token (粗估)
  tokens += 2;
  return tokens;
}

/**
 * 估算一段补全文本的 completion token 数.
 *
 * 流式场景: streaming-counter 会在收到每个 SSE delta 时调它累加.
 */
export function estimateCompletionTokens(text: string, model: string): number {
  if (!text) return 0;
  const enc = getEncoder(pickEncoding(model));
  return enc.encode(text).length;
}
