// Admin HTTP API
//
// v0.4 路由 (沿用):
//   POST   /admin/orgs                  创建 org
//   POST   /admin/users                 创建 user
//   POST   /admin/keys                  签发 Key
//   GET    /admin/keys?userId=          列 Key (脱敏 + v0.6 显示限流配置 / 月度配额)
//   DELETE /admin/keys/:id              吊销 Key
//
// v0.5 路由 (沿用):
//   POST   /admin/users/:id/balance     调整余额
//   POST   /admin/users/:id/multiplier  设置用户倍率
//   GET    /admin/prices                列出价格表
//   POST   /admin/prices                改价
//   GET    /admin/usage                 查账单
//
// v0.6 新增路由:
//   POST   /admin/keys/:id/limits       设置 Key 的限流 / 月度配额
//                                       body: { qpsLimit?, tpmLimit?, monthlyQuotaCny? }
//   GET    /admin/keys/:id/usage-window 查 Key 当前秒已用 QPS / 当前分钟 TPM / 当月余额
//
// 所有路由都用 requireAdminToken() 保护.

import { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/client.js';
import { keys, orgs, users, prices, usageRecords } from '../db/schema.js';
import { generateKey } from '../auth/key.js';
import { requireAdminToken } from '../auth/middleware.js';
import { invalidatePriceCache } from '../billing/prices.js';
import { getSharedLimiter } from '../limit/memory-limiter.js';

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
      // v0.6: 签 Key 时可以一并设置限流 + 月度配额, 减少二次 admin 调用
      qpsLimit: z.number().int().nonnegative().optional(),
      tpmLimit: z.number().int().nonnegative().optional(),
      monthlyQuotaCny: z.number().nonnegative().optional(),
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
        qpsLimit: parsed.data.qpsLimit ?? 0,
        tpmLimit: parsed.data.tpmLimit ?? 0,
        monthlyQuotaMicro:
          parsed.data.monthlyQuotaCny !== undefined
            ? Math.round(parsed.data.monthlyQuotaCny * 1_000_000)
            : 0,
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
        qpsLimit: rows[0]!.qpsLimit,
        tpmLimit: rows[0]!.tpmLimit,
        monthlyQuotaMicro: rows[0]!.monthlyQuotaMicro,
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
        // v0.6 新增: 限流 + 月度配额配置
        qpsLimit: keys.qpsLimit,
        tpmLimit: keys.tpmLimit,
        monthlyQuotaMicro: keys.monthlyQuotaMicro,
        monthlyUsedMicro: keys.monthlyUsedMicro,
        quotaResetAt: keys.quotaResetAt,
      })
      .from(keys);
    const rows = userId !== undefined ? query.where(eq(keys.userId, userId)).all() : query.all();
    return c.json({ data: rows });
  });

  // ============================================================
  // v0.6: 设置 Key 的限流 / 月度配额
  //   body: { qpsLimit?, tpmLimit?, monthlyQuotaCny? }
  //   0 = 不限制. 不传字段 = 不改这一项.
  // ============================================================
  app.post('/keys/:id/limits', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { message: 'invalid id' } }, 400);
    }
    const schema = z.object({
      qpsLimit: z.number().int().nonnegative().optional(),
      tpmLimit: z.number().int().nonnegative().optional(),
      monthlyQuotaCny: z.number().nonnegative().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: 'invalid_request', detail: parsed.error.format() } }, 400);
    }
    const db = getDb();
    const exists = db.select({ id: keys.id }).from(keys).where(eq(keys.id, id)).all();
    if (exists.length === 0) {
      return c.json({ error: { message: `key ${id} not found` } }, 404);
    }
    const updates: Record<string, number> = {};
    if (parsed.data.qpsLimit !== undefined) updates.qps_limit = parsed.data.qpsLimit;
    if (parsed.data.tpmLimit !== undefined) updates.tpm_limit = parsed.data.tpmLimit;
    if (parsed.data.monthlyQuotaCny !== undefined) {
      updates.monthly_quota_micro = Math.round(parsed.data.monthlyQuotaCny * 1_000_000);
    }
    if (Object.keys(updates).length === 0) {
      return c.json({ error: { message: 'no fields to update' } }, 400);
    }
    // Drizzle 写入用 schema 字段名 (camelCase)
    const setMap: Record<string, number> = {};
    if (parsed.data.qpsLimit !== undefined) setMap.qpsLimit = parsed.data.qpsLimit;
    if (parsed.data.tpmLimit !== undefined) setMap.tpmLimit = parsed.data.tpmLimit;
    if (parsed.data.monthlyQuotaCny !== undefined) {
      setMap.monthlyQuotaMicro = Math.round(parsed.data.monthlyQuotaCny * 1_000_000);
    }
    db.update(keys).set(setMap).where(eq(keys.id, id)).run();
    const after = db
      .select({
        id: keys.id,
        qpsLimit: keys.qpsLimit,
        tpmLimit: keys.tpmLimit,
        monthlyQuotaMicro: keys.monthlyQuotaMicro,
        monthlyUsedMicro: keys.monthlyUsedMicro,
      })
      .from(keys)
      .where(eq(keys.id, id))
      .all();
    return c.json(after[0]);
  });

  // ============================================================
  // v0.6: 查 Key 当前限流窗口状态
  //   - 当前秒已用 QPS (sliding-window 内存)
  //   - 当前分钟 TPM 累计 (内存)
  //   - 当月已用 / 上限 (DB)
  // ============================================================
  app.get('/keys/:id/usage-window', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { message: 'invalid id' } }, 400);
    }
    const db = getDb();
    const rows = db
      .select({
        qpsLimit: keys.qpsLimit,
        tpmLimit: keys.tpmLimit,
        monthlyQuotaMicro: keys.monthlyQuotaMicro,
        monthlyUsedMicro: keys.monthlyUsedMicro,
        quotaResetAt: keys.quotaResetAt,
      })
      .from(keys)
      .where(eq(keys.id, id))
      .all();
    if (rows.length === 0) {
      return c.json({ error: { message: `key ${id} not found` } }, 404);
    }
    const limiter = getSharedLimiter();
    const window = limiter.inspect(`key:${id}`);
    return c.json({
      keyId: id,
      qps: {
        limit: rows[0]!.qpsLimit,
        current: window?.qpsCount ?? 0,
      },
      tpm: {
        limit: rows[0]!.tpmLimit,
        currentTokens: window?.tpmTokens ?? 0,
      },
      monthly: {
        limitMicroCny: rows[0]!.monthlyQuotaMicro,
        usedMicroCny: rows[0]!.monthlyUsedMicro,
        limitCny: rows[0]!.monthlyQuotaMicro / 1_000_000,
        usedCny: rows[0]!.monthlyUsedMicro / 1_000_000,
        resetAt: rows[0]!.quotaResetAt,
      },
    });
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
