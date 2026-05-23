// 支付平台异步回调接收
//
// 路径: POST /payment/notify/:provider
//
// 这条路径**不**经过 admin Bearer 鉴权 -- 平台的 webhook 服务器拿不到我们的 admin token,
// 凭据就是 PaymentAdaptor.verifyCallback 里的签名校验.
//
// 路由职责:
//   1. 按 :provider 取对应的 PaymentAdaptor;
//   2. 把 raw body + headers 交给 adapter.verifyCallback() 做验签;
//   3. 验签通过后, 按 payload.kind (recharge / refund) 分发给 wallet/service:
//        - recharge: handleRechargeCallback() (充值回调)
//        - refund:   handleRefundCallback() (退款回调)
//   4. 回 success / fail 字符串给平台 (各家约定不一, mock 用 plain text "success" / "fail").
//
// 重复回调:
//   平台经常重发同一笔回调 (例如 30s 后没收到 200 重试). 业务层在 handleRechargeCallback /
//   handleRefundCallback 里都做了状态机判断, 重复回调直接返回 ok, 不会二次入账.
//
// 验签失败:
//   返 400 (而不是 200), 让平台知道这次回调没被处理. 平台会按重试策略重发.

import { Hono } from 'hono';

import { getPaymentAdaptor } from '../payment/registry.js';
import { CallbackVerificationError } from '../payment/types.js';
import { handleRechargeCallback, handleRefundCallback } from '../wallet/service.js';
import { createChildLogger } from '../log/logger.js';

interface CallbackPayload {
  out_trade_no?: string;
  refund_no?: string;
  status?: string;
  amount_micro?: number;
  /** mock 协议字段, 区分充值回调 / 退款回调 */
  kind?: 'recharge' | 'refund';
}

export function createPaymentRouter(): Hono {
  const app = new Hono();
  const logger = createChildLogger({ component: 'payment-callback' });

  app.post('/notify/:provider', async (c) => {
    const provider = c.req.param('provider');
    const adaptor = getPaymentAdaptor(provider);
    if (!adaptor) {
      logger.warn({ provider }, 'unknown_payment_provider');
      return c.text('fail', 400);
    }

    const rawBody = await c.req.text();
    // 把所有 headers 拍平成一个 map (平台 SDK 一般按特定 header 拿验签材料)
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let verified;
    try {
      verified = await adaptor.verifyCallback(rawBody, headers);
    } catch (err) {
      if (err instanceof CallbackVerificationError) {
        logger.warn(
          { provider, reason: err.reason, body_preview: rawBody.slice(0, 200) },
          'callback_verify_failed',
        );
        return c.text('fail', 400);
      }
      logger.error(
        { provider, err: (err as Error).message },
        'callback_verify_unexpected_error',
      );
      return c.text('fail', 500);
    }

    // verifyCallback 返回的是「标准化字段」(out_trade_no/status/amount_micro), 但还需要从原 payload
    // 里取 kind (recharge or refund). 这是因为接口的设计原则是「标准化的能进 VerifiedCallback,
    // 私有的留在 rawPayload」, kind 是 mock 协议私有字段.
    let parsedRaw: CallbackPayload = {};
    try {
      parsedRaw = JSON.parse(rawBody) as CallbackPayload;
    } catch {
      /* 已经过 verifyCallback 解析, 这里再 parse 是为了取 kind, parse 失败也无所谓 */
    }
    const kind = parsedRaw.kind === 'refund' ? 'refund' : 'recharge';

    if (kind === 'recharge') {
      const result = handleRechargeCallback({
        outTradeNo: verified.outTradeNo,
        status: verified.status,
        amountMicro: verified.amountMicro,
        rawPayload: verified.rawPayload,
      });
      logger.info(
        {
          provider,
          out_trade_no: verified.outTradeNo,
          status: result.status,
          credited: result.credited,
          balance_after: result.balanceAfter,
          notice: result.notice,
        },
        'recharge_callback_processed',
      );
      return c.text('success', 200);
    }

    // kind === 'refund'
    if (typeof parsedRaw.refund_no !== 'string') {
      logger.warn({ provider, raw: rawBody.slice(0, 200) }, 'refund_callback_missing_refund_no');
      return c.text('fail', 400);
    }
    const result = handleRefundCallback({
      refundNo: parsedRaw.refund_no,
      status: verified.status,
      amountMicro: verified.amountMicro,
      rawPayload: verified.rawPayload,
    });
    logger.info(
      {
        provider,
        refund_no: parsedRaw.refund_no,
        status: result.status,
        released: result.released,
        balance_after: result.balanceAfter,
        notice: result.notice,
      },
      'refund_callback_processed',
    );
    return c.text('success', 200);
  });

  return app;
}
