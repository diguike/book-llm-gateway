// 压测脚本: 在单 Key 上跑 N 个并发请求, 看 429 / 402 出现的位置.
//
// 设计意图: 用这个脚本直观验证「同一 Key 在限流配置下到底拦不拦得住失控客户端」.
// 不依赖 autocannon 的 GUI 输出, 自己用 native fetch + Promise.all 跑, 输出更可控.
//
// 用法:
//   node --import tsx src/scripts/attack.ts \
//        --base http://localhost:3000 \
//        --key sk-gw-XXXXXXXXXXXXXXXXXXX \
//        --model gpt-4o-mini \
//        --total 20 \
//        --concurrency 5
//
// 输出:
//   {"total":20,"by_status":{"200":2,"429":15,"402":3,"502":0},"first_429_at_index":2,
//    "elapsed_ms":1234, "rate_limit_headers":["1","1","1",...]}

import 'dotenv/config';

interface Args {
  base: string;
  key: string;
  model: string;
  total: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    base: 'http://localhost:3000',
    model: 'gpt-4o-mini',
    total: 20,
    concurrency: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--base':
        args.base = v;
        i++;
        break;
      case '--key':
        args.key = v;
        i++;
        break;
      case '--model':
        args.model = v;
        i++;
        break;
      case '--total':
        args.total = Number(v);
        i++;
        break;
      case '--concurrency':
        args.concurrency = Number(v);
        i++;
        break;
    }
  }
  if (!args.key) {
    args.key = process.env.GW_KEY ?? '';
  }
  if (!args.key) {
    throw new Error('Missing --key (or GW_KEY env var)');
  }
  return args as Args;
}

interface Result {
  index: number;
  status: number;
  retryAfter: string | null;
  body: unknown;
}

async function singleCall(args: Args, index: number): Promise<Result> {
  const resp = await fetch(`${args.base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: args.model,
      // 短 prompt 让本地估算稳定
      messages: [{ role: 'user', content: `ping ${index}` }],
      // 故意把 max_tokens 设小, 防止 TPM 预扣值把限流测试吃完;
      // 调大就能更快看到 TPM 限流
      max_tokens: 64,
    }),
  });
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = await resp.text();
  }
  return {
    index,
    status: resp.status,
    retryAfter: resp.headers.get('Retry-After'),
    body,
  };
}

async function runAttack(args: Args): Promise<void> {
  const start = Date.now();
  const results: Result[] = [];

  // 用「滑动并发池」: 维持 concurrency 个 in-flight, 完成一个补一个
  let nextIndex = 0;
  const inflight = new Set<Promise<void>>();

  while (nextIndex < args.total || inflight.size > 0) {
    while (inflight.size < args.concurrency && nextIndex < args.total) {
      const idx = nextIndex++;
      const p = singleCall(args, idx)
        .then((r) => {
          results.push(r);
        })
        .catch((err) => {
          results.push({
            index: idx,
            status: -1,
            retryAfter: null,
            body: { error: (err as Error).message },
          });
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    }
    if (inflight.size > 0) {
      await Promise.race(inflight);
    }
  }

  results.sort((a, b) => a.index - b.index);
  const byStatus = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const first429 = results.find((r) => r.status === 429);

  const summary = {
    total: args.total,
    concurrency: args.concurrency,
    by_status: byStatus,
    first_429_at_index: first429?.index ?? null,
    first_429_body: first429?.body,
    first_429_retry_after: first429?.retryAfter,
    elapsed_ms: Date.now() - start,
    sample_results: results.slice(0, 8).map((r) => ({
      i: r.index,
      status: r.status,
      retry_after: r.retryAfter,
      kind: (r.body as { error?: { type?: string } })?.error?.type,
    })),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

const args = parseArgs(process.argv.slice(2));
runAttack(args).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
