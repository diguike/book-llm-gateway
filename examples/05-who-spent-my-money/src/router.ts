// 模型路由表
//
// v0.3 的路由策略: 按 model 字段的前缀决定使用哪个 Adaptor.
//   - gpt-*      / o1-* / o3-*  -> OpenAI
//   - deepseek-*                -> DeepSeek
//   - claude-*                  -> Anthropic    (本章新增)
//
// 路由表通过 (prefix, adaptor) 配对维护. 命中第一个匹配的前缀即使用对应 adaptor.
// 后续章节会演进:
//   - Ch4: 接持久层之后路由表迁到数据库, 但「prefix -> adaptor」结构保留;
//   - Ch8: 同一个 model 可能映射到多个 Channel, 升级为「model -> channels -> adaptor」.

import type { ProviderAdaptor } from './adaptors/base.js';

export interface RouteRule {
  /** model 字段前缀, 命中即路由到对应 adaptor */
  prefix: string;
  adaptor: ProviderAdaptor;
}

export class ModelRouter {
  private readonly rules: RouteRule[];

  constructor(rules: RouteRule[]) {
    this.rules = rules;
  }

  /**
   * 根据 model 字段挑选 adaptor
   * 命中规则: 找到第一个 model.startsWith(rule.prefix) 的规则
   * 没命中返回 undefined, 上层路由把这个情况转成 400 错误
   */
  resolve(model: string): ProviderAdaptor | undefined {
    for (const rule of this.rules) {
      if (model.startsWith(rule.prefix)) {
        return rule.adaptor;
      }
    }
    return undefined;
  }

  /** 调试用: 输出所有已注册的 (prefix, adaptor.name) 配对 */
  describe(): Array<{ prefix: string; provider: string }> {
    return this.rules.map((r) => ({ prefix: r.prefix, provider: r.adaptor.name }));
  }
}
