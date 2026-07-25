// failover-test: 验证渠道池 + 故障转移端到端跑通
//
// 流程:
//   1. 假定 admin 接口已经配好 3 个 channel:
//        - mock-primary       (正确 api_key, 应该一击就中)
//        - mock-bad-key       (故意填错 api_key, 上游返 401, 触发自动禁用)
//        - mock-network-fail  (baseUrl 指向不存在的端口, 触发 retryable)
//   2. 跑多次 chat 请求, 看是否每次都最终成功 (即使中途有 channel 挂掉, 也能换到好 channel);
//   3. 跑 GET /admin/channels 看哪些 channel 已经 status=disabled;
//   4. 跑 POST /admin/channels/probe-now 看 health-checker 是否能恢复 (我们这里 bad-key 上游
//      仍然会回 401, 探活仍失败; network-fail 因为目标端口仍然不存在, 探活也失败).
//
// 测试目的不是「让所有 channel 都活下来」, 而是「网关在 channel 挂掉时仍然给客户端正常响应」.

import 'dotenv/config';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-12345';
const GW_KEY = process.env.GW_KEY ?? '';

async function adminGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  return (await resp.json()) as T;
}

async function adminPost<T>(path: string, body: unknown = {}): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as T;
}

async function chat(prompt: string, stream: boolean): Promise<{ ok: boolean; preview: string; status: number }> {
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GW_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 32,
      stream,
    }),
  });
  const text = await resp.text();
  return { ok: resp.ok, preview: text.slice(0, 200), status: resp.status };
}

async function main() {
  if (!GW_KEY) {
    console.error('Missing GW_KEY env. Run admin/keys signup first.');
    process.exit(2);
  }

  console.log('--- before: list channels ---');
  console.log(JSON.stringify(await adminGet('/admin/channels'), null, 2));

  for (let i = 0; i < 5; i++) {
    const r = await chat(`round ${i}`, false);
    console.log(`[non-stream #${i}] status=${r.status} ok=${r.ok} preview=${r.preview.slice(0, 80)}`);
  }

  for (let i = 0; i < 3; i++) {
    const r = await chat(`stream round ${i}`, true);
    console.log(`[stream #${i}] status=${r.status} ok=${r.ok} preview=${r.preview.slice(0, 80)}`);
  }

  console.log('--- after: list channels (disabled ones should be visible) ---');
  console.log(JSON.stringify(await adminGet('/admin/channels'), null, 2));

  console.log('--- probe-now ---');
  console.log(JSON.stringify(await adminPost('/admin/channels/probe-now'), null, 2));

  console.log('--- after probe: list channels ---');
  console.log(JSON.stringify(await adminGet('/admin/channels'), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
