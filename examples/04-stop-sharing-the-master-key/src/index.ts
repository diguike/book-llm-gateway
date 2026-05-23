// 第 4 章 v0.4: 内部 Key 体系 + 持久层首次引入
//
// 相对 v0.3 的核心变化:
//   1. 启动时自动跑 drizzle/ 下的 migration, 建出 orgs / users / keys 三张表;
//   2. /v1/chat/completions 与 /v1/messages 主路径都套上 requireGatewayKey middleware;
//   3. 新增 /admin/* 一组管理接口, 受 ADMIN_TOKEN 保护, 用于创建 user / 签发 Key / 吊销 Key;
//   4. 新增 src/cli/issue-key.ts 命令行工具, 服务器初始化时方便签出第一把 Key.
//
// 内外两套 Key 体系明确分开:
//   - 外部 Key (上游 Key): OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY,
//     仍然走环境变量; 网关侧使用, 对应上游账号;
//     未来 Ch8 把它迁到 channels 表, 但生命周期仍由网关运维管.
//   - 内部 Key (下游 Key): sk-gw-... , 存 DB; 客户端使用, 对应网关用户.
//
// 仍然故意暴露的缺陷 (留给后续章节):
//   - 不计费, 不知道每把 Key 消耗了多少钱 (Ch5)
//   - 不限流, 单把 Key 可以打爆上游配额 (Ch6)
//   - 流式仍未做 (Ch7), 旁路与主路径都拒绝 stream:true
//   - 渠道池, 故障转移 (Ch8)
//   - 结构化日志, 看板 (Ch9)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pino from 'pino';
import 'dotenv/config';

import { IRChatRequestSchema } from './types/ir.js';
import { OpenAIAdaptor } from './adaptors/openai.js';
import { DeepSeekAdaptor } from './adaptors/deepseek.js';
import { AnthropicAdaptor } from './adaptors/anthropic.js';
import { ModelRouter } from './router.js';
import { runMigrations } from './db/migrate.js';
import { requireGatewayKey, type AuthVariables } from './auth/middleware.js';
import { createAdminRouter } from './admin/routes.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

// ============================================================
// 启动前: 跑 migration. 数据库结构必须先就位, 中间件才有表可查.
// ============================================================
const migrationResult = runMigrations();
if (migrationResult.applied.length > 0) {
  logger.info({ applied: migrationResult.applied }, 'db_migrations_applied');
}

// ============================================================
// 装配上游 adaptor (与 v0.3 一致, 上游 Key 仍走环境变量)
// ============================================================
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

const app = new Hono<{ Variables: AuthVariables }>();

// ============================================================
// admin 接口: 创建 org / user / 签发 Key / 列 Key / 吊销 Key
//   受 ADMIN_TOKEN 保护; 详见 src/admin/routes.ts.
// ============================================================
app.route('/admin', createAdminRouter());

// ============================================================
// 主路径: /v1/chat/completions (入站 OpenAI 协议)
//   * 本章新增: 套 requireGatewayKey middleware *
//   流程: 鉴权 -> 校验 IR -> 路由 -> adaptor 翻译 -> 上游 -> adaptor 归一化 -> 返回
// ============================================================
app.post('/v1/chat/completions', requireGatewayKey, async (c) => {
  const auth = c.get('auth');

  const raw = await c.req.json().catch(() => null);
  const parsed = IRChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
  }
  const ir = parsed.data;

  if (ir.stream) {
    return c.json(
      {
        error: {
          message: 'streaming is not supported in v0.4; will be added in Ch7',
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
      {
        key_id: auth.keyId,
        user_id: auth.userId,
        provider: adaptor.name,
        model: ir.model,
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const rawBody = await upstreamResp.text();

  logger.info(
    {
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
      provider: adaptor.name,
      model: ir.model,
      status: upstreamResp.status,
      latency_ms: Date.now() - start,
    },
    'relay',
  );

  if (!upstreamResp.ok) {
    return new Response(rawBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const irResponse = await adaptor.parseResponse(upstreamResp, rawBody);
  return c.json(irResponse, 200);
});

// ============================================================
// 旁路: /v1/messages (Anthropic 原生协议直通)
//   也要套鉴权, 不允许绕过. Ch3 末尾埋的
//   「对外暴露的每个 endpoint 都走同一套鉴权」原则在本章兑现.
// ============================================================
app.post('/v1/messages', requireGatewayKey, async (c) => {
  const auth = c.get('auth');
  const rawBody = await c.req.text();
  const baseURL = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );

  const clientVersion =
    c.req.header('anthropic-version') ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const clientBeta = c.req.header('anthropic-beta');

  const headers: Record<string, string> = {
    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': clientVersion,
    'Content-Type': 'application/json',
  };
  if (clientBeta) headers['anthropic-beta'] = clientBeta;

  if (rawBody.includes('"stream":true') || rawBody.includes('"stream" : true')) {
    return c.json(
      {
        error: {
          message:
            '/v1/messages streaming passthrough is not implemented in v0.4, will be added in Ch7',
        },
      },
      400,
    );
  }

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
      {
        key_id: auth.keyId,
        user_id: auth.userId,
        route: '/v1/messages',
        err: (err as Error).message,
      },
      'upstream_network_error',
    );
    return c.json({ error: { message: 'upstream network error' } }, 502);
  }

  const respText = await upstreamResp.text();
  logger.info(
    {
      key_id: auth.keyId,
      user_id: auth.userId,
      org_id: auth.orgId,
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

// 健康检查 (不鉴权, 方便外部探活)
app.get('/healthz', (c) =>
  c.json({
    ok: true,
    version: 'v0.4',
    routes: router.describe(),
    extra_endpoints: ['/v1/messages (Anthropic passthrough)', '/admin/* (admin API)'],
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
logger.info(`Gateway v0.4 listening on http://localhost:${port}`);
