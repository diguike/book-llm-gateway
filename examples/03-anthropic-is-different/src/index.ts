// 第 3 章 v0.3: Anthropic 协议适配
//
// 相对 v0.2 的核心变化:
//   1. 新增 adaptors/anthropic.ts: OpenAI ↔ Anthropic 双向翻译
//   2. types/ir.ts 扩展: 增加可选的 system / toolResults 概念 (体现在 buildRequest 里)
//   3. streaming/anthropic-events.ts: 6 种事件归一化器, Ch7 SSE 主循环会复用
//   4. ModelRouter 注册 claude-* -> Anthropic
//   5. 新增 /v1/messages 旁路: Anthropic 原生协议直通 (Claude Code 等客户端可直接用)
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 无鉴权 (Ch4)
//   - 不计费、不限流、不可观测 (Ch5-9)
//   - SSE 流式透传仍未做, 显式拒绝 stream:true (Ch7)
//   - 多模态 (image / pdf) 转换不在本章 (后续章节)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { OpenAIAdaptor } from './adaptors/openai.js';
import { DeepSeekAdaptor } from './adaptors/deepseek.js';
import { AnthropicAdaptor } from './adaptors/anthropic.js';
import { ModelRouter } from './router.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// 装配路由表
const anthropicAdaptor = new AnthropicAdaptor({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? '2023-06-01',
});

const router = new ModelRouter([
  {
    prefix: 'deepseek-',
    adaptor: new DeepSeekAdaptor({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    }),
  },
  {
    prefix: 'claude-',
    adaptor: anthropicAdaptor,
  },
  {
    prefix: 'gpt-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o1-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
  {
    prefix: 'o3-',
    adaptor: new OpenAIAdaptor({
      name: 'openai',
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY ?? '',
    }),
  },
]);

const app = new Hono();

// ============================================================
// 主路径: 入站 OpenAI 协议 /v1/chat/completions
//   流程: 校验 IR -> 路由 -> adaptor 翻译 -> 上游 -> adaptor 归一化 -> 返回
//   claude-* 模型走 AnthropicAdaptor, 经过 OpenAI ↔ Anthropic 双向翻译.
// ============================================================
app.post('/v1/chat/completions', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  // 本章仍不支持 SSE 透传, 显式拒绝
  if (ir.stream) {
    return c.json(
      {
        error: {
          message:
            'streaming is not supported in v0.3; the event normalizer is ready in streaming/anthropic-events.ts and will be wired into SSE main loop in Ch7',
        },
      },
      400,
    );
  }

  const adaptor = router.resolve(ir.model);
  if (!adaptor) {
    return c.json(
      {
        error: {
          message: `no provider matched for model: ${ir.model}`,
          available: router.describe(),
        },
      },
      400,
    );
  }

  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    logger.error(
      { provider: adaptor.name, model: ir.model, err: (err as Error).message },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();

  logger.info(
    {
      provider: adaptor.name,
      model: ir.model,
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay',
  );

  if (!upstreamResp.ok) {
    // 非 2xx 透传上游原始错误体. AnthropicAdaptor 暂不做错误体归一化,
    // 让客户端能看到上游真实的 error.type (例如 overloaded_error / authentication_error).
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  return c.json(irResponse, 200);
});

// ============================================================
// 旁路: 入站 Anthropic 原生协议 /v1/messages
//   - 直接把请求转发给 Anthropic 上游 (本网关只做鉴权占位 + 日志归因)
//   - 适用客户端: Claude Code / Anthropic SDK / 任何写死 Messages 协议的程序
//   - 没有协议翻译, 只是把网关当反向代理用
// ============================================================
app.post('/v1/messages', async (c) => {
  const rawBody = await c.req.text();
  const baseURL = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );

  // 透传 anthropic-version 与 anthropic-beta, 客户端没传时用默认值
  const clientVersion =
    c.req.header('anthropic-version') ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const clientBeta = c.req.header('anthropic-beta');

  const headers: Record<string, string> = {
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': clientVersion,
    'Content-Type': 'application/json',
  };
  if (clientBeta) headers['anthropic-beta'] = clientBeta;

  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
  } catch (err) {
    logger.error(
      { route: '/v1/messages', err: (err as Error).message },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  // 本章不处理 Anthropic SSE 透传 (Ch7), 流式请求暂时拒绝
  // 通过请求体里的 stream:true 探测; 这里偷个懒, 只看一眼字符串
  if (rawBody.includes('"stream":true') || rawBody.includes('"stream" : true')) {
    return c.json(
      {
        error: {
          message:
            '/v1/messages streaming passthrough is not implemented in v0.3, will be added in Ch7',
        },
      },
      400,
    );
  }

  const respText = await upstreamResp.text();
  logger.info(
    {
      route: '/v1/messages',
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay_messages_passthrough',
  );

  return new Response(respText, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

// 健康检查
app.get('/healthz', (c) =>
  c.json({
    ok: true,
    version: 'v0.3',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)'],
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.3 listening on http://localhost:${port}`);
