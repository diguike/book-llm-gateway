// Admin HTTP API: 创建 org / 创建 user / 签发 Key / 列 Key / 吊销 Key
//
// 所有路由都用 requireAdminToken() 保护, 调用方在 Authorization 上挂 ADMIN_TOKEN.
//
// 路由设计 (REST 风格, 但故意保持平铺, 避免读者一上来要理解嵌套资源):
//   POST   /admin/orgs                  创建 org
//   POST   /admin/users                 创建 user (body: { orgId, name, email? })
//   POST   /admin/keys                  签发 Key  (body: { userId, name, expiresInDays?, scopes? })
//   GET    /admin/keys?userId=          列 Key (脱敏, 不返回明文)
//   DELETE /admin/keys/:id              吊销 Key (软删: 写 disabled_at 不删行)
//
// 返回里出现 plaintext 字段只在 POST /admin/keys 一次, 之后任何接口都拿不到.

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { keys, orgs, users } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { requireAdminToken } from '../auth/middleware.js';

export function createAdminRouter(): Hono {
  const app = new Hono();
  app.use('*', requireAdminToken());

  // ----- orgs -----
  app.post('/orgs', async (c) => {
    const schema = z.object({ name: z.string().min(1).max(100) });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const now = Date.now();
    const rows = db.insert(orgs).values({ name: parsed.data.name, createdAt: now }).returning().all();
    return c.json(rows[0], 201);
  });

  // ----- users -----
  app.post('/users', async (c) => {
    const schema = z.object({
      orgId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      email: z.string().email().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    // 显式校验 org 存在, 避免 SQLite 外键报错信息晦涩
    const orgExists = db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, parsed.data.orgId)).all();
    if (orgExists.length === 0) {
      return c.json({ error: { message: `org ${parsed.data.orgId} not found` } }, 404);
    }
    const now = Date.now();
    const rows = db
      .insert(users)
      .values({
        orgId: parsed.data.orgId,
        name: parsed.data.name,
        email: parsed.data.email,
        createdAt: now,
      })
      .returning()
      .all();
    return c.json(rows[0], 201);
  });

  // ----- keys -----
  app.post('/keys', async (c) => {
    const schema = z.object({
      userId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      /** 过期天数; 不传 = 永不过期 */
      expiresInDays: z.number().int().positive().max(3650).optional(),
      /** 逗号分隔的 scope 列表; 留作后续章节扩展. 不传 = 'chat' */
      scopes: z.string().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const userExists = db.select({ id: users.id }).from(users).where(eq(users.id, parsed.data.userId)).all();
    if (userExists.length === 0) {
      return c.json({ error: { message: `user ${parsed.data.userId} not found` } }, 404);
    }

    const generated = generateKey();
    const now = Date.now();
    const expiresAt =
      parsed.data.expiresInDays !== undefined
        ? now + parsed.data.expiresInDays * 24 * 60 * 60 * 1000
        : null;

    const rows = db
      .insert(keys)
      .values({
        userId: parsed.data.userId,
        keyHash: generated.hash,
        keyPreview: generated.preview,
        name: parsed.data.name,
        scopes: parsed.data.scopes ?? 'chat',
        expiresAt,
        createdAt: now,
      })
      .returning()
      .all();

    // ★ 明文 Key 只在创建时返回一次, 之后任何接口都拿不到
    return c.json(
      {
        id: rows[0]!.id,
        plaintext: generated.plaintext,
        preview: generated.preview,
        name: rows[0]!.name,
        scopes: rows[0]!.scopes,
        expiresAt: rows[0]!.expiresAt,
        createdAt: rows[0]!.createdAt,
        warning: 'Save this plaintext now. It will never be shown again.',
      },
      201,
    );
  });

  app.get('/keys', async (c) => {
    const userIdRaw = c.req.query('userId');
    const userId = userIdRaw ? Number(userIdRaw) : undefined;
    const db = getDb();
    const query = db
      .select({
        id: keys.id,
        userId: keys.userId,
        preview: keys.keyPreview,
        name: keys.name,
        scopes: keys.scopes,
        expiresAt: keys.expiresAt,
        disabledAt: keys.disabledAt,
        lastUsedAt: keys.lastUsedAt,
        createdAt: keys.createdAt,
      })
      .from(keys);
    const rows = userId !== undefined ? query.where(eq(keys.userId, userId)).all() : query.all();
    return c.json({ data: rows });
  });

  app.delete('/keys/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { message: 'invalid id' } }, 400);
    }
    const db = getDb();
    const now = Date.now();
    // 即时吊销 = 写 disabled_at 时间戳, 不删行. 已写入的请求账单仍可按 key_id 反查.
    const updated = db
      .update(keys)
      .set({ disabledAt: now })
      .where(and(eq(keys.id, id)))
      .returning()
      .all();
    if (updated.length === 0) {
      return c.json({ error: { message: `key ${id} not found` } }, 404);
    }
    return c.json({ id, disabledAt: now });
  });

  return app;
}
