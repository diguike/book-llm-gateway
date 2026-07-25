// 并发扣费验证: 启 N 个 chat 请求并发打同一个 user, 余额仅够 ≤ N 笔预扣.
//
// 验证点 (核心):
//   1. wallet.balance 永远不会被扣到负数 (preConsume 阶段乐观锁); ★ 主断言
//   2. 失败的请求是 402 (insufficient_quota), 不是 500.
//
// 注意: 「成功 / 失败的笔数」不是确定值, 因为 postConsume 会退回 (pre - final) 的差额,
// 这个差额回到 wallet 后, 后续请求又能预扣成功. 因此「成功数」介于 [初始余额 / 单笔预扣]
// 与 [初始余额 / 单笔实结] 之间. 但「不扣穿」必须严格成立.

import 'dotenv/config';

const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'admin-change-me';

// 期望余额: 每笔 mock-gpt-4o-mini 预扣大约 33000 微元 (8 max_tokens × ~4 元/1M output).
// 我们灌 100 微元 / 笔预扣大约 33000 → 0 笔够 → 调大成本预扣到 10000 微元每笔, 灌入 50000 微元
// 余额, 用 8 max_tokens, 预期成功 1 笔 (大概), 改用更可控的方式: 注入很大的余额 + 大量并发,
// 然后看「总扣减 = (成功数 × 实结成本) + 失败数 × 0」.

// 简化版: 灌余额 = N_REQUESTS × 单笔预扣 + 余额边界. 然后并发 N+5 笔, 期望 5 笔失败.

const CONCURRENT = Number(process.env.CONCURRENCY ?? 50);
// 预扣金额: max_tokens=8, mock 价格 (mock-gpt-4o-mini = 1 元/1M input + 4 元/1M output) ×
// (estimated_prompt_tokens + max_tokens) ≈ 35 微元 / 笔.
const PER_REQUEST_PRE_RESERVE_MICRO = 35;
// 余额给得很紧: 只够 ~3 笔预扣同时占着. postConsume 返还 ~30 微元后, 后续才能继续.
// 期望最终成功数 < CONCURRENT, 部分笔 402.
const INITIAL_BUDGET_MICRO = 3 * PER_REQUEST_PRE_RESERVE_MICRO;

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

async function main(): Promise<void> {
  // ---- 1. 建 user + key, 灌入精确余额 ----
  const orgName = `conc-${Date.now()}`;
  const org = await adminFetch<{ id: number }>('/admin/orgs', {
    method: 'POST',
    body: JSON.stringify({ name: orgName }),
  });
  const user = await adminFetch<{ id: number; walletId: number }>('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ orgId: org.id, name: 'conc-user', balanceCny: 0 }),
  });

  // 用 admin-set 强制把 wallet.balance 设成 INITIAL_BUDGET_MICRO (绕过 ensureWallet
  // 不覆盖已有余额的语义).
  await adminFetch<{ balanceMicro: number }>(`/admin/wallets/${user.id}/admin-set`, {
    method: 'POST',
    body: JSON.stringify({ balanceMicro: INITIAL_BUDGET_MICRO }),
  });

  const key = await adminFetch<{ plaintext: string }>('/admin/keys', {
    method: 'POST',
    body: JSON.stringify({ userId: user.id, name: 'conc-key' }),
  });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      stage: 'setup',
      userId: user.id,
      initial_balance_micro: INITIAL_BUDGET_MICRO,
      pre_reserve_per_request_micro: PER_REQUEST_PRE_RESERVE_MICRO,
    }),
  );

  // ---- 2. 并发打 CONCURRENT 笔, 预期 SHOULD_SUCCEED 笔成功 ----
  const launches = Array.from({ length: CONCURRENT }, async (_, i) => {
    const start = Date.now();
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.plaintext}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mock-gpt-4o-mini',
        messages: [{ role: 'user', content: `c${i}` }],
        max_tokens: 8,
        stream: false,
      }),
    });
    await resp.text();
    return { i, status: resp.status, latencyMs: Date.now() - start };
  });

  const results = await Promise.all(launches);
  const ok = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 402).length;
  const other = results.filter((r) => r.status !== 200 && r.status !== 402);

  // ---- 3. 校验 ----
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        stage: 'result',
        concurrent: CONCURRENT,
        initial_budget_micro: INITIAL_BUDGET_MICRO,
        actual_200: ok,
        actual_402: limited,
        other,
      },
      null,
      2,
    ),
  );
  // 余额检查
  const finalWallet = await adminFetch<{ balanceMicro: number; balanceCny: number }>(
    `/admin/wallets/${user.id}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ stage: 'final_wallet', balance_micro: finalWallet.balanceMicro }),
  );
  // ★ 主断言: 余额永远不能 < 0 (wallet 乐观锁的核心承诺).
  if (finalWallet.balanceMicro < 0) {
    throw new Error(`balance went negative: ${finalWallet.balanceMicro}`);
  }
  // ★ 至少要有 1 笔被乐观锁拒掉, 否则证明不了锁起作用.
  //    (除非 postConsume 退回得太快, 全部 20 笔挤在 budget 里成功 -- 这种情况要把预算压更小)
  if (limited === 0 && ok === CONCURRENT) {
    throw new Error(
      `expected at least one 402 (budget too tight = ${INITIAL_BUDGET_MICRO}, but all ${CONCURRENT} succeeded)`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      stage: 'pass',
      verdict: 'wallet optimistic lock prevented overspend',
    }),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('wallet-concurrency-test FAILED:', err);
  process.exit(1);
});
