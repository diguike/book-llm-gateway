// 默认 channel 灌库 (channels 表为空时)
//
// v0.10 教学场景: 5 个 mock channel, 故意配不同的 cost_priority, 跑「成本路由 fallback」
// 时能直观看到主路径的选择决策与降级链路:
//
//   name                 cost_priority  supports_batch  说明
//   mock-cheap-batch     10             true            最便宜, 支持 batch
//   mock-cheap           20             false           次便宜的同步通道
//   mock-standard        50             false           标准价的官方主号
//   mock-backup          80             false           价格更高的备用号
//   mock-network-down    100            false           最贵, 但 baseUrl 不存在 (演示极端 fallback)
//
// 主路径 (group=default, model=mock-gpt-4o-mini) 总是优先选 cost_priority=10 的最便宜档,
// 失败后逐档降级到 cost_priority=20 -> 50 -> 80 -> 100.
//
// supports_batch=true 标记让 priority=low 的请求专门路由到 mock-cheap-batch.
//
// 真实部署时, 这些默认 channel 应当被运营在 admin 后台清掉, 换成生产用的真渠道.

import { getDb } from '../db/client.js';
import { channels } from '../db/schema.js';
import { createChannel } from './store.js';

const DEFAULT_CHANNELS = [
  {
    name: 'mock-cheap-batch',
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
    costPriority: 10,
    supportsBatch: true,
  },
  {
    name: 'mock-cheap',
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
    costPriority: 20,
    supportsBatch: false,
  },
  {
    name: 'mock-standard',
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
    costPriority: 50,
    supportsBatch: false,
  },
  {
    name: 'mock-backup',
    provider: 'mock',
    apiKey: 'mock',
    baseUrl: process.env.MOCK_BASE_URL ?? 'http://localhost:4010',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 100,
    weight: 5,
    costPriority: 80,
    supportsBatch: false,
  },
  {
    name: 'mock-network-down',
    provider: 'mock',
    // 故意指向不存在的端口, 演示「最贵但不可用」的极端 fallback 情况
    apiKey: 'mock',
    baseUrl: 'http://localhost:14999',
    enabledModels: ['mock-gpt-4o-mini'],
    priority: 50,
    weight: 1,
    costPriority: 100,
    supportsBatch: false,
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
      costPriority: seed.costPriority,
      supportsBatch: seed.supportsBatch,
    });
    inserted += 1;
  }
  return { inserted, skipped: 0 };
}
