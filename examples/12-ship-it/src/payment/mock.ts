// MockPaymentAdaptor: 本地 mock 支付平台适配器
//
// 不依赖任何外部 SDK. 这一份 adapter 配套 scripts/mock-payment-platform.ts (本地 HTTP server)
// 一起跑, 就能模拟「创建订单 -> 跳转支付 -> 异步回调 -> 入账」完整链路.
//
// 协议设计 (mock 自定义, 不模仿任何真实平台):
//   - createOrder POST $MOCK_PAY_BASE/api/orders
//                 body: { out_trade_no, amount_micro, user_id, subject, notify_url }
//                 resp: { redirect_url: "$MOCK_PAY_BASE/checkout?out_trade_no=..." }
//
//   - 用户「点击支付」(模拟): mock-payment-platform 在 3s (默认) 后向 notify_url POST 一份 payload.
//                            payload 里的 'sig' 字段是 HMAC-SHA256(out_trade_no + status + amount_micro, MOCK_SECRET)
//
//   - verifyCallback: 算同样的 HMAC, 与 payload.sig 比对. 不通过 throw CallbackVerificationError.
//
//   - refund POST $MOCK_PAY_BASE/api/refunds
//                 body: { out_trade_no, refund_no, amount_micro, reason }
//                 resp: { accepted: true }
//                 然后 mock 平台在 2s 后异步回调 notify_url, payload.kind = 'refund'
//
//   - queryStatus GET $MOCK_PAY_BASE/api/orders/:out_trade_no
//
// 真实平台的验签材料位置:
//   - Stripe:   header['Stripe-Signature']
//   - 支付宝:    payload 字段 'sign'
//   - 微信:     header['Wechatpay-Signature']
// mock 这里把签名放进 payload 字段 'sig' (类似支付宝).

import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  CreateOrderInput,
  CreateOrderOutput,
  PaymentAdaptor,
  QueryStatusOutput,
  RefundInput,
  RefundOutput,
  VerifiedCallback,
} from './types.js';
import { CallbackVerificationError } from './types.js';

export interface MockPaymentAdaptorOptions {
  /** mock 平台的 base URL, 例如 http://localhost:5010 */
  baseUrl: string;
  /** 网关侧的回调 URL, mock 平台会 POST 到这里 */
  notifyUrl: string;
  /** HMAC secret, mock 平台与 adapter 共享. 真实平台是平台分配的 webhook secret. */
  secret: string;
  /** fetch 超时 (ms), 默认 5000 */
  timeoutMs?: number;
}

interface MockOrderResponse {
  redirect_url: string;
  out_trade_no: string;
}

interface MockRefundResponse {
  accepted: boolean;
  platform_refund_no?: string;
}

interface MockQueryResponse {
  out_trade_no: string;
  status: string;
}

/**
 * 计算 mock 平台用的签名: HMAC-SHA256(joined fields, secret) hex.
 *
 * 字段拼接顺序 (与 mock-payment-platform.ts 必须一致):
 *   `${out_trade_no}|${status}|${amount_micro}|${kind}`
 */
export function computeMockSignature(
  fields: { outTradeNo: string; status: string; amountMicro: number; kind: string },
  secret: string,
): string {
  const joined = `${fields.outTradeNo}|${fields.status}|${fields.amountMicro}|${fields.kind}`;
  return createHmac('sha256', secret).update(joined).digest('hex');
}

/**
 * 用 timingSafeEqual 防止时序攻击. 长度不一致直接返 false (timingSafeEqual 要求等长).
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export class MockPaymentAdaptor implements PaymentAdaptor {
  readonly name = 'mock';

  constructor(private readonly opts: MockPaymentAdaptorOptions) {}

  async createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
    const resp = await this.fetchJson<MockOrderResponse>('POST', '/api/orders', {
      out_trade_no: input.outTradeNo,
      amount_micro: input.amountMicro,
      user_id: input.userId,
      subject: input.subject,
      notify_url: this.opts.notifyUrl,
    });
    return {
      outTradeNo: input.outTradeNo,
      credential: { kind: 'redirect_url', url: resp.redirect_url },
    };
  }

  /**
   * 验签 + 解析回调.
   *
   * payload 是 mock 平台 POST 过来的 JSON 字符串 (Content-Type: application/json).
   * headers 在 mock 协议里不带验签材料 (签名直接放在 payload.sig), 留参数是为了与 Stripe / 微信 V3
   * 这种「签名在 header」的平台共享接口形态.
   */
  async verifyCallback(payload: string, _headers: Record<string, string>): Promise<VerifiedCallback> {
    let parsed: {
      out_trade_no?: string;
      status?: string;
      amount_micro?: number;
      kind?: string;
      sig?: string;
    };
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      throw new CallbackVerificationError('payload is not valid JSON', 'invalid_json');
    }
    if (
      typeof parsed.out_trade_no !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.amount_micro !== 'number' ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.sig !== 'string'
    ) {
      throw new CallbackVerificationError('missing required fields', 'missing_fields');
    }

    const expected = computeMockSignature(
      {
        outTradeNo: parsed.out_trade_no,
        status: parsed.status,
        amountMicro: parsed.amount_micro,
        kind: parsed.kind,
      },
      this.opts.secret,
    );
    if (!safeEqualHex(parsed.sig, expected)) {
      throw new CallbackVerificationError('signature mismatch', 'sig_mismatch');
    }
    if (parsed.status !== 'succeeded' && parsed.status !== 'failed') {
      throw new CallbackVerificationError(
        `unexpected status: ${parsed.status}`,
        'unexpected_status',
      );
    }
    return {
      outTradeNo: parsed.out_trade_no,
      status: parsed.status,
      amountMicro: parsed.amount_micro,
      rawPayload: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundOutput> {
    const resp = await this.fetchJson<MockRefundResponse>('POST', '/api/refunds', {
      out_trade_no: input.outTradeNo,
      refund_no: input.refundNo,
      amount_micro: input.amountMicro,
      reason: input.reason,
      notify_url: this.opts.notifyUrl,
    });
    return {
      accepted: resp.accepted === true,
      platformRefundNo: resp.platform_refund_no,
      rawPayload: JSON.stringify(resp),
    };
  }

  async queryStatus(outTradeNo: string): Promise<QueryStatusOutput> {
    const resp = await this.fetchJson<MockQueryResponse>(
      'GET',
      `/api/orders/${encodeURIComponent(outTradeNo)}`,
      null,
    );
    const known = new Set(['pending', 'succeeded', 'failed', 'refunded']);
    return {
      outTradeNo,
      status: known.has(resp.status) ? (resp.status as QueryStatusOutput['status']) : 'unknown',
      rawPayload: JSON.stringify(resp),
    };
  }

  // ----- 内部 -----

  private async fetchJson<T>(method: string, path: string, body: unknown): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const resp = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`mock_payment_http_${resp.status}: ${text.slice(0, 200)}`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`mock_payment_invalid_json: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(t);
    }
  }
}
