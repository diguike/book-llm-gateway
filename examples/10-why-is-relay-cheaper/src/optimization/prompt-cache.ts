// Prompt caching 透传层
//
// 这一层只做两件事:
//   1. 检查请求体里的 cache_control / 缓存提示字段是否完整、合规, 不破坏前缀;
//   2. 从上游 usage 字段里抽出 cached_input_tokens / cache_write_tokens, 让 billing
//      模块能按 cache 单价单独计费.
//
// 各家上游对 prompt caching 的语义差异:
//
// ┌────────────┬──────────────────────┬──────────────────────────────────────┐
// │ provider   │ 触发方式             │ usage 字段                           │
// ├────────────┼──────────────────────┼──────────────────────────────────────┤
// │ Anthropic  │ 显式 cache_control   │ usage.cache_read_input_tokens        │
// │            │ breakpoint (≤4 个)   │ usage.cache_creation_input_tokens    │
// │ OpenAI     │ ≥1024 token 自动     │ usage.prompt_tokens_details.cached_  │
// │            │ prefix 命中          │   tokens                             │
// │ Gemini     │ explicit cache API   │ usage_metadata.cached_content_token_ │
// │            │ + cache_name 引用    │   count                              │
// │ DeepSeek   │ 自动 KV cache,       │ usage.prompt_cache_hit_tokens        │
// │            │ 无显式控制           │ usage.prompt_cache_miss_tokens       │
// └────────────┴──────────────────────┴──────────────────────────────────────┘
//
// 网关层的护城河: 不破坏 prefix.
//
// 自动缓存 (OpenAI / DeepSeek) 要求两次请求的 prompt 前 N 字节字节级一致. 网关如果在 prompt
// 头里塞了 trace_id / timestamp / 随机串, 哪怕只有 4 个字符不同, 缓存命中率立刻归零.
// 这是中转站很容易踩的坑——为了「方便对账」在 system prompt 头加 trace_id, 然后客户成本翻倍.
//
// 本章不主动重写 prompt; 调用方传什么就发什么. cache_control 字段全字段透传, 用户自己决定
// 在哪个 message / block 上加 breakpoint.
//
// 引用:
//   - Anthropic Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   - OpenAI Prompt Caching:    https://openai.com/index/api-prompt-caching/
//   - DeepSeek Context Caching: https://api-docs.deepseek.com/news/news0802
//   - Gemini Context Caching:   https://ai.google.dev/gemini-api/docs/caching

import type { IRChatRequest, IRMessage } from '../types/ir.js';

/**
 * 从上游 (OpenAI 兼容协议) 的 usage 字段抽缓存命中 token 数.
 *
 * OpenAI 把缓存命中放在 usage.prompt_tokens_details.cached_tokens (≥1024 token 自动).
 * DeepSeek 把命中放在 usage.prompt_cache_hit_tokens (不限长度自动).
 * 我们做一个兼容抽取, 不存在的字段返回 0, 不破坏现有计费.
 */
export interface ExtractedCacheUsage {
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export function extractCacheUsageFromOpenAI(usage: unknown): ExtractedCacheUsage {
  if (!usage || typeof usage !== 'object') {
    return { cachedInputTokens: 0, cacheWriteTokens: 0 };
  }
  const u = usage as Record<string, unknown>;

  // OpenAI: prompt_tokens_details.cached_tokens
  let cachedTokens = 0;
  const details = u['prompt_tokens_details'];
  if (details && typeof details === 'object') {
    const ct = (details as Record<string, unknown>)['cached_tokens'];
    if (typeof ct === 'number' && ct >= 0) cachedTokens = ct;
  }

  // DeepSeek: prompt_cache_hit_tokens (顶层字段, 兼容老接口)
  const deepseekHit = u['prompt_cache_hit_tokens'];
  if (typeof deepseekHit === 'number' && deepseekHit >= 0 && cachedTokens === 0) {
    cachedTokens = deepseekHit;
  }

  return { cachedInputTokens: cachedTokens, cacheWriteTokens: 0 };
}

/**
 * Anthropic /v1/messages usage:
 *   - cache_read_input_tokens (命中)
 *   - cache_creation_input_tokens (写入)
 * 两者都不计入 input_tokens, 需要分开累加.
 */
export function extractCacheUsageFromAnthropic(usage: unknown): ExtractedCacheUsage {
  if (!usage || typeof usage !== 'object') {
    return { cachedInputTokens: 0, cacheWriteTokens: 0 };
  }
  const u = usage as Record<string, unknown>;
  const read = u['cache_read_input_tokens'];
  const write = u['cache_creation_input_tokens'];
  return {
    cachedInputTokens: typeof read === 'number' && read >= 0 ? read : 0,
    cacheWriteTokens: typeof write === 'number' && write >= 0 ? write : 0,
  };
}

/**
 * 检查请求体里是否带 cache_control 字段 (Anthropic 风格).
 * 用于网关层日志 / 看板按「带不带 cache_control」分桶统计.
 */
export function hasCacheControl(ir: IRChatRequest): boolean {
  for (const msg of ir.messages) {
    if (containsCacheControl(msg)) return true;
  }
  // OpenAI 没有 cache_control 字段, 缓存是自动的; 这里只检测 Anthropic 风格.
  return false;
}

function containsCacheControl(msg: IRMessage): boolean {
  // content 可能是 string / array. cache_control 出现在数组里的 block 上.
  if (typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  for (const block of msg.content) {
    if (block && typeof block === 'object' && 'cache_control' in block) {
      return true;
    }
  }
  return false;
}

/**
 * 网关层防御性检查: 不应该在 prompt 前缀里插入随机字符 (trace_id / timestamp).
 *
 * 这是一个「负向 assert」, 不返回任何东西; 只是在 dev 模式下做完整性检查.
 * 调用方决定要不要触发. 主路径不调, 因为我们本来就不重写 prompt;
 * 给读者一个工具, 自检他们写的 middleware 是不是无意中破坏了 prefix.
 */
export function assertPromptPrefixNotMutated(
  before: IRChatRequest,
  after: IRChatRequest,
): void {
  const firstBefore = before.messages[0];
  const firstAfter = after.messages[0];
  if (!firstBefore || !firstAfter) return;
  const beforeStr = typeof firstBefore.content === 'string' ? firstBefore.content : '';
  const afterStr = typeof firstAfter.content === 'string' ? firstAfter.content : '';
  if (beforeStr.length === 0 || afterStr.length === 0) return;
  // 取前 1024 字符做一致性比对 (OpenAI 自动缓存的最小 prefix 单位)
  const sliceLen = Math.min(1024, beforeStr.length, afterStr.length);
  if (beforeStr.slice(0, sliceLen) !== afterStr.slice(0, sliceLen)) {
    throw new Error(
      'prompt prefix was mutated before reaching upstream; this breaks OpenAI auto-cache',
    );
  }
}
