// 成本路由 + fallback
//
// 与 v0.9 router.ts::pickChannelForModel 的差异:
//   - v0.9 选 channel 按 priority desc (大优先级先选) + weight 随机. 解决「可用性」.
//   - v0.10 在 priority 之外多一档 costPriority asc (小成本先选). 解决「省钱」.
//
// 选择逻辑:
//   1. 取 (group, model) 下所有 active channel;
//   2. 排除 excludeIds (这次请求已经试过失败的);
//   3. 按 (cost_priority asc, priority desc) 分组;
//   4. 在最便宜那组里 weighted 选一个;
//   5. 主路径失败时, fallback 是「下一档 costPriority 更高的 channel」, 仍然在 active 集合内.
//
// 为什么这两档分开存:
//   - priority 解决「主备」, 例: 100=主, 50=备, 10=兜底. 主活就别动备. 一般运维不改.
//   - cost_priority 解决「省钱」, 例: 10=Azure 企业账号 (便宜), 50=官方 OpenAI (标准),
//     100=逆向号池 (贵但救急). 不同价位每月调整, 是高频运营字段.
//
// 一个真实场景: 同一个 gpt-4o-mini 挂 4 个 channel:
//
//   channel        priority cost_priority  说明
//   azure-oai-1    100      10             Azure 企业账号, 享 commit 折扣, 最便宜
//   openai-direct  100      50             官方直连, 标准价
//   openai-backup  50       50             官方备用 key, 主号炸了用
//   reseller-pool  100      100            第三方分销, 贵但充足
//
// v0.9 行为: priority desc -> azure / openai-direct / reseller-pool 三选一加权随机
//             (按 weight 配比), openai-backup 永远不会被选 (priority 低一档).
// v0.10 行为: cost_priority asc + priority desc -> 优先 azure-oai-1, 失败 -> openai-direct,
//             再失败 -> reseller-pool, 整个 priority=100 那一层穷尽后才往 priority=50 走.
//
// 算法上跟 weighted-picker 复用同一份 layer 算法, 但分层 key 从 priority 换成 (cost_priority, priority).

import type { ProviderAdaptor } from '../adaptors/base.js';
import {
  type ChannelEntry,
  getChannelRegistry,
  buildAdaptorForChannel,
} from '../channels/index.js';
import { pickChannel } from '../channels/weighted-picker.js';

export interface CostPickedChannel {
  channel: ChannelEntry;
  adaptor: ProviderAdaptor;
  /** 选中的 (cost_priority, priority) 元组, 调试日志用 */
  selectedTier: { costPriority: number; priority: number };
}

export interface CostPickOptions {
  /** 这次请求已经试过的 channel id */
  excludeIds?: ReadonlySet<number>;
  /** priority=low 时只看 supports_batch=true 的 channel */
  requireBatch?: boolean;
}

/**
 * 按 (cost_priority asc, priority desc) 分层, 在最便宜那一层里 weighted 选.
 * fallback 自动降到下一档.
 *
 * @param group       用户分组
 * @param model       模型名
 * @param options     excludeIds (重试时累加) / requireBatch (走 batch 通道时设 true)
 */
export function pickCheapestChannel(
  group: string,
  model: string,
  options?: CostPickOptions,
): CostPickedChannel | null {
  const registry = getChannelRegistry();
  let list = registry.lookup(group, model);
  if (list.length === 0) return null;

  if (options?.requireBatch) {
    list = list.filter((c) => c.supportsBatch);
    if (list.length === 0) return null;
  }

  // 按 cost_priority asc 分层, 然后同层按 priority desc 排
  //   sort 是稳定的 (Node 12+ 标准), 同 cost_priority + priority 的组内顺序就是 registry
  //   原顺序 (priority desc, 已在 registry.rebuild() 排好).
  const sorted = [...list].sort((a, b) => {
    if (a.costPriority !== b.costPriority) return a.costPriority - b.costPriority;
    return b.priority - a.priority;
  });

  // 逐层尝试: 同 costPriority 一层 -> weighted -> 失败再下一层
  let i = 0;
  while (i < sorted.length) {
    const currentCost = sorted[i]!.costPriority;
    const layer: ChannelEntry[] = [];
    while (i < sorted.length && sorted[i]!.costPriority === currentCost) {
      layer.push(sorted[i]!);
      i++;
    }
    // weighted-picker 内部还会按 priority 二次分层 + weight 随机
    const picked = pickChannel(layer, { excludeIds: options?.excludeIds });
    if (picked) {
      return {
        channel: picked,
        adaptor: buildAdaptorForChannel(picked),
        selectedTier: { costPriority: picked.costPriority, priority: picked.priority },
      };
    }
  }
  return null;
}

/**
 * 给定一组 channel + 当前已试过的 excludeIds, 算出「下一档应该试的 cost_priority」.
 *
 * 这是个纯查询函数, 用于看板 / 主路径日志打「下一档是 X」. 不影响主选择逻辑.
 */
export function nextCostTier(
  list: ReadonlyArray<ChannelEntry>,
  triedIds: ReadonlySet<number>,
): number | null {
  const remaining = list.filter((c) => !triedIds.has(c.id));
  if (remaining.length === 0) return null;
  return Math.min(...remaining.map((c) => c.costPriority));
}
