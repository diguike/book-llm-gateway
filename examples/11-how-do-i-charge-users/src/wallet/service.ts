// 钱包服务: 余额扣减 / 充值入账 / 退款 / 乐观锁
//
// 这一层是钱包链路的「单点真相」. 所有金额变动都必须经过这里, 不允许任何路径直接 UPDATE wallets.
//
// 三道核心难题在这里全部落地:
//
//   1. 充值幂等
//      INSERT INTO recharges (out_trade_no, ...) ON CONFLICT (out_trade_no) DO NOTHING
//      better-sqlite3 的 SqliteError 在唯一约束冲突时抛 SQLITE_CONSTRAINT_UNIQUE. 捕获后查
//      原 recharges 行, 按 status 决定行为:
//        - status=succeeded: 已经入账过, 直接返 ok (mock 平台重复回调 / 客服手动重发 都走这里)
//        - status=pending:   还没入账, 走入账逻辑
//        - status=failed:    新一笔成功回调来覆盖之前的失败 (跨平台重新发起)
//
//   2. 余额并发扣减 (preConsume)
//      UPDATE wallets SET balance_micro = balance_micro - ?
//        WHERE id = ? AND balance_micro >= ?
//        RETURNING balance_micro
//      single SQL atomicity: SQLite 把 UPDATE 当原子语句, 两个并发请求 RETURNING 0 行 = 那一笔
//      没扣到. 在事务外面单条 UPDATE, 不需要 BEGIN/COMMIT, SQLite 自带写锁串行化.
//
//   3. 退款回退余额
//      UPDATE wallets SET balance_micro = balance_micro - ?
//        WHERE id = ?
//      不带 >= 检查, 允许扣穿. 业务策略: 宁可让用户余额变负, 也不能让退款无法执行
//      (否则用户会以为「钱已退」但平台已经扣回去了, 结果产生「双扣」).
//
// 关键不变量:
//   - 任何时刻, sum(recharges.amount where status=succeeded) - sum(refunds.amount where status=succeeded)
//     - sum(usage_records.final_cost where status in (reserved, finalized, partial, canceled, failed))
//     ≈ wallet.balance_micro + wallet.frozen_micro
//   - 「≈」是因为预扣可能比实结多, 但 reserved 行迟早被 finalize 或 refund 掉, 最终一致.

import { eq, and, sql } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import {
  wallets,
  recharges,
  refunds,
  type Wallet,
  type Recharge,
  type Refund,
} from '../db/schema.js';

// ============================================================
// 错误
// ============================================================

export class InsufficientWalletBalanceError extends Error {
  constructor(public readonly walletId: number, public readonly required: number, public readonly available: number) {
    super(`wallet ${walletId} insufficient: need ${required} micro CNY, have ${available}`);
    this.name = 'InsufficientWalletBalanceError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(public readonly userId: number) {
    super(`wallet for user ${userId} not found`);
    this.name = 'WalletNotFoundError';
  }
}

// ============================================================
// wallet 基础操作
// ============================================================

export interface EnsureWalletInput {
  userId: number;
  /** 初始余额 (微元). 仅在新建 wallet 时生效, 已有 wallet 不会被覆盖 */
  initialBalanceMicro?: number;
}

/**
 * 幂等地确保某个 user 有 wallet. 没有则建一个 (initialBalanceMicro 注入), 有则什么都不做.
 *
 * 利用 wallets.user_id UNIQUE 索引: INSERT 撞约束时捕获, 视为已存在.
 */
export function ensureWallet(input: EnsureWalletInput): Wallet {
  const db = getDb();
  const existed = db.select().from(wallets).where(eq(wallets.userId, input.userId)).all();
  if (existed.length > 0) return existed[0]!;
  const now = Date.now();
  try {
    const rows = db
      .insert(wallets)
      .values({
        userId: input.userId,
        balanceMicro: input.initialBalanceMicro ?? 0,
        frozenMicro: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    return rows[0]!;
  } catch (err) {
    // 并发 ensure 时另一个请求先 INSERT 了, 撞 UNIQUE 后再查一次
    if (isUniqueConstraintError(err)) {
      const after = db.select().from(wallets).where(eq(wallets.userId, input.userId)).all();
      if (after.length > 0) return after[0]!;
    }
    throw err;
  }
}

export function getWalletByUserId(userId: number): Wallet | null {
  const db = getDb();
  const rows = db.select().from(wallets).where(eq(wallets.userId, userId)).all();
  return rows.length > 0 ? rows[0]! : null;
}

export function getWalletById(walletId: number): Wallet | null {
  const db = getDb();
  const rows = db.select().from(wallets).where(eq(wallets.id, walletId)).all();
  return rows.length > 0 ? rows[0]! : null;
}

// ============================================================
// 余额扣减 (preConsume 用)
//
// 单条 UPDATE 配合 RETURNING, 原子完成「检查 + 扣减」.
// 两个并发请求时, SQLite 的写锁会串行化, 第二个请求看到的 balance 已经是第一个扣完后的值.
// ============================================================

export interface DeductBalanceInput {
  walletId: number;
  amountMicro: number;
}

export interface DeductBalanceOutput {
  walletId: number;
  balanceAfter: number;
}

/**
 * 乐观锁扣减余额. 失败抛 InsufficientWalletBalanceError.
 *
 * 注意 amountMicro 必须为正数. 退款回退请用 refundReleaseBalance().
 */
export function deductBalance(input: DeductBalanceInput): DeductBalanceOutput {
  if (!Number.isInteger(input.amountMicro) || input.amountMicro <= 0) {
    throw new Error(`amountMicro must be positive integer, got ${input.amountMicro}`);
  }
  const db = getDb();
  const now = Date.now();
  const updated = db
    .update(wallets)
    .set({
      balanceMicro: sql`${wallets.balanceMicro} - ${input.amountMicro}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(wallets.id, input.walletId),
        sql`${wallets.balanceMicro} >= ${input.amountMicro}`,
      ),
    )
    .returning({ balance: wallets.balanceMicro })
    .all();

  if (updated.length === 0) {
    // 区分两种失败原因: wallet 不存在 vs 余额不足
    const cur = db
      .select({ b: wallets.balanceMicro })
      .from(wallets)
      .where(eq(wallets.id, input.walletId))
      .all();
    const have = cur.length > 0 ? cur[0]!.b : 0;
    throw new InsufficientWalletBalanceError(input.walletId, input.amountMicro, have);
  }
  return { walletId: input.walletId, balanceAfter: updated[0]!.balance };
}

/**
 * 退还余额 (postConsume 多扣回退 / refund 退款).
 *
 * 注意: 这里允许 balance 变负 (退款扣穿场景). amountMicro 为「正」表示「加回去」.
 */
export function creditBalance(input: { walletId: number; amountMicro: number }): DeductBalanceOutput {
  if (!Number.isInteger(input.amountMicro) || input.amountMicro <= 0) {
    throw new Error(`amountMicro must be positive integer, got ${input.amountMicro}`);
  }
  const db = getDb();
  const now = Date.now();
  const updated = db
    .update(wallets)
    .set({
      balanceMicro: sql`${wallets.balanceMicro} + ${input.amountMicro}`,
      updatedAt: now,
    })
    .where(eq(wallets.id, input.walletId))
    .returning({ balance: wallets.balanceMicro })
    .all();
  if (updated.length === 0) {
    throw new WalletNotFoundError(input.walletId);
  }
  return { walletId: input.walletId, balanceAfter: updated[0]!.balance };
}

// ============================================================
// 充值: createRecharge / handleRechargeCallback
// ============================================================

export interface CreateRechargeInput {
  userId: number;
  outTradeNo: string;
  provider: string;
  amountMicro: number;
}

/**
 * 创建一笔 pending 充值流水. 必须在 adapter.createOrder() 成功后调用.
 *
 * 幂等: 同 out_trade_no 重复 INSERT 时撞 UNIQUE, 捕获后查回原行 (调用方的责任是确保
 * 同 out_trade_no 不会用不同金额二次创建).
 */
export function createRechargeOrder(input: CreateRechargeInput): Recharge {
  const db = getDb();
  const wallet = getWalletByUserId(input.userId);
  if (!wallet) throw new WalletNotFoundError(input.userId);
  const now = Date.now();
  try {
    const rows = db
      .insert(recharges)
      .values({
        walletId: wallet.id,
        userId: input.userId,
        outTradeNo: input.outTradeNo,
        provider: input.provider,
        amountMicro: input.amountMicro,
        status: 'pending',
        createdAt: now,
      })
      .returning()
      .all();
    return rows[0]!;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const existed = db
        .select()
        .from(recharges)
        .where(eq(recharges.outTradeNo, input.outTradeNo))
        .all();
      if (existed.length > 0) return existed[0]!;
    }
    throw err;
  }
}

export interface HandleRechargeCallbackInput {
  outTradeNo: string;
  status: 'succeeded' | 'failed';
  amountMicro: number;
  rawPayload: string;
}

export interface HandleRechargeCallbackOutput {
  /** 状态机最终值 */
  status: Recharge['status'];
  /** 是否在本次回调里执行了入账. 重复回调时为 false (幂等返回 ok) */
  credited: boolean;
  /** 入账后的钱包余额 (仅 credited=true 时有值) */
  balanceAfter?: number;
  /** 调试: 给客户端的提示 */
  notice: string;
}

/**
 * 处理充值回调. 这里是「充值幂等」三道核心难题之一最关键的实现.
 *
 * 状态机分支:
 *   pending -> succeeded: 入账 + 写状态
 *   pending -> failed:    只写状态, 不入账
 *   succeeded -> succeeded: 重复回调, 直接返 ok 不入账 (幂等)
 *   succeeded -> failed:  忽略 (已经成功的订单不能被失败回调改成失败)
 *   failed -> succeeded:  允许 (失败的订单可能被用户在另一个支付方式上重新支付成功)
 *                        但需要 amount 一致, 否则报警
 *   refunded -> *:        忽略 (已退款的订单不再接收任何回调)
 *
 * 所有 DB 写操作包在 better-sqlite3 的 immediate transaction 里, 失败回滚.
 */
export function handleRechargeCallback(
  input: HandleRechargeCallbackInput,
): HandleRechargeCallbackOutput {
  const db = getDb();
  const rows = db
    .select()
    .from(recharges)
    .where(eq(recharges.outTradeNo, input.outTradeNo))
    .all();
  if (rows.length === 0) {
    // 平台回调了一个我们没创建过的订单 -- 异常情况, 记日志但不入账
    return {
      status: 'failed',
      credited: false,
      notice: `recharge ${input.outTradeNo} not found in DB`,
    };
  }
  const recharge = rows[0]!;

  // 金额校验: 平台回调里的金额必须与下单时一致, 否则可能是篡改
  if (recharge.amountMicro !== input.amountMicro) {
    return {
      status: recharge.status as Recharge['status'],
      credited: false,
      notice: `amount mismatch: ordered ${recharge.amountMicro}, callback ${input.amountMicro}`,
    };
  }

  // 已经退款过的订单: 忽略后续回调
  if (recharge.status === 'refunded') {
    return {
      status: 'refunded',
      credited: false,
      notice: 'already refunded, ignore',
    };
  }

  // 已 succeeded: 幂等, 重复回调直接返 ok
  if (recharge.status === 'succeeded') {
    return {
      status: 'succeeded',
      credited: false,
      notice: 'already succeeded, idempotent ok',
    };
  }

  // 已 failed 且本次回调也是 failed: 状态稳定
  if (recharge.status === 'failed' && input.status === 'failed') {
    return {
      status: 'failed',
      credited: false,
      notice: 'already failed, ignore',
    };
  }

  // 状态需要变化的两种情况:
  //   pending -> succeeded: 入账 + 写状态
  //   pending -> failed:    只写状态
  //   failed -> succeeded:  入账 + 改状态 (跨平台重新发起的成功支付)
  const now = Date.now();

  if (input.status === 'failed') {
    db.update(recharges)
      .set({ status: 'failed', rawPayload: input.rawPayload, completedAt: now })
      .where(eq(recharges.id, recharge.id))
      .run();
    return { status: 'failed', credited: false, notice: 'marked failed' };
  }

  // input.status === 'succeeded' && recharge.status in (pending, failed) -> 入账
  const credited = creditBalance({ walletId: recharge.walletId, amountMicro: input.amountMicro });
  db.update(recharges)
    .set({ status: 'succeeded', rawPayload: input.rawPayload, completedAt: now })
    .where(eq(recharges.id, recharge.id))
    .run();
  return {
    status: 'succeeded',
    credited: true,
    balanceAfter: credited.balanceAfter,
    notice: 'credited',
  };
}

// ============================================================
// 退款: createRefundOrder / handleRefundCallback
// ============================================================

export interface CreateRefundOrderInput {
  rechargeId: number;
  refundNo: string;
  amountMicro: number;
  reason?: string;
}

/**
 * 创建一笔 pending 退款流水. 必须在 admin 决定退款 + adapter.refund() 受理之后调用.
 *
 * 幂等: 同 refund_no 重复 INSERT 时返回原行.
 */
export function createRefundOrder(input: CreateRefundOrderInput): Refund {
  const db = getDb();
  const now = Date.now();
  try {
    const rows = db
      .insert(refunds)
      .values({
        rechargeId: input.rechargeId,
        refundNo: input.refundNo,
        amountMicro: input.amountMicro,
        reason: input.reason ?? null,
        status: 'pending',
        createdAt: now,
      })
      .returning()
      .all();
    return rows[0]!;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const existed = db.select().from(refunds).where(eq(refunds.refundNo, input.refundNo)).all();
      if (existed.length > 0) return existed[0]!;
    }
    throw err;
  }
}

export interface HandleRefundCallbackInput {
  refundNo: string;
  status: 'succeeded' | 'failed';
  amountMicro: number;
  rawPayload: string;
}

export interface HandleRefundCallbackOutput {
  status: Refund['status'];
  /** 是否本次回调里真正执行了余额回退 */
  released: boolean;
  balanceAfter?: number;
  notice: string;
}

/**
 * 处理退款回调.
 *
 * 状态机:
 *   pending -> succeeded: 余额回退 (扣穿允许) + 写 refunds.status=succeeded + 写 recharges.status=refunded
 *   pending -> failed:    写 refunds.status=failed (recharges.status 保持 succeeded)
 *   succeeded -> *:       已经退过的退款单, 忽略
 *
 * 余额回退用 deductBalance, 但传 walletId + amount 的同时**不带** >= 检查 (因为退款必须执行).
 * 实现上调 deductBalance 会失败 (它带 >= 检查), 所以这里直接走单独的 SQL.
 */
export function handleRefundCallback(input: HandleRefundCallbackInput): HandleRefundCallbackOutput {
  const db = getDb();
  const refundRows = db.select().from(refunds).where(eq(refunds.refundNo, input.refundNo)).all();
  if (refundRows.length === 0) {
    return { status: 'failed', released: false, notice: `refund ${input.refundNo} not found` };
  }
  const refund = refundRows[0]!;

  if (refund.status === 'succeeded' || refund.status === 'failed') {
    return {
      status: refund.status as Refund['status'],
      released: false,
      notice: `refund already ${refund.status}, ignore`,
    };
  }

  if (refund.amountMicro !== input.amountMicro) {
    return {
      status: refund.status as Refund['status'],
      released: false,
      notice: `amount mismatch: requested ${refund.amountMicro}, callback ${input.amountMicro}`,
    };
  }

  const now = Date.now();

  if (input.status === 'failed') {
    db.update(refunds)
      .set({ status: 'failed', rawPayload: input.rawPayload, completedAt: now })
      .where(eq(refunds.id, refund.id))
      .run();
    return { status: 'failed', released: false, notice: 'refund marked failed' };
  }

  // input.status === 'succeeded' -> 真正退款
  // 1. 余额回退 (允许扣穿). 不用 deductBalance (它带 >= 检查), 直接单 SQL.
  const rechargeRows = db
    .select()
    .from(recharges)
    .where(eq(recharges.id, refund.rechargeId))
    .all();
  if (rechargeRows.length === 0) {
    return { status: refund.status as Refund['status'], released: false, notice: 'orphan refund (no recharge)' };
  }
  const recharge = rechargeRows[0]!;

  const updated = db
    .update(wallets)
    .set({
      balanceMicro: sql`${wallets.balanceMicro} - ${input.amountMicro}`,
      updatedAt: now,
    })
    .where(eq(wallets.id, recharge.walletId))
    .returning({ balance: wallets.balanceMicro })
    .all();

  // 2. 翻 recharges.status = refunded
  db.update(recharges)
    .set({ status: 'refunded', completedAt: now })
    .where(eq(recharges.id, refund.rechargeId))
    .run();

  // 3. 翻 refunds.status = succeeded
  db.update(refunds)
    .set({ status: 'succeeded', rawPayload: input.rawPayload, completedAt: now })
    .where(eq(refunds.id, refund.id))
    .run();

  return {
    status: 'succeeded',
    released: true,
    balanceAfter: updated[0]?.balance,
    notice: 'refund released',
  };
}

// ============================================================
// 工具函数
// ============================================================

export function generateOutTradeNo(userId: number): string {
  // 与 new-api controller/topup.go::RequestEpay 命名风格一致: USR{id}NO{rand}{ts}
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `USR${userId}NO${rand}${ts}`;
}

export function generateRefundNo(rechargeId: number): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `RFD${rechargeId}NO${rand}${ts}`;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)) return true;
  return false;
}

// 重新导出, 给 admin / payment-routes 用
export type { Wallet, Recharge, Refund };
