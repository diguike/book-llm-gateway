// mock-payment-platform: 本地 HTTP server 模拟支付平台
//
// 这个文件**不属于网关**, 是一个独立的 HTTP 服务. 跟主网关一起跑能完整复现
// 「创建订单 -> 跳转支付 -> 异步回调 -> 入账」的链路, 不依赖任何真实支付 SDK.
//
// 协议设计 (mock 自定义, 简化版本):
//   - POST /api/orders                 创建订单, 返回 redirect_url, 然后异步回调
//   - POST /api/orders/:no/pay         手动触发「用户付款」(也可不调, 等定时器自动 3s 回调)
//   - POST /api/orders/:no/cancel      手动触发「用户取消」, 异步回调 status=failed
//   - POST /api/refunds                受理退款, 异步 2s 后回调
//   - GET  /api/orders/:no             查询订单状态 (容灾用)
//   - GET  /checkout?out_trade_no=...  「支付收银台」(GET HTML, 演示用)
//
// 默认端口 5010 (与 mock-upstream 的 4010 / 网关的 3000 错开).
//
// 重复回调演示:
//   每次回调成功后, 服务器会保留 5 秒的「重发窗口」. 在窗口内对同一个订单可以
//   再次手动触发回调 (POST /api/orders/:no/pay), 模拟支付平台的「30 秒后没收到 200 重试」行为.
//
// 验签 secret 与 adapter 共享 -- 通过环境变量 MOCK_PAY_SECRET 注入, 默认 "test-mock-secret".

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';

import { createChildLogger } from '../log/logger.js';

const logger = createChildLogger({ component: 'mock-payment-platform' });

const PORT = Number(process.env.MOCK_PAY_PORT ?? 5010);
const SECRET = process.env.MOCK_PAY_SECRET ?? 'test-mock-secret';
const AUTO_PAY_DELAY_MS = Number(process.env.MOCK_PAY_AUTO_DELAY_MS ?? 3000);
const REFUND_DELAY_MS = Number(process.env.MOCK_PAY_REFUND_DELAY_MS ?? 2000);
const NOTIFY_RETRY_MS = Number(process.env.MOCK_PAY_RETRY_MS ?? 0); // 0 = 不重发

interface OrderRecord {
  outTradeNo: string;
  amountMicro: number;
  userId: number;
  subject: string;
  notifyUrl: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  createdAt: number;
}

interface RefundRecord {
  refundNo: string;
  outTradeNo: string;
  amountMicro: number;
  reason: string;
  notifyUrl: string;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
}

const orders = new Map<string, OrderRecord>();
const refundsMap = new Map<string, RefundRecord>();

function computeSig(fields: { outTradeNo: string; status: string; amountMicro: number; kind: string }): string {
  const joined = `${fields.outTradeNo}|${fields.status}|${fields.amountMicro}|${fields.kind}`;
  return createHmac('sha256', SECRET).update(joined).digest('hex');
}

async function postNotify(
  notifyUrl: string,
  payload: Record<string, unknown>,
  attempt = 1,
): Promise<void> {
  try {
    const resp = await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    logger.info(
      { notify_url: notifyUrl, attempt, status: resp.status, resp_text: text.slice(0, 100) },
      'mock_pay_notify_sent',
    );
    // 演示「重复回调」: 接收方回 success 也再发一次
    if (NOTIFY_RETRY_MS > 0 && attempt < 2) {
      setTimeout(() => {
        void postNotify(notifyUrl, payload, attempt + 1);
      }, NOTIFY_RETRY_MS);
    }
  } catch (err) {
    logger.error(
      { notify_url: notifyUrl, attempt, err: (err as Error).message },
      'mock_pay_notify_failed',
    );
  }
}

function scheduleAutoPay(order: OrderRecord): void {
  if (AUTO_PAY_DELAY_MS <= 0) return;
  setTimeout(() => {
    if (order.status !== 'pending') return; // 用户中途手动取消了
    order.status = 'succeeded';
    const payload = {
      out_trade_no: order.outTradeNo,
      status: 'succeeded' as const,
      amount_micro: order.amountMicro,
      kind: 'recharge' as const,
      sig: computeSig({
        outTradeNo: order.outTradeNo,
        status: 'succeeded',
        amountMicro: order.amountMicro,
        kind: 'recharge',
      }),
    };
    void postNotify(order.notifyUrl, payload);
  }, AUTO_PAY_DELAY_MS);
}

function scheduleRefundNotify(refund: RefundRecord): void {
  if (REFUND_DELAY_MS <= 0) return;
  setTimeout(() => {
    if (refund.status !== 'pending') return;
    refund.status = 'succeeded';
    const order = orders.get(refund.outTradeNo);
    if (order) order.status = 'refunded';
    const payload = {
      out_trade_no: refund.outTradeNo,
      refund_no: refund.refundNo,
      status: 'succeeded' as const,
      amount_micro: refund.amountMicro,
      kind: 'refund' as const,
      sig: computeSig({
        outTradeNo: refund.outTradeNo,
        status: 'succeeded',
        amountMicro: refund.amountMicro,
        kind: 'refund',
      }),
    };
    void postNotify(refund.notifyUrl, payload);
  }, REFUND_DELAY_MS);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResp(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    // ---------- v1.0: 健康检查 (docker-compose healthcheck 用) ----------
    if (method === 'GET' && url === '/health') {
      jsonResp(res, 200, { ok: true, service: 'mock-payment-platform' });
      return;
    }
    // ---------- 创建订单 ----------
    if (method === 'POST' && url === '/api/orders') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as {
        out_trade_no?: string;
        amount_micro?: number;
        user_id?: number;
        subject?: string;
        notify_url?: string;
      };
      if (
        typeof parsed.out_trade_no !== 'string' ||
        typeof parsed.amount_micro !== 'number' ||
        typeof parsed.user_id !== 'number' ||
        typeof parsed.notify_url !== 'string'
      ) {
        jsonResp(res, 400, { error: 'missing fields' });
        return;
      }
      if (orders.has(parsed.out_trade_no)) {
        // 真实平台对重复 out_trade_no 通常返回原订单, 这里也一样
        const existed = orders.get(parsed.out_trade_no)!;
        jsonResp(res, 200, {
          out_trade_no: existed.outTradeNo,
          redirect_url: `http://localhost:${PORT}/checkout?out_trade_no=${existed.outTradeNo}`,
        });
        return;
      }
      const order: OrderRecord = {
        outTradeNo: parsed.out_trade_no,
        amountMicro: parsed.amount_micro,
        userId: parsed.user_id,
        subject: parsed.subject ?? 'unknown subject',
        notifyUrl: parsed.notify_url,
        status: 'pending',
        createdAt: Date.now(),
      };
      orders.set(order.outTradeNo, order);
      logger.info(
        {
          out_trade_no: order.outTradeNo,
          amount_micro: order.amountMicro,
          user_id: order.userId,
          auto_pay_delay_ms: AUTO_PAY_DELAY_MS,
        },
        'mock_pay_order_created',
      );
      scheduleAutoPay(order);
      jsonResp(res, 200, {
        out_trade_no: order.outTradeNo,
        redirect_url: `http://localhost:${PORT}/checkout?out_trade_no=${order.outTradeNo}`,
      });
      return;
    }

    // ---------- 受理退款 ----------
    if (method === 'POST' && url === '/api/refunds') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as {
        out_trade_no?: string;
        refund_no?: string;
        amount_micro?: number;
        reason?: string;
        notify_url?: string;
      };
      if (
        typeof parsed.out_trade_no !== 'string' ||
        typeof parsed.refund_no !== 'string' ||
        typeof parsed.amount_micro !== 'number' ||
        typeof parsed.notify_url !== 'string'
      ) {
        jsonResp(res, 400, { error: 'missing fields' });
        return;
      }
      const order = orders.get(parsed.out_trade_no);
      if (!order) {
        jsonResp(res, 404, { error: 'order not found' });
        return;
      }
      if (order.status !== 'succeeded') {
        jsonResp(res, 409, { error: `order status is ${order.status}, cannot refund` });
        return;
      }
      if (refundsMap.has(parsed.refund_no)) {
        const existed = refundsMap.get(parsed.refund_no)!;
        jsonResp(res, 200, { accepted: existed.status !== 'failed', platform_refund_no: existed.refundNo });
        return;
      }
      const refund: RefundRecord = {
        refundNo: parsed.refund_no,
        outTradeNo: parsed.out_trade_no,
        amountMicro: parsed.amount_micro,
        reason: parsed.reason ?? '',
        notifyUrl: parsed.notify_url,
        status: 'pending',
        createdAt: Date.now(),
      };
      refundsMap.set(refund.refundNo, refund);
      logger.info(
        {
          refund_no: refund.refundNo,
          out_trade_no: refund.outTradeNo,
          amount_micro: refund.amountMicro,
          refund_delay_ms: REFUND_DELAY_MS,
        },
        'mock_pay_refund_received',
      );
      scheduleRefundNotify(refund);
      jsonResp(res, 200, { accepted: true, platform_refund_no: refund.refundNo });
      return;
    }

    // ---------- 查询订单 ----------
    if (method === 'GET' && url.startsWith('/api/orders/')) {
      const no = decodeURIComponent(url.replace(/^\/api\/orders\//, ''));
      const order = orders.get(no);
      if (!order) {
        jsonResp(res, 404, { error: 'order not found' });
        return;
      }
      jsonResp(res, 200, { out_trade_no: order.outTradeNo, status: order.status });
      return;
    }

    // ---------- 手动触发 / 重发回调 (测试用) ----------
    if (method === 'POST' && url.startsWith('/api/orders/') && url.endsWith('/pay')) {
      const no = decodeURIComponent(url.replace(/^\/api\/orders\//, '').replace(/\/pay$/, ''));
      const order = orders.get(no);
      if (!order) {
        jsonResp(res, 404, { error: 'order not found' });
        return;
      }
      const wasSucceeded = order.status === 'succeeded';
      order.status = 'succeeded';
      const payload = {
        out_trade_no: order.outTradeNo,
        status: 'succeeded' as const,
        amount_micro: order.amountMicro,
        kind: 'recharge' as const,
        sig: computeSig({
          outTradeNo: order.outTradeNo,
          status: 'succeeded',
          amountMicro: order.amountMicro,
          kind: 'recharge',
        }),
      };
      void postNotify(order.notifyUrl, payload);
      jsonResp(res, 200, { status: 'succeeded', was_already_succeeded: wasSucceeded });
      return;
    }

    if (method === 'POST' && url.startsWith('/api/orders/') && url.endsWith('/cancel')) {
      const no = decodeURIComponent(url.replace(/^\/api\/orders\//, '').replace(/\/cancel$/, ''));
      const order = orders.get(no);
      if (!order) {
        jsonResp(res, 404, { error: 'order not found' });
        return;
      }
      order.status = 'failed';
      const payload = {
        out_trade_no: order.outTradeNo,
        status: 'failed' as const,
        amount_micro: order.amountMicro,
        kind: 'recharge' as const,
        sig: computeSig({
          outTradeNo: order.outTradeNo,
          status: 'failed',
          amountMicro: order.amountMicro,
          kind: 'recharge',
        }),
      };
      void postNotify(order.notifyUrl, payload);
      jsonResp(res, 200, { status: 'failed' });
      return;
    }

    // ---------- 「支付收银台」HTML ----------
    if (method === 'GET' && url.startsWith('/checkout')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
<h1>Mock Payment Platform</h1>
<p>This is a placeholder checkout page. The mock platform will auto-callback to the gateway in ${AUTO_PAY_DELAY_MS}ms.</p>
</body></html>`);
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    logger.error({ url, err: (err as Error).message }, 'mock_pay_handler_error');
    try {
      jsonResp(res, 500, { error: 'internal' });
    } catch {
      /* ignore */
    }
  }
});

server.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      auto_pay_delay_ms: AUTO_PAY_DELAY_MS,
      refund_delay_ms: REFUND_DELAY_MS,
      notify_retry_ms: NOTIFY_RETRY_MS,
    },
    'mock_pay_platform_listening',
  );
});
