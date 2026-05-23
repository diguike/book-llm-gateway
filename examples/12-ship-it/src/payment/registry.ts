// PaymentAdaptor 注册表
//
// 设计与 channels/registry.ts 类似但更简单:
//   - 进程级单例 Map<provider_name, PaymentAdaptor>
//   - 启动时注册 (本章 v0.11 只挂 mock)
//   - 业务代码按 name 取
//
// 真实运营加 stripe / alipay / wechat 时, 在 boot 阶段 register() 即可, 不动其他代码.

import type { PaymentAdaptor } from './types.js';
import { MockPaymentAdaptor } from './mock.js';

const adaptors = new Map<string, PaymentAdaptor>();

export function registerPaymentAdaptor(adaptor: PaymentAdaptor): void {
  adaptors.set(adaptor.name, adaptor);
}

export function getPaymentAdaptor(name: string): PaymentAdaptor | undefined {
  return adaptors.get(name);
}

export function listPaymentAdaptors(): string[] {
  return [...adaptors.keys()];
}

/**
 * 启动时调一次. 根据环境变量决定挂哪些 adapter. 本章 v0.11 只有 mock.
 */
export function bootstrapPaymentAdaptors(opts?: {
  mock?: { baseUrl: string; notifyUrl: string; secret: string };
}): void {
  if (adaptors.size > 0) return; // 已经初始化过

  if (opts?.mock) {
    registerPaymentAdaptor(
      new MockPaymentAdaptor({
        baseUrl: opts.mock.baseUrl,
        notifyUrl: opts.mock.notifyUrl,
        secret: opts.mock.secret,
      }),
    );
  }
}

/** 测试 / 重启场景: 清空注册表 */
export function resetPaymentAdaptors(): void {
  adaptors.clear();
}
