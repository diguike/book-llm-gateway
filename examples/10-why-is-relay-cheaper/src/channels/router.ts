// Channel router: 把 ChannelRegistry / weighted-picker / classifier 串起来,
// 对外暴露「按 (group, model) 选一个可用 channel 并构造 adaptor」的能力.
//
// 与 v0.7 的 ModelRouter 区别:
//   - v0.7: model -> 单个静态 adaptor 实例 (启动时 new). 一旦上游挂, 整条线路一起死.
//   - v0.8: model -> ChannelEntry[] -> 运行时按 priority+weight 选一个 -> 即时构造 adaptor.
//
// 即时构造 adaptor 而不是缓存 adaptor 实例的原因:
//   - 每个 channel 的 (provider, apiKey, baseUrl) 都不同, 缓存 adaptor 要按 channel_id 索引,
//     与 ChannelRegistry 数据双重维护, 难保证一致性;
//   - adaptor 是无状态的 (内部不持有连接池, fetch 用全局 undici dispatcher), 构造成本
//     可以忽略 (一次 new 大概 10 微秒);
//   - 流式情况下每次重试都换 channel = 换 adaptor, 即时构造天然适配.
//
// 与 one-api middleware/distributor.go::Distribute 的区别:
//   - one-api 把选 channel 写在 middleware, 通过 ctx.Set 把 channel 信息传给下游;
//   - 本书把它显式封装成 pickChannelForModel(), 主路径自己调, 不藏在 middleware 里,
//     是因为「重试时换 channel」必须能从主路径再次发起, 不能只在 middleware 跑一次.

import type { ProviderAdaptor } from '../adaptors/base.js';
import { OpenAIAdaptor } from '../adaptors/openai.js';
import { DeepSeekAdaptor } from '../adaptors/deepseek.js';
import { AnthropicAdaptor } from '../adaptors/anthropic.js';
import { getChannelRegistry, type ChannelEntry } from './registry.js';
import { pickChannel } from './weighted-picker.js';

export interface PickedChannel {
  channel: ChannelEntry;
  adaptor: ProviderAdaptor;
}

/**
 * 按 (group, model) 选一个可用 channel.
 *
 * @param group       用户分组. Ch8 范围内只用 'default'.
 * @param model       模型名, 必须与 channel.enabled_models JSON 数组里的元素严格相等.
 * @param excludeIds  这次请求已经试过的 channel id (故障转移时累加).
 */
export function pickChannelForModel(
  group: string,
  model: string,
  excludeIds?: ReadonlySet<number>,
): PickedChannel | null {
  const registry = getChannelRegistry();
  const list = registry.lookup(group, model);
  if (list.length === 0) return null;

  const picked = pickChannel(list, { excludeIds });
  if (!picked) return null;

  return {
    channel: picked,
    adaptor: buildAdaptorForChannel(picked),
  };
}

/**
 * 根据 channel.provider 构造一个 adaptor 实例. 用于探活 / 主路径调用.
 *
 * 三家 provider:
 *   - openai / mock          : OpenAIAdaptor (mock 上游也用 OpenAI 兼容协议)
 *   - deepseek               : DeepSeekAdaptor (继承自 OpenAIAdaptor, 接口 100% 兼容)
 *   - anthropic              : AnthropicAdaptor (协议差异最大, 流式归一化也走这条路)
 *
 * 新加 provider 在这里加一个 case 即可, 上层主路径不动.
 */
export function buildAdaptorForChannel(channel: ChannelEntry): ProviderAdaptor {
  switch (channel.provider) {
    case 'openai':
    case 'mock':
      return new OpenAIAdaptor({
        name: channel.provider,
        baseURL: channel.baseUrl,
        apiKey: channel.apiKey,
      });
    case 'deepseek':
      return new DeepSeekAdaptor({
        baseURL: channel.baseUrl,
        apiKey: channel.apiKey,
      });
    case 'anthropic':
      return new AnthropicAdaptor({
        baseURL: channel.baseUrl,
        apiKey: channel.apiKey,
      });
    default:
      // 未知 provider: 兜底走 OpenAI 兼容, 大多数国产模型都能接.
      return new OpenAIAdaptor({
        name: channel.provider,
        baseURL: channel.baseUrl,
        apiKey: channel.apiKey,
      });
  }
}
