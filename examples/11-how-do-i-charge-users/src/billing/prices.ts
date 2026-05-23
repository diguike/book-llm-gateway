// 价格表注册 / 热加载 / 查询
//
// v0.10 变更:
//   1. ResolvedPrice 加 cacheInputPricePerToken / batchInputPricePerToken / batchOutputPricePerToken
//      三个可选字段. null 表示该 model 不支持对应折扣 (回退到 inputPricePerToken / outputPricePerToken).
//   2. 默认价格表针对每家厂商的官方 caching / batch 折扣灌入:
//        - Anthropic: cache read = 0.1x input, batch = 0.5x input/output (https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
//        - OpenAI:    cache read = 0.5x input (≥1024 token 自动), batch = 0.5x input/output (https://openai.com/index/api-prompt-caching/)
//        - DeepSeek:  cache hit = 0.1x input (https://api-docs.deepseek.com/news/news0802)
//        - Gemini:    cache read = 0.1x input (https://ai.google.dev/gemini-api/docs/pricing)
//      mock 上游也加上 cache + batch, 让本章脚本能跑出可量化对比.
//
// 设计意图:
//   - 价格表本身存 DB (prices 表), 支持运维通过 admin 接口热更新;
//   - 启动时把内置默认价格灌进去 (避免空表导致请求失败);
//   - 进程内对「当前生效价格」做轻量缓存 (TTL 60s), 减少每次请求查 DB;
//   - 查不到价格时抛错而不是 fallback, 否则会出现「免费白嫖」漏洞.

import { eq, and, isNull, or, gt, lte, desc } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { prices } from '../db/schema.js';

export interface ResolvedPrice {
  /** input 单价: 微元 / token */
  inputPricePerToken: number;
  /** output 单价: 微元 / token */
  outputPricePerToken: number;
  /** 缓存命中时的 input 单价: 微元 / token. null = 不区分, 回退到 inputPricePerToken */
  cacheInputPricePerToken: number | null;
  /** batch 通道的 input 单价: 微元 / token. null = 不支持 batch */
  batchInputPricePerToken: number | null;
  /** batch 通道的 output 单价: 微元 / token. null = 不支持 batch */
  batchOutputPricePerToken: number | null;
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
    cacheInputPricePerToken:
      row.cacheInputPriceMicroPer1M !== null && row.cacheInputPriceMicroPer1M !== undefined
        ? row.cacheInputPriceMicroPer1M / 1_000_000
        : null,
    batchInputPricePerToken:
      row.batchInputPriceMicroPer1M !== null && row.batchInputPriceMicroPer1M !== undefined
        ? row.batchInputPriceMicroPer1M / 1_000_000
        : null,
    batchOutputPricePerToken:
      row.batchOutputPriceMicroPer1M !== null && row.batchOutputPriceMicroPer1M !== undefined
        ? row.batchOutputPriceMicroPer1M / 1_000_000
        : null,
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
  /** v0.10 新增, 单位都用 元 / 1M tokens, 与上面对齐 */
  cacheInputCnyPer1M?: number;
  batchInputCnyPer1M?: number;
  batchOutputCnyPer1M?: number;
}

// ----------------------------------------------------------------
// 默认价目表 (2026 年 5 月对外公布价, 按 1 USD ≈ 7.2 CNY 大致换算).
//
// cache / batch 折扣倍率来源:
//   Anthropic: cache read = 0.1x input, batch = 0.5x both
//   OpenAI:    cache read = 0.5x input (≥1024 token 自动), batch = 0.5x both
//   DeepSeek:  cache hit  = 0.1x input
//   Gemini:    cache read = 0.1x input (不在本章默认表里; 主要演示 Anthropic / OpenAI / DeepSeek)
// ----------------------------------------------------------------

const DEFAULT_PRICES: DefaultPriceSeed[] = [
  // ----- OpenAI: 自动 prefix 缓存 (≥1024 token), batch 50% -----
  {
    model: 'gpt-4o-mini',
    provider: 'openai',
    inputCnyPer1M: 1.05,
    outputCnyPer1M: 4.32,
    cacheInputCnyPer1M: 0.525, // 0.5x
    batchInputCnyPer1M: 0.525, // 0.5x
    batchOutputCnyPer1M: 2.16, // 0.5x
  },
  {
    model: 'gpt-4o',
    provider: 'openai',
    inputCnyPer1M: 17.5,
    outputCnyPer1M: 70,
    cacheInputCnyPer1M: 8.75,
    batchInputCnyPer1M: 8.75,
    batchOutputCnyPer1M: 35,
  },
  { model: 'gpt-4-turbo', provider: 'openai', inputCnyPer1M: 70, outputCnyPer1M: 215 },
  { model: 'o1-mini', provider: 'openai', inputCnyPer1M: 21, outputCnyPer1M: 84 },
  { model: 'o3-mini', provider: 'openai', inputCnyPer1M: 7.92, outputCnyPer1M: 31.68 },

  // ----- DeepSeek: cache hit 0.1x -----
  {
    model: 'deepseek-chat',
    provider: 'deepseek',
    inputCnyPer1M: 2,
    outputCnyPer1M: 8,
    cacheInputCnyPer1M: 0.2, // 0.1x
  },
  {
    model: 'deepseek-reasoner',
    provider: 'deepseek',
    inputCnyPer1M: 4,
    outputCnyPer1M: 16,
    cacheInputCnyPer1M: 0.4,
  },

  // ----- Anthropic: 显式 cache_control, cache read 0.1x; batch 0.5x -----
  {
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    inputCnyPer1M: 21.6,
    outputCnyPer1M: 108,
    cacheInputCnyPer1M: 2.16, // 0.1x
    batchInputCnyPer1M: 10.8, // 0.5x
    batchOutputCnyPer1M: 54, // 0.5x
  },
  {
    model: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    inputCnyPer1M: 7.2,
    outputCnyPer1M: 28.8,
    cacheInputCnyPer1M: 0.72,
    batchInputCnyPer1M: 3.6,
    batchOutputCnyPer1M: 14.4,
  },
  { model: 'claude-3-opus-20240229', provider: 'anthropic', inputCnyPer1M: 108, outputCnyPer1M: 540 },

  // ----- mock 上游 (本章 demo 必备): 给 cache + batch 都配上, 才能跑出对比 -----
  {
    model: 'mock-gpt-4o-mini',
    provider: 'mock',
    inputCnyPer1M: 1,
    outputCnyPer1M: 4,
    cacheInputCnyPer1M: 0.1, // 演示 0.1x 极端折扣
    batchInputCnyPer1M: 0.5, // 0.5x
    batchOutputCnyPer1M: 2, // 0.5x
  },
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
        cacheInputPriceMicroPer1M:
          seed.cacheInputCnyPer1M !== undefined
            ? Math.round(seed.cacheInputCnyPer1M * 1_000_000)
            : null,
        batchInputPriceMicroPer1M:
          seed.batchInputCnyPer1M !== undefined
            ? Math.round(seed.batchInputCnyPer1M * 1_000_000)
            : null,
        batchOutputPriceMicroPer1M:
          seed.batchOutputCnyPer1M !== undefined
            ? Math.round(seed.batchOutputCnyPer1M * 1_000_000)
            : null,
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
