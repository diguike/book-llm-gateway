// stream-test: 流式客户端 + 反向取消验证脚本
//
// 用法:
//   tsx src/scripts/stream-test.ts \
//     --base http://localhost:3000 \
//     --key sk-gw-XXX \
//     --model mock-gpt-4o-mini \
//     --abort-after-chunks 3       # 收到 3 个 chunk 后主动 close, 触发反向取消
//
// 验证三件事:
//   1. 流式打字机: stdout 每收到一个 delta 实时打印, 不卡 30 秒一次性吐;
//   2. 反向取消: --abort-after-chunks N 给 N (>0), 收完 N 个 delta 后 fetch.abort(),
//      网关把这次断流作为 abortedByClient 处理, 写 usage_record status=canceled, 已用
//      token 计费入账 (cost > 0);
//   3. 正常完成: --abort-after-chunks 0 (默认), 流到 [DONE] 自然结束, 写 status=finalized.

import process from 'node:process';

interface Args {
  base: string;
  key: string;
  model: string;
  prompt: string;
  abortAfterChunks: number;
  maxTokens: number;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, dflt?: string): string => {
    const i = argv.indexOf(`--${k}`);
    if (i < 0 || i + 1 >= argv.length) return dflt ?? '';
    return argv[i + 1]!;
  };
  return {
    base: get('base', 'http://localhost:3000'),
    key: get('key', ''),
    model: get('model', 'mock-gpt-4o-mini'),
    prompt: get('prompt', 'Tell me a story.'),
    abortAfterChunks: Number(get('abort-after-chunks', '0')),
    maxTokens: Number(get('max-tokens', '256')),
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.key) {
  console.error('missing --key sk-gw-...');
  process.exit(1);
}

const ctrl = new AbortController();
let chunkCount = 0;
let abortFired = false;

const startedAt = Date.now();

const resp = await fetch(`${args.base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${args.key}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify({
    model: args.model,
    messages: [{ role: 'user', content: args.prompt }],
    stream: true,
    max_tokens: args.maxTokens,
  }),
  signal: ctrl.signal,
});

console.log(`[stream-test] http status=${resp.status} content-type=${resp.headers.get('content-type')}`);

if (!resp.ok || !resp.body) {
  const text = await resp.text();
  console.error(`[stream-test] non-2xx response: ${text}`);
  process.exit(1);
}

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let firstDeltaAt = 0;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') {
          console.log('\n[stream-test] received [DONE]');
          process.exit(0);
        }
        chunkCount++;
        try {
          const obj = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; role?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const content = obj.choices?.[0]?.delta?.content;
          if (content) {
            if (firstDeltaAt === 0) {
              firstDeltaAt = Date.now();
              console.log(`[stream-test] first delta at +${firstDeltaAt - startedAt}ms`);
            }
            process.stdout.write(content);
          }
          if (obj.usage) {
            console.log(
              `\n[stream-test] upstream usage: prompt=${obj.usage.prompt_tokens} completion=${obj.usage.completion_tokens}`,
            );
          }
          if (obj.choices?.[0]?.finish_reason) {
            console.log(`\n[stream-test] finish_reason=${obj.choices[0].finish_reason}`);
          }
        } catch {
          /* ignore */
        }
      }
      if (
        args.abortAfterChunks > 0 &&
        chunkCount >= args.abortAfterChunks &&
        !abortFired
      ) {
        abortFired = true;
        console.log(`\n[stream-test] aborting after ${chunkCount} chunks (simulated Ctrl+C)`);
        ctrl.abort();
        process.exit(0);
      }
    }
  }
} catch (err) {
  if ((err as Error).name === 'AbortError') {
    console.log(`\n[stream-test] aborted locally after ${chunkCount} chunks`);
    process.exit(0);
  }
  throw err;
}
