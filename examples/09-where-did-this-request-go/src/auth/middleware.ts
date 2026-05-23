// Hono Bearer Token 鉴权 middleware
//
// 链路:
//   1. 取 Authorization header, 剥 "Bearer " 前缀 -> 拿到明文 Key;
//   2. 形态校验 (sk-gw- 前缀), 不符合直接 401;
//   3. 对明文算 sha256 -> 在 keys 表里按 keyHash 唯一索引查;
//   4. 校验 disabled_at / expires_at; 联查 user / org 的 disabled_at;
//   5. 异步刷新 lastUsedAt (不阻塞主请求);
//   6. 把 { keyId, userId, orgId, scopes } 注入 ctx, 供后续 handler 使用.
//
// 对应 one-api middleware/auth.go:91 (TokenAuth).
// 关键差异:
//   - one-api 把校验逻辑放在 model.ValidateUserToken (model 包), middleware 只做剥 header;
//     本书把校验也放 middleware 自己, 因为 ts/Hono 的 ctx 注入方式与 gin 不同;
//   - one-api 用明文 Key 查 DB, 本书用 sha256(明文) 查;
//   - one-api 通过 Redis 缓存 token, 本书 v0.4 不引入缓存
//     (better-sqlite3 同步查询本就 < 100us, 单机够用; Redis 缓存留到 Ch9 看板章节).

import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { keys, orgs, users } from '../db/schema.js';
import { hashKey, isWellFormedKey } from './key.js';

/** ctx.var 上的鉴权产物. 后续章节 (Ch5 计费 / Ch6 限流) 直接复用 */
export interface AuthContext {
  keyId: number;
  userId: number;
  orgId: number;
  scopes: string[];
}

/** Hono 的 ctx.set('auth', ...) / ctx.get('auth') 的类型声明 */
export type AuthVariables = { auth: AuthContext };

export const requireGatewayKey: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const plaintext = extractBearerToken(c);
  if (!plaintext) {
    return c.json({ error: { message: 'missing or malformed Authorization header' } }, 401);
  }
  if (!isWellFormedKey(plaintext)) {
    return c.json(
      { error: { message: 'key format invalid; expected prefix sk-gw-' } },
      401,
    );
  }

  const keyHash = hashKey(plaintext);
  const db = getDb();

  // 一次 join 拿到 key + user + org, 鉴权所需字段全在.
  const rows = db
    .select({
      keyId: keys.id,
      keyDisabledAt: keys.disabledAt,
      keyExpiresAt: keys.expiresAt,
      scopes: keys.scopes,
      userId: users.id,
      userDisabledAt: users.disabledAt,
      orgId: orgs.id,
      orgDisabledAt: orgs.disabledAt,
    })
    .from(keys)
    .innerJoin(users, eq(users.id, keys.userId))
    .innerJoin(orgs, eq(orgs.id, users.orgId))
    .where(eq(keys.keyHash, keyHash))
    .all();

  if (rows.length === 0) {
    return c.json({ error: { message: 'invalid key' } }, 401);
  }
  const row = rows[0]!;
  const now = Date.now();

  if (row.keyDisabledAt !== null) {
    return c.json({ error: { message: 'key has been revoked' } }, 401);
  }
  if (row.keyExpiresAt !== null && row.keyExpiresAt <= now) {
    return c.json({ error: { message: 'key has expired' } }, 401);
  }
  if (row.userDisabledAt !== null) {
    return c.json({ error: { message: 'user is disabled' } }, 403);
  }
  if (row.orgDisabledAt !== null) {
    return c.json({ error: { message: 'org is disabled' } }, 403);
  }

  // 异步刷新 lastUsedAt, 不阻塞主请求.
  // 这里直接同步写也行 (better-sqlite3 是同步的), 但写操作会拿锁,
  // 高并发下连续写 lastUsedAt 会拖慢鉴权 P99. 用 setImmediate 让出 tick.
  setImmediate(() => {
    try {
      db.update(keys).set({ lastUsedAt: now }).where(eq(keys.id, row.keyId)).run();
    } catch {
      // 鉴权已通过, lastUsedAt 写失败不影响主流程, 静默吞掉.
    }
  });

  const auth: AuthContext = {
    keyId: row.keyId,
    userId: row.userId,
    orgId: row.orgId,
    scopes: parseScopes(row.scopes),
  };
  c.set('auth', auth);
  await next();
};

/**
 * 管理接口 (admin API) 用的简单 master token 校验.
 * 设计意图: 主令牌只签发新 Key, 不参与 LLM 调用; 单独一把环境变量保护.
 * 生产环境应换成短期 access token + 后台登录, 本章不展开.
 */
export function requireAdminToken(): MiddlewareHandler {
  return async (c, next) => {
    const required = process.env.ADMIN_TOKEN ?? '';
    if (!required) {
      return c.json(
        { error: { message: 'ADMIN_TOKEN env var is not configured on server' } },
        500,
      );
    }
    const provided = extractBearerToken(c);
    if (!provided) {
      return c.json({ error: { message: 'missing Authorization header' } }, 401);
    }
    // 用常量时间比对, 防御时序侧信道. 主令牌是低熵字符串, 必须这样做.
    const { constantTimeEqual } = await import('./key.js');
    if (!constantTimeEqual(provided, required)) {
      return c.json({ error: { message: 'invalid admin token' } }, 401);
    }
    await next();
  };
}

function extractBearerToken(c: Context): string | null {
  const auth = c.req.header('Authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1]!.trim() : null;
}

function parseScopes(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
