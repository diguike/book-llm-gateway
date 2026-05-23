// prompt-cache-demo
//
// 完全独立的零依赖 demo. 起一个内嵌的 Anthropic-style mock 上游, 然后:
//   1. 第一次发请求 (冷调) -> 上游返回 cache_creation_input_tokens, 走标准价 + 写入溢价;
//   2. 第二次发请求 (同 prefix) -> 上游返回 cache_read_input_tokens, 享 0.1x 折扣;
//   3. 对比两次请求的 token 与成本.
//
// 同时演示 OpenAI-style 自动 prefix 缓存 (≥1024 token):
//   - 准备一个 1500 字符的长 system prompt;
//   - 第一次冷调 cached_tokens=0;
//   - 第二次相同 prompt cached_tokens 占多数 -> 0.5x 折扣.
//
// 引用:
//   - Anthropic Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   - OpenAI Prompt Caching:    https://openai.com/index/api-prompt-caching/
//   - DeepSeek Context Caching: https://api-docs.deepseek.com/news/news0802

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 14080);

// ============================================================
// Mock 上游: 实现两套缓存语义
// ============================================================
//
// /anthropic/v1/messages : 显式 cache_control. 第一次写入, 后续读取.
// /openai/v1/chat/completions : 自动 prefix. 内存里按 message 内容 hash 存命中状态.

interface CacheEntry {
  prefix: string;
  expiresAt: number;
}

const ANTHROPIC_CACHE: Map<string, CacheEntry> = new Map();
const OPENAI_CACHE: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function digest(input: string): string {
  // 简单 hash, 不引依赖
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return String(h);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function handleAnthropic(req: IncomingMessage, res: ServerResponse, body: string): void {
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }

  // Anthropic: messages 数组里某些 block 带 cache_control 标记. 我们查找有 cache_control 的 block,
  // 拿其内容做 cache key. 第一次见到 -> 写入; 第二次见到 -> 读取.
  let cacheRead = 0;
  let cacheWrite = 0;
  let normalInput = 0;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = typeof payload.system === 'string' ? payload.system : '';

  // system 文本走 normal input
  normalInput += approxTokens(system);

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      normalInput += approxTokens(msg.content);
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const text = typeof block.text === 'string' ? block.text : '';
        const tokens = approxTokens(text);
        if (block.cache_control) {
          const key = digest(text);
          const now = Date.now();
          const entry = ANTHROPIC_CACHE.get(key);
          if (entry && entry.expiresAt > now) {
            cacheRead += tokens;
          } else {
            cacheWrite += tokens;
            ANTHROPIC_CACHE.set(key, { prefix: text.slice(0, 64), expiresAt: now + CACHE_TTL_MS });
          }
        } else {
          normalInput += tokens;
        }
      }
    }
  }

  const responseText = 'Mock Anthropic response.';
  const completionTokens = approxTokens(responseText);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `msg_mock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
      model: payload.model ?? 'claude-3-5-sonnet-mock',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: normalInput,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: completionTokens,
      },
    }),
  );
}

function handleOpenAI(req: IncomingMessage, res: ServerResponse, body: string): void {
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  // OpenAI 自动缓存: 把 system + 第一条 user 消息的字面拼起来当 prefix, 取前 1024 字符做 hash.
  const fullPrompt = messages
    .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const promptTokens = approxTokens(fullPrompt);

  // 只有 ≥ 1024 token 才进缓存系统
  let cachedTokens = 0;
  if (promptTokens >= 1024 / 4) {
    // 简化阈值: 1024 token ≈ 256 char (放宽以让 demo 容易触发)
    const prefix = fullPrompt.slice(0, 256);
    const key = digest(prefix);
    const now = Date.now();
    const entry = OPENAI_CACHE.get(key);
    if (entry && entry.expiresAt > now) {
      // 命中: cached_tokens = 全 prefix 的 token 数
      cachedTokens = approxTokens(prefix);
    } else {
      OPENAI_CACHE.set(key, { prefix: prefix.slice(0, 64), expiresAt: now + CACHE_TTL_MS });
    }
  }

  const responseText = 'Mock OpenAI response.';
  const completionTokens = approxTokens(responseText);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model ?? 'gpt-4o-mini-mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
    }),
  );
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === '/anthropic/v1/messages' && req.method === 'POST') {
    handleAnthropic(req, res, body);
  } else if (req.url === '/openai/v1/chat/completions' && req.method === 'POST') {
    handleOpenAI(req, res, body);
  } else {
    res.writeHead(404).end();
  }
});

// ============================================================
// 价格表 (元 / 1M tokens, 与主项目默认表对齐)
// ============================================================
const PRICING = {
  anthropic: {
    input: 21.6,
    cacheRead: 2.16, // 0.1x
    cacheWrite: 27.0, // 1.25x (5min cache)
    output: 108,
  },
  openai: {
    input: 1.05,
    cacheRead: 0.525, // 0.5x
    cacheWrite: 1.05, // OpenAI 没有写入溢价
    output: 4.32,
  },
};

interface BillingResult {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

function billAnthropic(usage: any): BillingResult {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cost = Math.ceil(
    (input * PRICING.anthropic.input +
      cacheRead * PRICING.anthropic.cacheRead +
      cacheWrite * PRICING.anthropic.cacheWrite +
      output * PRICING.anthropic.output) /
      1, // 已经是 元 / 1M tokens, 这里直接乘 token 后单位是 微元 × 1e6 / 1e6 = 微元
  );
  return {
    promptTokens: input + cacheRead + cacheWrite,
    completionTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cost,
  };
}

function billOpenAI(usage: any): BillingResult {
  const promptTokens = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const normal = Math.max(0, promptTokens - cached);
  const cost = Math.ceil(
    normal * PRICING.openai.input + cached * PRICING.openai.cacheRead + output * PRICING.openai.output,
  );
  return {
    promptTokens,
    completionTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    cost,
  };
}

function fmt(b: BillingResult): string {
  return `prompt=${b.promptTokens} (cached_read=${b.cacheReadTokens} cached_write=${b.cacheWriteTokens}) completion=${b.completionTokens} cost=${b.cost} 微元`;
}

function header(title: string) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

async function runAnthropicDemo() {
  header('Anthropic 显式 cache_control 演示 (cache_read = 0.1x input)');
  // 一段 200 字符左右的 system prompt 标记 cache_control
  const longSystem =
    'You are a helpful coding assistant. Always respond in markdown with concise code blocks. ' +
    'Always show file paths in backticks. Always match the existing style of the codebase. ' +
    'If you are not sure about something, ask before assuming.';

  const requestBody = {
    model: 'claude-3-5-sonnet-mock',
    max_tokens: 64,
    system: 'short system header',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: longSystem,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'now answer: what is 2+2?' },
        ],
      },
    ],
  };

  // 第一次冷调
  const r1 = await fetch(`http://localhost:${PORT}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const u1 = (await r1.json()).usage;
  const b1 = billAnthropic(u1);
  console.log(`第 1 次 (冷调): ${fmt(b1)}`);

  // 第二次同 cache_control 内容
  const r2 = await fetch(`http://localhost:${PORT}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const u2 = (await r2.json()).usage;
  const b2 = billAnthropic(u2);
  console.log(`第 2 次 (命中): ${fmt(b2)}`);

  const saved = b1.cost - b2.cost;
  const savedPct = ((saved / b1.cost) * 100).toFixed(1);
  console.log(`\n→ 第 2 次比第 1 次节省 ${saved} 微元 (${savedPct}%).`);
}

async function runOpenAIDemo() {
  header('OpenAI 自动 prefix 缓存演示 (cached_tokens = 0.5x input)');
  // 1024 字符左右的长 prompt
  const longPrompt = 'You are a senior backend engineer. '.repeat(40);

  const requestBody = {
    model: 'gpt-4o-mini-mock',
    max_tokens: 64,
    messages: [
      { role: 'system', content: longPrompt },
      { role: 'user', content: 'what is the capital of France?' },
    ],
  };

  const r1 = await fetch(`http://localhost:${PORT}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const u1 = (await r1.json()).usage;
  const b1 = billOpenAI(u1);
  console.log(`第 1 次 (冷调): ${fmt(b1)}`);

  const r2 = await fetch(`http://localhost:${PORT}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const u2 = (await r2.json()).usage;
  const b2 = billOpenAI(u2);
  console.log(`第 2 次 (命中): ${fmt(b2)}`);

  const saved = b1.cost - b2.cost;
  const savedPct = b1.cost > 0 ? ((saved / b1.cost) * 100).toFixed(1) : '0';
  console.log(`\n→ 第 2 次比第 1 次节省 ${saved} 微元 (${savedPct}%).`);

  // 演示「破坏 prefix」的反例: 在 prompt 前加 trace_id
  console.log('\n反例: 在 prompt 前面加 trace_id (网关层错误做法), 缓存命中归零');
  const broken = {
    ...requestBody,
    messages: [
      { role: 'system', content: `trace_id: ${Math.random()}\n${longPrompt}` },
      requestBody.messages[1],
    ],
  };
  const r3 = await fetch(`http://localhost:${PORT}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(broken),
  });
  const u3 = (await r3.json()).usage;
  const b3 = billOpenAI(u3);
  console.log(`破坏 prefix 后: ${fmt(b3)}`);
}

server.listen(PORT, async () => {
  console.log(`mock prompt-cache 上游 listening on http://localhost:${PORT}`);
  try {
    await runAnthropicDemo();
    await runOpenAIDemo();
  } finally {
    server.close();
    console.log('\n--- demo 结束 ---');
  }
});
