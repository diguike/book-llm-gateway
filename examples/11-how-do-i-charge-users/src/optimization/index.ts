// optimization 子系统 barrel
//
// 三件子能力, 互相独立:
//   - prompt-cache.ts  : Anthropic / OpenAI / DeepSeek 缓存命中字段抽取 + cache_control 检测
//   - cost-router.ts   : 按 cost_priority 升序选 channel + fallback
//   - batch-channel.ts : priority=low 异步队列 + supports_batch=true channel 路由

export {
  extractCacheUsageFromOpenAI,
  extractCacheUsageFromAnthropic,
  hasCacheControl,
  assertPromptPrefixNotMutated,
  type ExtractedCacheUsage,
} from './prompt-cache.js';

export {
  pickCheapestChannel,
  nextCostTier,
  type CostPickedChannel,
  type CostPickOptions,
} from './cost-router.js';

export {
  enqueueBatchRequest,
  batchQueueSnapshot,
} from './batch-channel.js';
