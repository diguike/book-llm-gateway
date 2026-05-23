// Admin HTTP API: 创建 org / 创建 user / 签发 Key / 列 Key / 吊销 Key
//                 + v0.5 新增: 调整余额 / 调整用户倍率 / 查看价格表 / 改价 / 查账单
//
// 所有路由都用 requireAdminToken() 保护, 调用方在 Authorization 上挂 ADMIN_TOKEN.
//
// v0.4 路由:
//   POST   /admin/orgs                  创建 org
//   POST   /admin/users                 创建 user (本章新增: 可选 balanceCny / userMultiplier)
//   POST   /admin/keys                  签发 Key
//   GET    /admin/keys?userId=          列 Key (脱敏)
//   DELETE /admin/keys/:id              吊销 Key
//
// v0.5 新增路由:
//   POST   /admin/users/:id/balance     调整余额 (body: { deltaCny } 或 { setCny })
//   POST   /admin/users/:id/multiplier  设置用户倍率 (body: { multiplier: 0.0-10.0 })
//   GET    /admin/prices                列出价格表
//   POST   /admin/prices                新增 / 改价 (老行 effective_to 自动闭合)
//   GET    /admin/usage                 查账单 (query: userId / keyId / traceId / limit)

import { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { keys, orgs, users, prices, usageRecords } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { requireAdminToken } from '../auth/middleware.js';
import { invalidatePriceCache } from '../billing/prices.js';

export function createAdminRouter(): Hono {
  const app = new Hono();
  app.use('*', requireAdminToken());

  const INITIAL_BALANCE_CNY = Number(process.env.INITIAL_BALANCE_CNY ?? 100);

  // ============================================================
  // orgs
  // ============================================================
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

  // ============================================================
  // users
  // ============================================================
  app.post('/users', async (c) => {
    const schema = z.object({
      orgId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      email: z.string().email().optional(),
      /** 可选, 不传走 INITIAL_BALANCE_CNY 兜底 */
      balanceCny: z.number().nonnegative().optional(),
      /** 可选, 不传走 1.0x */
      userMultiplier: z.number().positive().max(10).optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const orgExists = db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, parsed.data.orgId)).all();
    if (orgExists.length === 0) {
      return c.json({ error: { message: `org ${parsed.data.orgId} not found` } }, 404);
    }
    const now = Date.now();
    const balanceMicro = Math.round((parsed.data.balanceCny ?? INITIAL_BALANCE_CNY) * 1_000_000);
    const userMul = Math.round((parsed.data.userMultiplier ?? 1.0) * 1000);
    const rows = db
      .insert(users)
      .values({
        orgId: parsed.data.orgId,
        name: parsed.data.name,
        email: parsed.data.email,
        balanceMicro,
        userMultiplier: userMul,
        createdAt: now,
      })
      .returning()
      .all();
    return c.json(rows[0], 201);
  });

  // ============================================================
  // users - 调整余额
  //   支持 deltaCny (加减) 或 setCny (直接设)
  // ============================================================
  app.post('/users/:id/balance', async (c) => {
    const id = Number(c.req.param('id'));
    const schema = z.object({
      deltaCny: z.number().optional(),
      setCny: z.number().nonnegative().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (parsed.data.deltaCny === undefined && parsed.data.setCny === undefined)) {
      return c.json({ error: { message: 'must specify deltaCny or setCny' } }, 400);
    }
    const db = getDb();
    if (parsed.data.setCny !== undefined) {
      const setMicro = Math.round(parsed.data.setCny * 1_000_000);
      db.update(users).set({ balanceMicro: setMicro }).where(eq(users.id, id)).run();
    } else {
      const deltaMicro = Math.round(parsed.data.deltaCny! * 1_000_000);
      db.update(users)
        .set({ balanceMicro: sql`${users.balanceMicro} + ${deltaMicro}` })
        .where(eq(users.id, id))
        .run();
    }
    const after = db.select({ b: users.balanceMicro }).from(users).where(eq(users.id, id)).all();
    if (after.length === 0) {
      return c.json({ error: { message: `user ${id} not found` } }, 404);
    }
    return c.json({ userId: id, balanceMicro: after[0]!.b, balanceCny: after[0]!.b / 1_000_000 });
  });

  // ============================================================
  // users - 设置用户倍率
  // ============================================================
  app.post('/users/:id/multiplier', async (c) => {
    const id = Number(c.req.param('id'));
    const schema = z.object({ multiplier: z.number().positive().max(10) });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const mul = Math.round(parsed.data.multiplier * 1000);
    const updated = db
      .update(users)
      .set({ userMultiplier: mul })
      .where(eq(users.id, id))
      .returning({ id: users.id, userMultiplier: users.userMultiplier })
      .all();
    if (updated.length === 0) {
      return c.json({ error: { message: `user ${id} not found` } }, 404);
    }
    return c.json({ userId: id, multiplier: updated[0]!.userMultiplier / 1000 });
  });

  // ============================================================
  // keys (与 v0.4 一致)
  // ============================================================
  app.post('/keys', async (c) => {
    const schema = z.object({
      userId: z.number().int().positive(),
      name: z.string().min(1).max(100),
      expiresInDays: z.number().int().positive().max(3650).optional(),
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

  // ============================================================
  // prices: 列 / 新增 (调价)
  // ============================================================
  app.get('/prices', async (c) => {
    const db = getDb();
    const rows = db.select().from(prices).orderBy(desc(prices.effectiveFrom)).limit(500).all();
    return c.json({ data: rows });
  });

  app.post('/prices', async (c) => {
    const schema = z.object({
      model: z.string().min(1),
      provider: z.string().min(1),
      inputCnyPer1M: z.number().nonnegative(),
      outputCnyPer1M: z.number().nonnegative(),
      modelMultiplier: z.number().positive().max(10).optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const now = Date.now();
    // 把同 (model, provider) 仍在有效期的老行 effective_to 闭合掉
    db.update(prices)
      .set({ effectiveTo: now })
      .where(
        and(
          eq(prices.model, parsed.data.model),
          eq(prices.provider, parsed.data.provider),
          sql`${prices.effectiveTo} IS NULL`,
        ),
      )
      .run();
    const rows = db
      .insert(prices)
      .values({
        model: parsed.data.model,
        provider: parsed.data.provider,
        inputPriceMicroPer1M: Math.round(parsed.data.inputCnyPer1M * 1_000_000),
        outputPriceMicroPer1M: Math.round(parsed.data.outputCnyPer1M * 1_000_000),
        modelMultiplier: Math.round((parsed.data.modelMultiplier ?? 1.0) * 1000),
        effectiveFrom: now,
        effectiveTo: null,
        createdAt: now,
      })
      .returning()
      .all();
    invalidatePriceCache();
    return c.json(rows[0], 201);
  });

  // ============================================================
  // usage 查询
  //   query 参数: userId / keyId / traceId / limit (默认 50)
  //   不带任何过滤条件时返回最近 50 条
  // ============================================================
  app.get('/usage', async (c) => {
    const db = getDb();
    const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;
    const keyId = c.req.query('keyId') ? Number(c.req.query('keyId')) : undefined;
    const traceId = c.req.query('traceId');
    const limit = c.req.query('limit') ? Math.min(Number(c.req.query('limit')), 500) : 50;

    const q = db.select().from(usageRecords);
    let rows;
    if (traceId) {
      rows = q.where(eq(usageRecords.traceId, traceId)).all();
    } else if (keyId !== undefined) {
      rows = q
        .where(eq(usageRecords.keyId, keyId))
        .orderBy(desc(usageRecords.createdAt))
        .limit(limit)
        .all();
    } else if (userId !== undefined) {
      rows = q
        .where(eq(usageRecords.userId, userId))
        .orderBy(desc(usageRecords.createdAt))
        .limit(limit)
        .all();
    } else {
      rows = q.orderBy(desc(usageRecords.createdAt)).limit(limit).all();
    }
    return c.json({ data: rows });
  });

  return app;
}
