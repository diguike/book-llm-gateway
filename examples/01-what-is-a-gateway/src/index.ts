// 第 1 章 v0.1: 30 行 Hono 透传
// 故意暴露的缺陷:
//   1. 上游 Key 写死在环境变量, 客户端共享同一把 Key (第 4 章解决)
//   2. 只能对接单一上游, 无法按 model 字段路由 (第 2 章解决)
//   3. 无鉴权, 任何拿到地址的客户端都能消耗上游额度 (第 4 章解决)
//   4. 不计费、不限流、不可观测 (第 5-9 章解决)
//   5. 不支持流式响应 (第 7 章重写)
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import pino from 'pino';
import 'dotenv/config';

const logger = pino({ transport: { target: 'pino-pretty' } });
const app = new Hono();

// 入参校验: messages 与 model 必填, 其余字段透传
const ChatCompletionSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(z.object({ role: z.string(), content: z.any() }))
      .min(1),
  })
  .passthrough();

app.post('/v1/chat/completions', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.format() }, 400);
  }

  const upstream = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
  const start = Date.now();
  const resp = await fetch(`${upstream}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parsed.data),
  });

  // 结构化访问日志: 后续章节会扩展为 trace_id 全链路
  logger.info(
    {
      model: parsed.data.model,
      status: resp.status,
      latency_ms: Date.now() - start,
    },
    'relay',
  );

  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

// 健康检查接口, 方便后续章节做容器化探活
app.get('/healthz', (c) => c.json({ ok: true, version: 'v0.1' }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.1 listening on http://localhost:${port}`);
