// e2e: 充值 -> 异步回调 -> 余额到账 -> 调网关扣费 -> 退款 -> 余额恢复
//
// 前提:
//   1. 主网关在 :3000 启动 (npm run start)
//   2. mock-upstream 在 :4010 启动 (npm run mock)
//   3. mock-payment-platform 在 :5010 启动 (npm run mock-pay)
//
// 流程:
//   step 1: admin 创建 org / user (此时自动建 wallet, 初始余额 = INITIAL_BALANCE_CNY 或 0)
//   step 2: admin 重置 wallet 余额到 0 (准备演示充值)
//   step 3: admin 创建充值订单 (amountCny=10) -> 返回 redirect_url + recharge.id
//   step 4: 等待 mock 平台 3s 后异步回调 -> 网关入账, wallet.balance = 10
//   step 5: 用 user 的 Key 调一次 chat completion -> wallet.balance 扣 X 微元
//   step 6: admin 发起退款 (rechargeId) -> 等 mock 平台 2s 异步回调
//   step 7: wallet.balance 减 10 元 (扣穿到 -X 微元)
//
// 重复回调验证: step 4 完成后, 再 POST /api/orders/:no/pay 一次 (mock 平台手动触发回调),
// 网关会幂等返回 ok, wallet.balance 不变.
//
// 并发扣费验证: 单独的 npm run concurrency-test 跑.

import 'dotenv/config';

const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const MOCK_PAY_BASE = process.env.MOCK_PAY_BASE_URL ?? 'http://localhost:5010';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'admin-change-me';

interface AdminOrg {
  id: number;
  name: string;
}
interface AdminUser {
  id: number;
  walletId: number;
  walletBalanceMicro: number;
}
interface AdminKey {
  id: number;
  plaintext: string;
}
interface AdminWallet {
  id: number;
  userId: number;
  balanceMicro: number;
  balanceCny: number;
}
interface RechargeResp {
  recharge: { id: number; outTradeNo: string; status: string; amountMicro: number };
  credential: { kind: 'redirect_url'; url: string };
}
interface RefundResp {
  refund: { id: number; refundNo: string; status: string };
  accepted: boolean;
}

async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`admin ${path} -> ${resp.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function getWallet(userId: number): Promise<AdminWallet> {
  return adminFetch<AdminWallet>(`/admin/wallets/${userId}`);
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(msg: string, extra?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ${msg}`, extra ? JSON.stringify(extra) : '');
}

async function main(): Promise<void> {
  log('=== payment-flow-test start ===', { base: BASE, mock_pay: MOCK_PAY_BASE });

  // ------------------------------------------------------------
  // step 1: 建 org + user (自动建 wallet, 初始余额 0)
  // ------------------------------------------------------------
  const orgName = `payflow-${Date.now()}`;
  const org = await adminFetch<AdminOrg>('/admin/orgs', {
    method: 'POST',
    body: JSON.stringify({ name: orgName }),
  });
  const user = await adminFetch<AdminUser>('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ orgId: org.id, name: 'flow-user', balanceCny: 0 }),
  });
  log('user created', { userId: user.id, walletId: user.walletId, initialBalance: user.walletBalanceMicro });

  const key = await adminFetch<AdminKey>('/admin/keys', {
    method: 'POST',
    body: JSON.stringify({ userId: user.id, name: 'flow-key' }),
  });
  log('key issued', { keyId: key.id });

  // ------------------------------------------------------------
  // step 2: 创建充值订单 (10 元)
  // ------------------------------------------------------------
  const recharge = await adminFetch<RechargeResp>('/admin/recharges', {
    method: 'POST',
    body: JSON.stringify({ userId: user.id, provider: 'mock', amountCny: 10 }),
  });
  log('recharge order created', {
    rechargeId: recharge.recharge.id,
    outTradeNo: recharge.recharge.outTradeNo,
    redirect: recharge.credential.url,
  });

  // ------------------------------------------------------------
  // step 3: 等 mock 平台 3s 后自动回调 + 网关入账
  // ------------------------------------------------------------
  log('waiting 4s for async callback...');
  await sleep(4000);
  let wallet = await getWallet(user.id);
  log('wallet after recharge callback', { balanceCny: wallet.balanceCny });
  if (wallet.balanceCny !== 10) {
    throw new Error(`step 3 failed: expected 10, got ${wallet.balanceCny}`);
  }

  // ------------------------------------------------------------
  // step 4: 重复回调验证幂等 (再触发一次同一订单的回调)
  // ------------------------------------------------------------
  log('triggering duplicate callback...');
  const dupResp = await fetch(
    `${MOCK_PAY_BASE}/api/orders/${encodeURIComponent(recharge.recharge.outTradeNo)}/pay`,
    { method: 'POST' },
  );
  log('mock pay duplicate notify resp', { status: dupResp.status });
  await sleep(800);
  wallet = await getWallet(user.id);
  log('wallet after duplicate callback', { balanceCny: wallet.balanceCny });
  if (wallet.balanceCny !== 10) {
    throw new Error(`step 4 idempotent failed: expected 10, got ${wallet.balanceCny}`);
  }

  // ------------------------------------------------------------
  // step 5: 用 Key 调一次 chat completion, 验证从 wallet 扣费
  // ------------------------------------------------------------
  log('calling chat completion...');
  const chatResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key.plaintext}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mock-gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      stream: false,
    }),
  });
  log('chat resp status', { status: chatResp.status });
  await chatResp.text(); // drain
  if (!chatResp.ok) {
    throw new Error(`step 5 chat failed: ${chatResp.status}`);
  }
  await sleep(300);
  wallet = await getWallet(user.id);
  log('wallet after chat', { balanceMicro: wallet.balanceMicro, balanceCny: wallet.balanceCny });
  const afterChatMicro = wallet.balanceMicro;
  if (afterChatMicro >= 10_000_000) {
    throw new Error(`step 5 expected balance < 10 cny, got ${wallet.balanceCny}`);
  }
  const consumed = 10_000_000 - afterChatMicro;
  log('chat consumed', { microCny: consumed });

  // ------------------------------------------------------------
  // step 6: 发起退款
  // ------------------------------------------------------------
  log('initiating refund...');
  const refund = await adminFetch<RefundResp>('/admin/refunds', {
    method: 'POST',
    body: JSON.stringify({ rechargeId: recharge.recharge.id, reason: 'e2e-test' }),
  });
  log('refund accepted', { refundId: refund.refund.id, refundNo: refund.refund.refundNo });

  // ------------------------------------------------------------
  // step 7: 等 mock 平台 2s 异步回调 + 网关回退余额 (允许扣穿)
  // ------------------------------------------------------------
  log('waiting 3s for refund callback...');
  await sleep(3000);
  wallet = await getWallet(user.id);
  log('wallet after refund', { balanceMicro: wallet.balanceMicro, balanceCny: wallet.balanceCny });
  // 期望: balance ≈ afterChatMicro - 10_000_000 (扣穿)
  const expectedAfterRefund = afterChatMicro - 10_000_000;
  if (Math.abs(wallet.balanceMicro - expectedAfterRefund) > 1) {
    throw new Error(
      `step 7 failed: expected ~${expectedAfterRefund} micro, got ${wallet.balanceMicro}`,
    );
  }

  log('=== payment-flow-test PASSED ===', {
    summary: {
      initialBalance: 0,
      rechargeIn: 10_000_000,
      consumedByChat: consumed,
      refundedOut: 10_000_000,
      finalBalance: wallet.balanceMicro,
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('payment-flow-test FAILED:', err);
  process.exit(1);
});
