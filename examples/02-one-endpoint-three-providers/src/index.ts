// 第 2 章 v0.2: 一个入口, 多家上游
//
// 相对 v0.1 的核心变化:
//   1. 抽出 ProviderAdaptor 接口 (adaptors/base.ts), 把上游差异收口
//   2. 抽出 IR 类型 (types/ir.ts), 选 OpenAI 兼容协议作为底层 IR
//   3. 实现 OpenAIAdaptor + DeepSeekAdaptor (后者继承前者)
//   4. 引入 ModelRouter, 按 model 前缀路由到对应 adaptor
//   5. 日志加 provider 字段, 后续 Ch9 升级为 trace_id 全链路
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 无鉴权 (Ch4)
//   - 不计费、不限流、不可观测 (Ch5-9)
//   - 不支持流式 (Ch7)
//   - Adaptor 抽象只在 OpenAI 兼容族内验证过, 异构协议 (Anthropic) 留给 Ch3

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { OpenAIAdaptor } from './adaptors/openai.js';
import { DeepSeekAdaptor } from './adaptors/deepseek.js';
import { ModelRouter } from './router.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// 装配路由表: 上游配置从环境变量加载
const router = new ModelRouter([
  {
    prefix: 'deepseek-',
    adaptor: new DeepSeekAdaptor({
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    }),
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

app.post('/v1/chat/completions', async (c) => {
  // 1) 入参校验
  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  // v0.2 暂不支持流式, 显式拒绝, 避免上游真的返回 SSE 把客户端搞迷糊
  if (ir.stream) {
    return c.json(
      { error: { message: 'streaming is not supported in v0.2, will be added in Ch7' } },
      400,
    );
  }

  // 2) 按 model 字段路由
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

  // 3) 构造上游请求
  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildRequest(ir);

  // 4) 转发并归一化响应
  const start = Date.now();
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    // 网络层错误 (DNS / TCP / TLS / 超时), 与上游业务错误区分
    logger.error(
      { provider: adaptor.name, model: ir.model, err: (err as Error).message },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();

  // 5) 结构化日志, provider 字段是本章新增, 后续 Ch9 加 trace_id / channel_id
  logger.info(
    {
      provider: adaptor.name,
      model: ir.model,
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay',
  );

  // 上游返回 2xx 才走 parseResponse 归一化
  // 非 2xx 直接透传原始错误体, 保持客户端能看到上游的 error code
  if (!upstreamResp.ok) {
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  return c.json(irResponse, 200);
});

// 健康检查, 顺便暴露已注册的路由表方便调试
app.get('/healthz', (c) =>
  c.json({ ok: true, version: 'v0.2', routes: router.describe() }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.2 listening on http://localhost:${port}`);
