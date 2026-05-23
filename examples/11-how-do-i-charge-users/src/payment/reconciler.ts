// 退款 / 充值对账脚本骨架 (T+1)
//
// 真实运营每天凌晨拉一次支付平台对账文件 (Stripe Reports / 支付宝对账单 / 微信资金账单),
// 与网关侧 recharges + refunds 表 diff. 平账则归档, 不平则告警 + 人工复核.
//
// 本骨架只演示 diff 逻辑, 不实现具体平台的对账文件下载 (各家格式 / 鉴权差异大, 留作扩展).
//
// diff 维度:
//   1. 网关有, 平台没: 我方丢单 (回调到了但没存好). 极少发生, 如果有需要紧急人工处理.
//   2. 平台有, 网关没: 平台单边账 (回调没送到 / 验签失败丢弃). 比 1 常见,
//      处理方式: 调 adapter.queryStatus() 二次确认, 然后手动调 handleRechargeCallback.
//   3. 双边都有但状态不一致 (例如平台 succeeded, 我方 pending): 回调丢失.
//      处理方式: 同 2.
//   4. 金额不一致: 罕见, 几乎一定是上游 bug 或人工篡改, 直接告警, 不自动修.
//
// 调用方式:
//   npx tsx src/payment/reconciler.ts --provider mock --date 2026-05-15

import { eq, and, gte, lte } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { recharges, type Recharge } from '../db/schema.js';
import { getPaymentAdaptor } from './registry.js';
import type { PaymentAdaptor, QueryStatusOutput } from './types.js';

export interface ReconciliationDiff {
  /** 双方都 OK 的订单数 */
  matched: number;
  /** 网关侧有但平台侧没找到 (或状态 unknown). 需要人工 */
  gatewayOnly: Array<{ outTradeNo: string; gatewayStatus: string }>;
  /** 平台侧 succeeded 但网关侧仍 pending: 回调丢失. 自动补单候选 */
  pendingButPlatformSucceeded: Array<{
    outTradeNo: string;
    gatewayStatus: string;
    platformStatus: string;
  }>;
  /** 状态不一致 (非 above) */
  statusMismatch: Array<{ outTradeNo: string; gatewayStatus: string; platformStatus: string }>;
}

export interface ReconcileOptions {
  provider: string;
  /** unix ms 起始 (含) */
  fromMs: number;
  /** unix ms 截止 (含) */
  toMs: number;
}

/**
 * T+1 对账主流程.
 *
 * 教学版只做「网关侧每条 pending / succeeded 订单都去 adapter.queryStatus() 二次确认」, 不下载
 * 平台对账文件. 真实运营要把这两步合起来 -- 先用对账文件做完全集 diff, 个别异常订单再 query 二次确认.
 */
export async function reconcileRecharges(opts: ReconcileOptions): Promise<ReconciliationDiff> {
  const adaptor = getPaymentAdaptor(opts.provider);
  if (!adaptor) {
    throw new Error(`payment provider not registered: ${opts.provider}`);
  }
  const db = getDb();
  const rows: Recharge[] = db
    .select()
    .from(recharges)
    .where(
      and(
        eq(recharges.provider, opts.provider),
        gte(recharges.createdAt, opts.fromMs),
        lte(recharges.createdAt, opts.toMs),
      ),
    )
    .all();

  const diff: ReconciliationDiff = {
    matched: 0,
    gatewayOnly: [],
    pendingButPlatformSucceeded: [],
    statusMismatch: [],
  };

  for (const r of rows) {
    let q: QueryStatusOutput;
    try {
      q = await adaptor.queryStatus(r.outTradeNo);
    } catch {
      diff.gatewayOnly.push({ outTradeNo: r.outTradeNo, gatewayStatus: r.status });
      continue;
    }
    const platformStatus = q.status;
    if (platformStatus === 'unknown') {
      diff.gatewayOnly.push({ outTradeNo: r.outTradeNo, gatewayStatus: r.status });
      continue;
    }
    if (r.status === platformStatus) {
      diff.matched += 1;
      continue;
    }
    if (r.status === 'pending' && platformStatus === 'succeeded') {
      diff.pendingButPlatformSucceeded.push({
        outTradeNo: r.outTradeNo,
        gatewayStatus: r.status,
        platformStatus,
      });
      continue;
    }
    diff.statusMismatch.push({
      outTradeNo: r.outTradeNo,
      gatewayStatus: r.status,
      platformStatus,
    });
  }
  return diff;
}

/**
 * 把 reconcile 出的「pendingButPlatformSucceeded」自动补单 -- 调 handleRechargeCallback
 * 完成入账 (走与正常回调同一份代码, 保证幂等). 真实运营常见做法.
 */
export async function autoFixPendingFromReconciliation(
  diff: ReconciliationDiff,
  adaptor: PaymentAdaptor,
  apply: (input: { outTradeNo: string; status: 'succeeded'; amountMicro: number; rawPayload: string }) => void,
): Promise<{ fixed: number; failed: number }> {
  let fixed = 0;
  let failed = 0;
  for (const item of diff.pendingButPlatformSucceeded) {
    try {
      const q = await adaptor.queryStatus(item.outTradeNo);
      const db = getDb();
      const rows = db.select().from(recharges).where(eq(recharges.outTradeNo, item.outTradeNo)).all();
      if (rows.length === 0) {
        failed += 1;
        continue;
      }
      apply({
        outTradeNo: item.outTradeNo,
        status: 'succeeded',
        amountMicro: rows[0]!.amountMicro,
        rawPayload: q.rawPayload,
      });
      fixed += 1;
    } catch {
      failed += 1;
    }
  }
  return { fixed, failed };
}
