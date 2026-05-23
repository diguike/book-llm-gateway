// 加权轮询选 channel
//
// 输入: 一组同 (group, model) 下的 ChannelEntry, 已按 priority desc 排序.
// 输出: 一个 ChannelEntry, 通过「优先级分层 + 同层加权随机」选出.
//
// 算法:
//   1. 取最高 priority 那一层的所有 channel 作为候选;
//   2. 排除 excludeIds 里出现过的 (这次请求已经试过、失败的, 不再选);
//   3. 候选为空 -> 降到下一层 priority, 重复;
//   4. 候选非空 -> 累加权重, 在 [0, totalWeight) 区间随机一个数, 顺序累加命中.
//
// 累加权重而不是「平均概率」: 让运营可以靠 weight 控制实际流量配比.
//   weights = [1, 1, 8] -> 第三个 channel 占 80% 流量.
//
// 为什么按 priority 分层而不是把所有 channel 混在一起按 weight 选:
//   场景: 一个企业级网关挂 4 个 channel:
//     - OpenAI 主号 (priority=100, weight=5) -- 主用
//     - OpenAI 备号 (priority=100, weight=5) -- 主用
//     - Azure OpenAI (priority=50, weight=1) -- 主号挂时的兜底
//     - 第三方代理 (priority=10, weight=1) -- 终极兜底, 质量不保
//   不分层的话, 每次请求都有概率打到第三方代理, 整体平均质量被拉低.
//   分层后, 只要 priority=100 那两个还活着, 流量永远不下沉.
//
// 参考: one-api model/cache.go::CacheGetRandomSatisfiedChannel 的 ignoreFirstPriority
// 机制 (重试时跳过当前优先级, 探索下一层) 本质上就是这套.

import type { ChannelEntry } from './registry.js';

export interface PickOptions {
  /** 这次请求已经试过的 channel id, 故障转移时累加 */
  excludeIds?: ReadonlySet<number>;
}

/**
 * 从一组候选里挑一个 channel.
 * 找不到 (全部已 exclude / 全部权重为 0) 返回 null.
 *
 * 假定 list 已经按 priority desc 排序 (ChannelRegistry.lookup 出来的列表满足这个不变量).
 */
export function pickChannel(
  list: ReadonlyArray<ChannelEntry>,
  options?: PickOptions,
): ChannelEntry | null {
  const exclude = options?.excludeIds;

  // 按 priority 分组. 因为已经排序, 用单次扫描就能切片.
  let i = 0;
  while (i < list.length) {
    const currentPriority = list[i]!.priority;
    const layer: ChannelEntry[] = [];
    while (i < list.length && list[i]!.priority === currentPriority) {
      const c = list[i]!;
      if (!exclude || !exclude.has(c.id)) {
        layer.push(c);
      }
      i++;
    }
    if (layer.length === 0) continue;

    // 加权随机
    const totalWeight = layer.reduce((acc, c) => acc + Math.max(0, c.weight), 0);
    if (totalWeight <= 0) {
      // 权重全是 0, 不应该参与轮询. 这一层视为没候选, 进入下一层.
      continue;
    }
    let r = Math.random() * totalWeight;
    for (const c of layer) {
      r -= Math.max(0, c.weight);
      if (r <= 0) return c;
    }
    // 浮点误差兜底: 返回最后一个
    return layer[layer.length - 1]!;
  }
  return null;
}
