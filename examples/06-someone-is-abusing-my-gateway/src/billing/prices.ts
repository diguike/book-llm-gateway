// 价格表注册 / 热加载 / 查询
//
// 设计意图:
//   - 价格表本身存 DB (prices 表), 支持运维通过 admin 接口热更新;
//   - 启动时把内置默认价格灌进去 (避免空表导致请求失败);
//   - 进程内对「当前生效价格」做轻量缓存 (TTL 60s), 减少每次请求查 DB;
//   - 查不到价格时抛错而不是 fallback, 否则会出现「免费白嫖」漏洞.
//
// 单位约定:
//   - inputPriceMicroPer1M = 元 × 1_000_000, 每 1M token 的价钱.
//     例如 gpt-4o-mini input 约 1.05 元 / 1M tokens -> 1_050_000.
//   - 计算时除以 1_000_000 (1M) 转成「每 token 微元」, 再乘以真实 token 数.
//
// 默认价格来源:
//   - 官方公开 API 价目页面 (2026 年 5 月对外公布价);
//   - 数字按 1 USD ≈ 7.2 CNY 大致换算 (本章不做汇率精算).
//   - 真实运营要按当天汇率 + 上游分销折扣调整, 用 admin 接口热改.

import { eq, and, isNull, or, gt, lte, desc } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { prices } from '../db/schema.js';

export interface ResolvedPrice {
  /** input 单价: 微元 / token */
  inputPricePerToken: number;
  /** output 单价: 微元 / token */
  outputPricePerToken: number;
  /** 模型自身倍率 (千分位 integer) */
  modelMultiplier: number;
  /** 价格行 id, 写 usage_records 时落账以便审计 */
  priceId: number;
}

// 进程内缓存. key = `${model}::${provider}`, value = { price, expiresAt }
interface CacheEntry {
  price: ResolvedPrice;
  expiresAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/**
 * 查询当前时刻 (model, provider) 的生效价格.
 *
 * 选行规则:
 *   - effective_from <= now 且 (effective_to is null 或 effective_to > now);
 *   - 若多行同时满足, 取 effective_from 最大的 (最近生效);
 *   - 查不到抛 PriceNotFoundError, 上层应当返回 400 给客户端.
 */
export function getCurrentPrice(model: string, provider: string): ResolvedPrice {
  const cacheKey = `${model}::${provider}`;
  const now = Date.now();

  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.price;
  }

  const db = getDb();
  const rows = db
    .select()
    .from(prices)
    .where(
      and(
        eq(prices.model, model),
        eq(prices.provider, provider),
        lte(prices.effectiveFrom, now),
        or(isNull(prices.effectiveTo), gt(prices.effectiveTo, now)),
      ),
    )
    .orderBy(desc(prices.effectiveFrom))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new PriceNotFoundError(model, provider);
  }
  const row = rows[0]!;
  const price: ResolvedPrice = {
    inputPricePerToken: row.inputPriceMicroPer1M / 1_000_000,
    outputPricePerToken: row.outputPriceMicroPer1M / 1_000_000,
    modelMultiplier: row.modelMultiplier,
    priceId: row.id,
  };
  CACHE.set(cacheKey, { price, expiresAt: now + CACHE_TTL_MS });
  return price;
}

/** 清掉缓存. admin 接口在改价后调一次. */
export function invalidatePriceCache(): void {
  CACHE.clear();
}

export class PriceNotFoundError extends Error {
  constructor(public model: string, public provider: string) {
    super(`no active price for model=${model} provider=${provider}`);
    this.name = 'PriceNotFoundError';
  }
}

// ----------------------------------------------------------------
// 启动时灌入默认价格 (避免空表)
// ----------------------------------------------------------------

interface DefaultPriceSeed {
  model: string;
  provider: string;
  /** 元 / 1M tokens. 函数里换算成微元 */
  inputCnyPer1M: number;
  outputCnyPer1M: number;
  modelMultiplier?: number;
}

const DEFAULT_PRICES: DefaultPriceSeed[] = [
  // ----- OpenAI -----
  { model: 'gpt-4o-mini', provider: 'openai', inputCnyPer1M: 1.05, outputCnyPer1M: 4.32 },
  { model: 'gpt-4o', provider: 'openai', inputCnyPer1M: 17.5, outputCnyPer1M: 70 },
  { model: 'gpt-4-turbo', provider: 'openai', inputCnyPer1M: 70, outputCnyPer1M: 215 },
  { model: 'o1-mini', provider: 'openai', inputCnyPer1M: 21, outputCnyPer1M: 84 },
  { model: 'o3-mini', provider: 'openai', inputCnyPer1M: 7.92, outputCnyPer1M: 31.68 },
  // ----- DeepSeek (国内人民币原价) -----
  { model: 'deepseek-chat', provider: 'deepseek', inputCnyPer1M: 2, outputCnyPer1M: 8 },
  { model: 'deepseek-reasoner', provider: 'deepseek', inputCnyPer1M: 4, outputCnyPer1M: 16 },
  // ----- Anthropic -----
  { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic', inputCnyPer1M: 21.6, outputCnyPer1M: 108 },
  { model: 'claude-3-5-haiku-20241022', provider: 'anthropic', inputCnyPer1M: 7.2, outputCnyPer1M: 28.8 },
  { model: 'claude-3-opus-20240229', provider: 'anthropic', inputCnyPer1M: 108, outputCnyPer1M: 540 },
];

/** 把内置默认价格灌进 DB (仅 prices 表为空时, 避免覆盖运维改过的价). */
export function seedDefaultPricesIfEmpty(): { inserted: number; skipped: number } {
  const db = getDb();
  const existing = db.select({ id: prices.id }).from(prices).limit(1).all();
  if (existing.length > 0) {
    return { inserted: 0, skipped: DEFAULT_PRICES.length };
  }
  const now = Date.now();
  let inserted = 0;
  for (const seed of DEFAULT_PRICES) {
    db.insert(prices)
      .values({
        model: seed.model,
        provider: seed.provider,
        inputPriceMicroPer1M: Math.round(seed.inputCnyPer1M * 1_000_000),
        outputPriceMicroPer1M: Math.round(seed.outputCnyPer1M * 1_000_000),
        modelMultiplier: seed.modelMultiplier ?? 1000,
        effectiveFrom: now,
        effectiveTo: null,
        createdAt: now,
      })
      .run();
    inserted += 1;
  }
  return { inserted, skipped: 0 };
}
