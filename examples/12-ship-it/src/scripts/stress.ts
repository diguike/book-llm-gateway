// v1.0 短时压测: 用 autocannon 跑指定时长 + 并发, 输出基本吞吐.
//
// 这一项不追求高数字 (单机 + SQLite + better-sqlite3 同步写, 天花板就在 1-2k QPS),
// 主要目的是「证明 v1.0 能扛住 100 并发不挂」+「让读者有个感觉怎么压」.
//
// 真实生产压测建议跑:
//   - wrk2 with --rate 控制速率
//   - k6 with stages
//   - vegeta with -rate=100/s -duration=60s
// 这里选 autocannon 因为它是 Node 原生 + 不需要额外安装.
//
// 参考: https://github.com/mcollina/autocannon
//
// 默认 30 并发 × 10s. 通过 env 调:
//   STRESS_CONCURRENCY=100 STRESS_DURATION_S=30 npm run stress

import 'dotenv/config';
import { default as autocannon } from 'autocannon';

const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'admin-change-me';
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? 30);
const DURATION_S = Number(process.env.STRESS_DURATION_S ?? 10);

interface AdminOrg {
  id: number;
}
interface AdminUser {
  id: number;
}
interface AdminKey {
  plaintext: string;
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
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  // 准备一个有充足余额的 user + key 让 autocannon 一直能打过去.
  const org = await adminFetch<AdminOrg>('/admin/orgs', {
    method: 'POST',
    body: JSON.stringify({ name: `stress-${Date.now()}` }),
  });
  const user = await adminFetch<AdminUser>('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ orgId: org.id, name: 'stress-user', balanceCny: 10_000 }),
  });
  const key = await adminFetch<AdminKey>('/admin/keys', {
    method: 'POST',
    body: JSON.stringify({ userId: user.id, name: 'stress-key' }),
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      stage: 'setup',
      base: BASE,
      concurrency: CONCURRENCY,
      duration_s: DURATION_S,
      user_id: user.id,
    }),
  );

  // autocannon: 直接打 /v1/chat/completions, 后端走完整链路 (鉴权 + preConsume +
  // postConsume + observability), 不绕过任何中间件.
  const result = await autocannon({
    url: `${BASE}/v1/chat/completions`,
    method: 'POST',
    connections: CONCURRENCY,
    duration: DURATION_S,
    headers: {
      Authorization: `Bearer ${key.plaintext}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mock-gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
      stream: false,
    }),
  });

  const summary = {
    stage: 'result',
    duration_s: DURATION_S,
    concurrency: CONCURRENCY,
    requests: result.requests.total,
    rps_avg: result.requests.average,
    latency_p50_ms: result.latency.p50,
    latency_p99_ms: result.latency.p99,
    throughput_mb_s: (result.throughput.average / 1024 / 1024).toFixed(2),
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  if (result.errors > 0) {
    // eslint-disable-next-line no-console
    console.error('[stress] non-zero errors, fail');
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('stress FAILED:', err);
  process.exit(1);
});
