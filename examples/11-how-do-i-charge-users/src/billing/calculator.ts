// 两阶段计费核心
//
// v0.11 改动: 余额从 users.balance_micro 改成 wallets.balance_micro.
//   - preConsume:  乐观锁扣 wallets, 走 wallet/service.ts::deductBalance;
//   - postConsume: 多退少补改写 wallets, 走 creditBalance / deductBalance;
//   - refundReservation: 同上.
//   - users.balance_micro 字段保留作为 deprecated 兼容字段, 不再被本路径写入.
//
// 关键不变量: 每个 user 必须先 ensureWallet() 才能发请求. admin/users 路由已经在创建 user 时
// 立刻 ensureWallet, 老数据可以跑 cli/seed-wallet.ts 一次性补.
//
// preConsume: 进入主流程前预扣
//   1. 用 tiktoken 算 estimated prompt tokens;
//   2. 用 request.max_tokens (或 DEFAULT_MAX_TOKENS) 当 output 上限估算;
//   3. 取当前价格 + 倍率, 算出预扣金额 (微元);
//   4. 用乐观锁扣 wallets.balance_micro;
//   5. 写一行 usage_records (status=reserved), 占位.
//
// postConsume: 上游返回后实结
//   1. 拿到真实 usage (prompt_tokens / completion_tokens);
//   2. 用同一份价格 + 倍率 (从 reserved 行读 multiplier_snapshot, 保证算账价格一致)
//      重算 final_cost;
//   3. 计算 delta = preReservedCost - finalCost
//        delta > 0: 退回 (creditBalance);
//        delta < 0: 再扣 (deductBalance, 失败时降级为强制扣穿警告);
//   4. 把 usage_records 行 UPDATE 为 status=finalized, 落账 token / cost / multiplier_snapshot.
//
// refund: 上游 5xx / 网络错 / 鉴权失败时, 全额退回预扣, 不计费.
//
// 关于「乐观锁」:
//   - SQLite 的 UPDATE WHERE balance >= cost 配合 RETURNING, 单条语句原子完成
//     「检查并扣减」, 两个并发请求不会同时扣穿;
//   - 失败 (changes() = 0) 意味着另一个并发请求先扣到了, 或余额本就不够.

import { eq, sql } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { usageRecords, wallets, type UsageRecord } from '../db/schema.js';
import { getCurrentPrice, PriceNotFoundError } from './prices.js';
import { resolveMultiplier } from '../multiplier/registry.js';
import { estimatePromptTokens } from './tokenizer.js';
import type { IRMessage } from '../types/ir.js';
import {
  deductBalance,
  creditBalance,
  getWalletByUserId,
  InsufficientWalletBalanceError,
  WalletNotFoundError,
} from '../wallet/service.js';

export interface PreConsumeInput {
  traceId: string;
  userId: number;
  orgId: number;
  keyId: number;
  model: string;
  provider: string;
  messages: IRMessage[];
  /** 客户端的 max_tokens; 不传时上层用 DEFAULT_MAX_TOKENS 兜底 */
  maxOutputTokens: number;
  isStream: boolean;
}

export interface PreConsumeOutput {
  /** 写入的 usage_records 行 id, postConsume 时按它定位 */
  recordId: number;
  /** 预扣金额, 微元. 流式 streaming-counter 会在边收边算时与它对账 */
  preReservedCost: number;
  /** 本地估算的 prompt tokens, 已存进 record */
  estimatedPromptTokens: number;
}

/**
 * v0.11 之前: 直接抛 InsufficientBalanceError, 由主路径返 402.
 * v0.11 之后: 内部用 InsufficientWalletBalanceError, 但保留 InsufficientBalanceError 兼容
 *            (主路径 catch 这个老符号), 通过 instance subclass 关系兼容老代码.
 */
export class InsufficientBalanceError extends Error {
  constructor(public required: number, public available: number) {
    super(`insufficient balance: need ${required} micro CNY, have ${available}`);
    this.name = 'InsufficientBalanceError';
  }
}

export class WalletMissingError extends Error {
  constructor(public readonly userId: number) {
    super(`wallet for user ${userId} not found, run seed-wallet first`);
    this.name = 'WalletMissingError';
  }
}

/**
 * preConsume: 占位 + 预扣余额
 *
 * 流程严格按「先扣余额再写 record」的顺序, 保证余额扣减是单点真相,
 * 即使写 record 失败, 余额也已经扣掉 (后续 postConsume 用余额对账兜底).
 */
export function preConsume(input: PreConsumeInput): PreConsumeOutput {
  const db = getDb();

  // 1. 本地估算 prompt tokens
  const estimatedPromptTokens = estimatePromptTokens(input.messages, input.model);

  // 2. 取当前价格 + 三合一倍率
  const price = getCurrentPrice(input.model, input.provider);
  const mul = resolveMultiplier({
    userId: input.userId,
    model: input.model,
    provider: input.provider,
  });

  // 3. 预扣金额 = (prompt × inputPrice + max_output × outputPrice) × 倍率
  //    向上取整, 防止四舍五入导致少扣 1 微元
  const baseCost =
    estimatedPromptTokens * price.inputPricePerToken +
    input.maxOutputTokens * price.outputPricePerToken;
  const preReservedCost = Math.ceil(baseCost * mul.combinedFloat);

  // 4. v0.11: 乐观锁扣 wallets.balance_micro (经 wallet/service.deductBalance).
  //    没 wallet 抛 WalletMissingError, 余额不足抛 InsufficientBalanceError (老符号兼容).
  const wallet = getWalletByUserId(input.userId);
  if (!wallet) {
    throw new WalletMissingError(input.userId);
  }
  try {
    deductBalance({ walletId: wallet.id, amountMicro: preReservedCost });
  } catch (err) {
    if (err instanceof InsufficientWalletBalanceError) {
      throw new InsufficientBalanceError(err.required, err.available);
    }
    if (err instanceof WalletNotFoundError) {
      throw new WalletMissingError(input.userId);
    }
    throw err;
  }

  // 5. 写入 usage_records 占位 (status=reserved)
  const now = Date.now();
  const rows = db
    .insert(usageRecords)
    .values({
      traceId: input.traceId,
      userId: input.userId,
      orgId: input.orgId,
      keyId: input.keyId,
      model: input.model,
      provider: input.provider,
      promptTokens: 0,
      completionTokens: 0,
      estimatedPromptTokens,
      promptCost: 0,
      completionCost: 0,
      finalCost: 0,
      preReservedCost,
      multiplierSnapshot: mul.combinedScale1e9,
      status: 'reserved',
      isStream: input.isStream,
      createdAt: now,
    })
    .returning({ id: usageRecords.id })
    .all();

  return {
    recordId: rows[0]!.id,
    preReservedCost,
    estimatedPromptTokens,
  };
}

export interface PostConsumeInput {
  recordId: number;
  userId: number;
  model: string;
  provider: string;
  /** 上游实际消耗 input token. 流式时是累加值. */
  realPromptTokens: number;
  /** 上游实际消耗 output token. 流式中途断开时是「已收到的部分」 */
  realCompletionTokens: number;
  // ----- v0.10 新增 (cache / batch 计费) -----
  /**
   * 缓存命中的 input token 数 (Anthropic cache_read_input_tokens
   * / OpenAI prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens).
   * realPromptTokens 包含了 cachedInputTokens, 计费时:
   *   cached 部分按 cacheInputPricePerToken 算 (0.1x / 0.5x 折扣);
   *   剩余 (realPromptTokens - cachedInputTokens) 按 inputPricePerToken 算.
   * 默认 0 = 没缓存命中, 行为与 v0.9 一致.
   */
  cachedInputTokens?: number;
  /**
   * Anthropic 缓存写入 token 数 (cache_creation_input_tokens).
   * 本章 v0.10 计费简化: 按 input 单价计 (Anthropic 实际是 1.25x / 2x, 留作扩展点).
   */
  cacheWriteTokens?: number;
  /** 是否走 batch 通道. true 时 input/output 全部按 batchInput/batchOutput 单价算. */
  batchMode?: boolean;
}

export interface PostConsumeOutput {
  recordId: number;
  promptCost: number;
  completionCost: number;
  finalCost: number;
  /** 余额变动 (正数 = 退回, 负数 = 又扣了一点) */
  balanceDelta: number;
  /** 这一笔成本里 cache 部分占多少 (微元), 看板调试用 */
  cacheCost?: number;
}

/**
 * v0.10: 把「真实 token 数 × 单价 × 倍率」这一段拆出来, 让 postConsume / postConsumeStream 共用.
 *
 * 计费规则:
 *   - 普通 input  = (realPromptTokens - cachedInputTokens) × inputPricePerToken
 *   - cache input = cachedInputTokens × cacheInputPricePerToken (null 时回退到 input)
 *   - cache write = cacheWriteTokens × inputPricePerToken (本章简化, 不另算)
 *   - output      = realCompletionTokens × outputPricePerToken
 *   - batch 模式: input/output 都换成 batchInput/batchOutput 单价;
 *                 cached 仍然按 cacheInputPricePerToken (官方 batch 不影响 caching 单价).
 *   - 倍率: 所有项目都再乘 mul.combinedFloat (user × channel × model 三合一)
 */
function computeFinalCost(
  input: PostConsumeInput,
  price: ReturnType<typeof getCurrentPrice>,
  multiplier: number,
): { promptCost: number; completionCost: number; cacheCost: number; finalCost: number } {
  const cached = Math.max(0, input.cachedInputTokens ?? 0);
  const cacheWrite = Math.max(0, input.cacheWriteTokens ?? 0);
  // realPromptTokens 通常包含 cached 部分, 减出 normal input
  const normalInput = Math.max(0, input.realPromptTokens - cached);

  const useBatch = input.batchMode === true;
  const inputUnit =
    useBatch && price.batchInputPricePerToken !== null
      ? price.batchInputPricePerToken
      : price.inputPricePerToken;
  const outputUnit =
    useBatch && price.batchOutputPricePerToken !== null
      ? price.batchOutputPricePerToken
      : price.outputPricePerToken;
  const cacheUnit =
    price.cacheInputPricePerToken !== null
      ? price.cacheInputPricePerToken
      : price.inputPricePerToken;

  const normalInputCost = normalInput * inputUnit;
  const cacheReadCost = cached * cacheUnit;
  const cacheWriteCost = cacheWrite * price.inputPricePerToken;
  const outputCost = input.realCompletionTokens * outputUnit;

  const promptCost = Math.ceil((normalInputCost + cacheReadCost + cacheWriteCost) * multiplier);
  const completionCost = Math.ceil(outputCost * multiplier);
  const cacheCost = Math.ceil(cacheReadCost * multiplier);
  return { promptCost, completionCost, cacheCost, finalCost: promptCost + completionCost };
}

/**
 * postConsume: 拿到真实 usage 后实结, 多退少补
 *
 * 取价时必须用「与 preConsume 一致的价格 + 倍率」.
 * v0.5 简化: 重新调 getCurrentPrice / resolveMultiplier 即可 (60s 内基本不会变);
 * 严格版本应当读 usage_records.multiplier_snapshot + prices.id (record 里存的快照).
 *
 * v0.10: cached / batch 都从 input 进来, 计费分拆委托给 computeFinalCost.
 */
export function postConsume(input: PostConsumeInput): PostConsumeOutput {
  const db = getDb();
  const price = getCurrentPrice(input.model, input.provider);
  const mul = resolveMultiplier({
    userId: input.userId,
    model: input.model,
    provider: input.provider,
  });

  const { promptCost, completionCost, cacheCost, finalCost } = computeFinalCost(
    input,
    price,
    mul.combinedFloat,
  );

  // 取 record, 算 delta
  const rec = db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.id, input.recordId))
    .all();
  if (rec.length === 0) {
    throw new Error(`usage_record ${input.recordId} not found`);
  }
  const row = rec[0]!;
  if (row.status !== 'reserved') {
    // 重复 postConsume? 幂等保护: 不再扣余额, 直接返回当前数字
    return {
      recordId: row.id,
      promptCost: row.promptCost,
      completionCost: row.completionCost,
      finalCost: row.finalCost,
      balanceDelta: 0,
    };
  }

  // 多退少补: balanceDelta = preReserved - finalCost
  //   > 0: 退回钱包 (creditBalance);
  //   < 0: 少扣的部分再扣 (deductBalance), 余额不足时降级为「强制扣穿」--
  //        本章选 a 策略: 直接走 wallets - amount 的单 SQL, 允许变负, 留待人工对账.
  const balanceDelta = row.preReservedCost - finalCost;
  applyWalletDelta(input.userId, balanceDelta);

  const now = Date.now();
  db.update(usageRecords)
    .set({
      promptTokens: input.realPromptTokens,
      completionTokens: input.realCompletionTokens,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      batchMode: input.batchMode === true,
      promptCost,
      completionCost,
      finalCost,
      status: 'finalized',
      finalizedAt: now,
    })
    .where(eq(usageRecords.id, input.recordId))
    .run();

  return { recordId: input.recordId, promptCost, completionCost, finalCost, balanceDelta, cacheCost };
}

/**
 * postConsumeStream: 流式专用的实结. 与 postConsume 流程基本相同, 唯一差异在
 *   `status` 字段的终态:
 *     - finalized: 流走完了 (上游 [DONE] / message_stop), 与非流式一致
 *     - canceled : 客户端中途 Ctrl+C / 关连接, 已发出的 token 仍计费, status=canceled
 *     - partial  : 上游中途出错或被网关 abort, 已收到的部分 token 计费, status=partial
 *
 * 之所以单开一个函数, 是因为非流式语义里 canceled / partial 这两个终态根本不存在:
 *   一次非流式请求要么 finalized, 要么 refunded, 要么 failed.
 * 流式额外多出「半路停了, 但已经吃了一部分 token」这种状态, 看板与对账时需要区分.
 *
 * 与 one-api 对比:
 *   - one-api 在 StreamHandler 结尾把 usage 累加值塞回 ctx, 走同一份 PostConsumeTokenQuota,
 *     不区分 status. 流式中断时的 usage 就是「已经收到的累加值」, 隐式落到 finalized.
 *   - 本书显式拆 status, 是为了 Ch9 看板能按状态聚合 (canceled 比例可以反映客户端质量).
 */
export function postConsumeStream(
  input: PostConsumeInput & { terminalStatus: 'finalized' | 'canceled' | 'partial' },
): PostConsumeOutput {
  const db = getDb();
  const price = getCurrentPrice(input.model, input.provider);
  const mul = resolveMultiplier({
    userId: input.userId,
    model: input.model,
    provider: input.provider,
  });

  const { promptCost, completionCost, cacheCost, finalCost } = computeFinalCost(
    input,
    price,
    mul.combinedFloat,
  );

  const rec = db
    .select()
    .from(usageRecords)
    .where(eq(usageRecords.id, input.recordId))
    .all();
  if (rec.length === 0) {
    throw new Error(`usage_record ${input.recordId} not found`);
  }
  const row = rec[0]!;
  if (row.status !== 'reserved') {
    return {
      recordId: row.id,
      promptCost: row.promptCost,
      completionCost: row.completionCost,
      finalCost: row.finalCost,
      balanceDelta: 0,
    };
  }

  const balanceDelta = row.preReservedCost - finalCost;
  applyWalletDelta(input.userId, balanceDelta);

  const now = Date.now();
  db.update(usageRecords)
    .set({
      promptTokens: input.realPromptTokens,
      completionTokens: input.realCompletionTokens,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      batchMode: input.batchMode === true,
      promptCost,
      completionCost,
      finalCost,
      status: input.terminalStatus,
      finalizedAt: now,
    })
    .where(eq(usageRecords.id, input.recordId))
    .run();

  return { recordId: input.recordId, promptCost, completionCost, finalCost, balanceDelta, cacheCost };
}

/**
 * refund: 上游失败 / 网络错时, 全额退回预扣, 不计费.
 *
 * 与 postConsume 互斥: refund 之后该 record 永久 status=refunded, 不再走 postConsume.
 */
export function refundReservation(recordId: number, errorMessage?: string): void {
  const db = getDb();
  const rec = db.select().from(usageRecords).where(eq(usageRecords.id, recordId)).all();
  if (rec.length === 0) return;
  const row = rec[0]!;
  if (row.status !== 'reserved') return; // 幂等

  // v0.11: 退回钱包余额 (走 creditBalance, 允许 wallet 已被并发扣到 0 也能 +)
  applyWalletDelta(row.userId, row.preReservedCost);
  db.update(usageRecords)
    .set({
      status: 'refunded',
      finalCost: 0,
      finalizedAt: Date.now(),
      errorMessage: errorMessage ?? null,
    })
    .where(eq(usageRecords.id, recordId))
    .run();
}

/**
 * 把「正负」的 balance delta 应用到钱包.
 *   delta > 0: creditBalance (退回)
 *   delta < 0: deductBalance, 不够扣时强制扣穿 (单 SQL, 不带 >= 检查)
 *   delta == 0: 什么都不做
 *
 * 没 wallet 时静默跳过, 不抛异常 -- 主路径已经在 preConsume 阶段做过校验,
 * 走到这里 wallet 一定存在; 万一被人手动删 wallet, 不应让正在结算的请求崩.
 */
function applyWalletDelta(userId: number, delta: number): void {
  if (delta === 0) return;
  const wallet = getWalletByUserId(userId);
  if (!wallet) return;
  if (delta > 0) {
    creditBalance({ walletId: wallet.id, amountMicro: delta });
    return;
  }
  // delta < 0: 先尝试乐观锁 deduct, 失败就走「强制扣穿」单 SQL.
  const need = -delta;
  try {
    deductBalance({ walletId: wallet.id, amountMicro: need });
  } catch (err) {
    if (err instanceof InsufficientWalletBalanceError) {
      // 强制扣穿 (允许变负): UPDATE wallets SET balance = balance - need, 不带 >= 检查
      const db = getDb();
      const now = Date.now();
      db.update(wallets)
        .set({
          balanceMicro: sql`${wallets.balanceMicro} - ${need}`,
          updatedAt: now,
        })
        .where(eq(wallets.id, wallet.id))
        .run();
    } else {
      throw err;
    }
  }
}

/** 主动把 record 标 failed (postConsume 异常时用). 余额已扣的部分留待人工对账. */
export function markFailed(recordId: number, errorMessage: string): void {
  const db = getDb();
  db.update(usageRecords)
    .set({ status: 'failed', errorMessage, finalizedAt: Date.now() })
    .where(eq(usageRecords.id, recordId))
    .run();
}

/**
 * v0.9: 把可观测性字段写回 usage_records.
 *
 * 这一组字段是「事后」字段, 与计费金额无关, 单独走一条 UPDATE 不影响 status / 余额.
 * 设计意图: postConsume 仍然只关心金额; observability 字段在主路径上单独更新一次,
 * 看板就能按 channel / latency 维度聚合.
 *
 *   channelId           本次请求实际命中的 channel id (最后一次成功的那个)
 *   upstreamLatencyMs   上游 fetch 起到 first byte / parse 完成的耗时 (毫秒)
 *   attemptedChannels   本次请求实际尝试过的 channel id 列表
 */
export function recordObservability(input: {
  recordId: number;
  channelId: number | null;
  upstreamLatencyMs: number | null;
  attemptedChannels: number[];
}): void {
  const db = getDb();
  db.update(usageRecords)
    .set({
      channelId: input.channelId,
      upstreamLatencyMs: input.upstreamLatencyMs,
      attemptedChannels: JSON.stringify(input.attemptedChannels),
    })
    .where(eq(usageRecords.id, input.recordId))
    .run();
}

export { PriceNotFoundError };
export type { UsageRecord };
