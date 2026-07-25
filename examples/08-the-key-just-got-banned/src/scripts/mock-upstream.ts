// mock-upstream: 一个最小的 OpenAI Chat Completions 兼容 SSE 上游
//
// 用途:
//   1. 演示流式打字机效果 (10 个 chunk, 每个间隔 250ms, 末尾带 usage + [DONE]);
//   2. 验证反向取消: 客户端关闭连接时, mock 上游能感知到 (req 'close' 事件触发),
//      日志会打 'mock_aborted', 主进程可 grep 这一行确认 abort 信号真的传到了.
//
// 不依赖任何额外依赖, 用 Node 原生 http.
// 默认端口 4010, 与 src/index.ts 里 'mock-' prefix 注册的 baseURL 对齐.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });

const PORT = Number(process.env.MOCK_PORT ?? 4010);

// 10 段固定的「打字机」chunk 文本
const CHUNKS = [
  'Hello',
  ', world',
  '! This',
  ' is a',
  ' mock',
  ' streaming',
  ' response',
  ' from',
  ' the',
  ' upstream.',
];
const CHUNK_INTERVAL_MS = Number(process.env.MOCK_CHUNK_INTERVAL_MS ?? 250);

function sseLine(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

function makeChunk(model: string, id: string, content: string | null, finishReason: string | null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
}

async function handleStream(req: IncomingMessage, res: ServerResponse, body: string) {
  // v0.8: 模拟 Key 鉴权失败. Authorization Bearer 头里如果不是 'mock', 返 401.
  // 这让 channel-failover 验证 (admin 后台用 will-fail-401 这种 key 的 channel)
  // 能跑出真实的 401 路径, 触发自动禁用.
  const authHeader = req.headers['authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  if (token !== 'mock' && token !== '') {
    logger.warn({ token_preview: token.slice(0, 20) }, 'mock_rejected_invalid_key');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    );
    return;
  }

  let payload: {
    model?: string;
    max_tokens?: number;
    stream?: boolean;
    messages?: Array<{ content?: string }>;
  } = {};
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }
  const model = payload.model ?? 'mock-gpt-4o-mini';

  // 非流式: health-checker 的 ping 探针走这一条 (stream:false, max_tokens:1).
  // 直接回一个最简单的 chat.completion JSON, 200 + usage.
  if (payload.stream === false) {
    const id = `chatcmpl-mock-probe-${Date.now()}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    logger.info({ id, probe: true }, 'mock_probe_ok');
    return;
  }
  const id = `chatcmpl-mock-${Date.now()}`;
  // 简单的 prompt token 估计: prompt 文本长度 / 4
  const promptText = (payload.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join(' ');
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let aborted = false;
  // 关键: 在 Node http 里, 我们需要监听 RESPONSE 的 close 事件 (res.on('close'))
  // 表示「下游真的关连接了」. req.on('close') 在客户端 half-close 请求体后也会触发,
  // 误把正常的 POST 请求当成 abort.
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      logger.warn({ id }, 'mock_aborted_by_client');
    }
  });

  // 首块: role: 'assistant'
  res.write(
    sseLine({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
  );

  let completionChars = 0;
  for (let i = 0; i < CHUNKS.length; i++) {
    if (aborted) {
      logger.warn({ id, chunks_sent: i }, 'mock_stop_early_due_to_abort');
      return;
    }
    await new Promise<void>((r) => setTimeout(r, CHUNK_INTERVAL_MS));
    if (aborted) {
      logger.warn({ id, chunks_sent: i }, 'mock_stop_early_due_to_abort');
      return;
    }
    completionChars += CHUNKS[i]!.length;
    res.write(sseLine(makeChunk(model, id, CHUNKS[i]!, null)));
  }

  // finish_reason + usage (来自 stream_options.include_usage)
  res.write(sseLine(makeChunk(model, id, null, 'stop')));
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  res.write(
    sseLine({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
  logger.info({ id, completion_tokens: completionTokens, prompt_tokens: promptTokens }, 'mock_done');
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    handleStream(req, res, body).catch((err) => {
      logger.error({ err: (err as Error).message }, 'mock_handler_error');
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });
});

server.listen(PORT, () => {
  logger.info(`mock upstream listening on http://localhost:${PORT}`);
});
