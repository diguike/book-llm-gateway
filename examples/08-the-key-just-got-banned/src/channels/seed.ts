// 默认 channel 灌库 (channels 表为空时)
//
// v0.8 教学场景需要至少 3 个 channel 才能看到「故障转移」工作:
//   - mock-1 + mock-2: 两个 mock 上游 channel, baseUrl 都指向 :4010 但用不同的 api_key,
//     mock-1 的 api_key 是 'mock' (合法), mock-2 故意填 'will-fail-401', mock-upstream
//     脚本会按这个 key 判定是否返 401, 演示「按错误类型自动禁用」.
//   - openai-fail: 一个故意填错 key 的 OpenAI channel, 用来演示「上游不可达 -> retryable
//     -> 换 channel 重试」(网络层错路径, 与 401 disable 路径互补).
//
// 真实部署时, 这些默认 channel 应当被运营在 admin 后台清掉, 换成生产用的真渠道.
// 当 channels 表非空时本函数不做任何事情, 不破坏已有配置.
//
// 价格已在 billing/prices.ts 的默认表里灌过 (mock-gpt-4o-mini / gpt-4o-mini 都有价格).

import { getDb } from '../db/client.js';
import { channels } from '../db/schema.js';
import { createChannel } from './store.js';

const DEFAULT_CHANNELS = [
  {
    name: 'mock-primary',
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
  },
  {
    name: 'mock-bad-key',
    provider: 'mock',
    // 故意填错 key, mock-upstream 会按这个 key 判定返 401, 演示自动禁用
    apiKey: 'will-fail-401',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
  },
  {
    name: 'mock-network-unreachable',
    provider: 'mock',
    // baseUrl 指向不存在的端口, fetch 会抛 ECONNREFUSED, 演示 retryable
    apiKey: 'mock',
    baseUrl: 'http://localhost:14999',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 50, // 低 priority, 在前两个挂之后才会被试到
    weight: 1,
  },
];

export function seedDefaultChannelsIfEmpty(): { inserted: number; skipped: number } {
  const db = getDb();
  const existing = db.select({ id: channels.id }).from(channels).limit(1).all();
  if (existing.length > 0) {
    return { inserted: 0, skipped: DEFAULT_CHANNELS.length };
  }
  let inserted = 0;
  for (const seed of DEFAULT_CHANNELS) {
    createChannel({
      name: seed.name,
      provider: seed.provider,
      apiKey: seed.apiKey,
      baseUrl: seed.baseUrl,
      enabledModels: seed.enabledModels,
      priority: seed.priority,
      weight: seed.weight,
    });
    inserted += 1;
  }
  return { inserted, skipped: 0 };
}
