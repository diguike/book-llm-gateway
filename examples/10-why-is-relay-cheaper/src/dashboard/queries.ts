// 第 9 章 v0.9: 看板用的聚合查询
//
// 这一层只负责「从 usage_records / channels 表里拉数据 + 聚合 + 返回普通对象」.
// HTML 渲染在 render.ts, 路由在 routes.ts. 三层拆开是为了:
//   1. 看板需要的聚合不一定只渲染成 HTML, 后续可能给 JSON API / CSV 导出复用;
//   2. SQL 写在一个文件里, 优化与索引调整集中;
//   3. 渲染纯字符串模板, 不沾染 DB 上下文.
//
// 教学场景下我们直接走原始 SQL (better-sqlite3.prepare), 不用 Drizzle 的 query builder.
// 原因: 看板用的聚合 (SUM / COUNT / GROUP BY / 时间窗 strftime) 在 Drizzle 上写起来
// 既要 import sql 又要拼 Drizzle 表达式, 远不如直接看 SQL 清晰. 真要换 PostgreSQL,
// 只改 strftime 那一句就行.
//
// 关于大规模日志: Helicone 的实践是把 prompt/completion 全文落 ClickHouse, 走列式
// 压缩 + 倒排, 聚合查询毫秒级. 我们 SQLite + 100 万行只算 GROUP BY model 的话仍然
// 几十毫秒级 (有 model_time_idx 索引), 教学场景够用. 真要扛百万级 QPS, 看板这一层
// 应该独立成「日志聚合服务」, 网关只负责写日志.

import { getRawSqlite } from '../db/client.js';

/** 今日起始时间戳 (本机时区, 0 点) */
function todayStartMs(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function daysAgoStartMs(days: number): number {
  return todayStartMs() - days * 24 * 60 * 60 * 1000;
}

// ============================================================
// 1. 今日 QPS (按分钟聚合)
// ============================================================
//
// 把今天每一分钟的请求数算出来, 看板渲染成简单的 ASCII bar chart.
// 没有引入图表库, 是因为 SSR 直出 HTML 不想引前端依赖; 但 60 行 sparkline
// 已经足够看出「凌晨 3 点突然峰值」这种异常.

export interface QpsBucket {
  minute: string; // HH:MM
  count: number;
}

export function getTodayQpsByMinute(): QpsBucket[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  // strftime('%H:%M', ..., 'unixepoch', 'localtime'): SQLite 把 unix ms 转成本地时间
  // 的「时:分」串. 一笔请求一行, GROUP BY 同一分钟得到该分钟总请求数.
  const rows = sqlite
    .prepare<
      [number],
      { minute: string; count: number }
    >(
      `SELECT strftime('%H:%M', created_at / 1000, 'unixepoch', 'localtime') AS minute,
              COUNT(*) AS count
         FROM usage_records
        WHERE created_at >= ?
        GROUP BY minute
        ORDER BY minute ASC`,
    )
    .all(since);
  return rows;
}

// ============================================================
// 2. 今日花费 (按 user / 按 model)
// ============================================================

export interface CostByDimension {
  dimension: string;
  totalCostMicro: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export function getTodayCostByUser(): CostByDimension[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  return sqlite
    .prepare<
      [number],
      {
        dimension: string;
        totalCostMicro: number;
        totalRequests: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
      }
    >(
      `SELECT 'user:' || user_id AS dimension,
              SUM(final_cost) AS totalCostMicro,
              COUNT(*) AS totalRequests,
              SUM(prompt_tokens) AS totalPromptTokens,
              SUM(completion_tokens) AS totalCompletionTokens
         FROM usage_records
        WHERE created_at >= ? AND status IN ('finalized','canceled','partial')
        GROUP BY user_id
        ORDER BY totalCostMicro DESC
        LIMIT 20`,
    )
    .all(since);
}

export function getTodayCostByModel(): CostByDimension[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  return sqlite
    .prepare<
      [number],
      {
        dimension: string;
        totalCostMicro: number;
        totalRequests: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
      }
    >(
      `SELECT model AS dimension,
              SUM(final_cost) AS totalCostMicro,
              COUNT(*) AS totalRequests,
              SUM(prompt_tokens) AS totalPromptTokens,
              SUM(completion_tokens) AS totalCompletionTokens
         FROM usage_records
        WHERE created_at >= ? AND status IN ('finalized','canceled','partial')
        GROUP BY model
        ORDER BY totalCostMicro DESC
        LIMIT 20`,
    )
    .all(since);
}

// ============================================================
// 3. Top 10 Key 用量
// ============================================================

export interface KeyUsageRow {
  keyId: number;
  totalRequests: number;
  totalCostMicro: number;
  totalTokens: number;
  errorRequests: number;
}

export function getTopKeysToday(limit = 10): KeyUsageRow[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  return sqlite
    .prepare<
      [number, number],
      {
        keyId: number;
        totalRequests: number;
        totalCostMicro: number;
        totalTokens: number;
        errorRequests: number;
      }
    >(
      `SELECT key_id AS keyId,
              COUNT(*) AS totalRequests,
              SUM(final_cost) AS totalCostMicro,
              SUM(prompt_tokens + completion_tokens) AS totalTokens,
              SUM(CASE WHEN status IN ('refunded','failed') THEN 1 ELSE 0 END) AS errorRequests
         FROM usage_records
        WHERE created_at >= ?
        GROUP BY key_id
        ORDER BY totalCostMicro DESC
        LIMIT ?`,
    )
    .all(since, limit);
}

// ============================================================
// 4. Channel 健康状态 (status + 今日请求量 + 错误率 + P95 上游延迟)
// ============================================================

export interface ChannelHealthRow {
  channelId: number;
  name: string;
  provider: string;
  status: string;
  disabledReason: string | null;
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
  avgUpstreamLatencyMs: number | null;
}

export function getChannelHealthToday(): ChannelHealthRow[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  // LEFT JOIN 让没有今日请求的 channel 也出现在表里 (= 0 流量, 但运营要看到它存在).
  // AVG(upstream_latency_ms) 在 NULL 上自动忽略 NULL, 单 channel 全 NULL 返 NULL.
  return sqlite
    .prepare<
      [number],
      {
        channelId: number;
        name: string;
        provider: string;
        status: string;
        disabledReason: string | null;
        totalRequests: number;
        errorRequests: number;
        avgUpstreamLatencyMs: number | null;
      }
    >(
      `SELECT c.id AS channelId,
              c.name AS name,
              c.provider AS provider,
              c.status AS status,
              c.disabled_reason AS disabledReason,
              COUNT(u.id) AS totalRequests,
              SUM(CASE WHEN u.status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests,
              AVG(u.upstream_latency_ms) AS avgUpstreamLatencyMs
         FROM channels c
         LEFT JOIN usage_records u
           ON u.channel_id = c.id AND u.created_at >= ?
        GROUP BY c.id, c.name, c.provider, c.status, c.disabled_reason
        ORDER BY c.priority DESC, c.id ASC`,
    )
    .all(since)
    .map((r) => ({
      ...r,
      errorRate: r.totalRequests > 0 ? r.errorRequests / r.totalRequests : 0,
    }));
}

// ============================================================
// 5. 错误率 Top 5 模型 (按 model 算「失败 / 总数」, 阈值: 今日至少 5 笔)
// ============================================================

export interface ModelErrorRow {
  model: string;
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
}

export function getTopErrorModelsToday(limit = 5): ModelErrorRow[] {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  return sqlite
    .prepare<
      [number, number],
      {
        model: string;
        totalRequests: number;
        errorRequests: number;
      }
    >(
      `SELECT model,
              COUNT(*) AS totalRequests,
              SUM(CASE WHEN status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests
         FROM usage_records
        WHERE created_at >= ?
        GROUP BY model
       HAVING totalRequests >= 5
        ORDER BY (1.0 * errorRequests / totalRequests) DESC, totalRequests DESC
        LIMIT ?`,
    )
    .all(since, limit)
    .map((r) => ({
      ...r,
      errorRate: r.totalRequests > 0 ? r.errorRequests / r.totalRequests : 0,
    }));
}

// ============================================================
// 6. 全局摘要 (今日总请求数 / 总花费 / 总 token / 错误数)
// ============================================================

export interface DashboardSummary {
  windowLabel: string;
  totalRequests: number;
  totalCostMicro: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  errorRequests: number;
  avgTotalLatencyMs: number | null;
}

export function getTodaySummary(): DashboardSummary {
  const sqlite = getRawSqlite();
  const since = todayStartMs();
  const row = sqlite
    .prepare<
      [number],
      {
        totalRequests: number;
        totalCostMicro: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
        errorRequests: number;
        avgTotalLatencyMs: number | null;
      }
    >(
      `SELECT COUNT(*) AS totalRequests,
              SUM(final_cost) AS totalCostMicro,
              SUM(prompt_tokens) AS totalPromptTokens,
              SUM(completion_tokens) AS totalCompletionTokens,
              SUM(CASE WHEN status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests,
              AVG(upstream_latency_ms) AS avgTotalLatencyMs
         FROM usage_records
        WHERE created_at >= ?`,
    )
    .get(since) ?? {
    totalRequests: 0,
    totalCostMicro: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    errorRequests: 0,
    avgTotalLatencyMs: null,
  };
  return { windowLabel: '今日', ...row };
}

export function getLastNDaysSummary(days: number): DashboardSummary {
  const sqlite = getRawSqlite();
  const since = daysAgoStartMs(days);
  const row = sqlite
    .prepare<
      [number],
      {
        totalRequests: number;
        totalCostMicro: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
        errorRequests: number;
        avgTotalLatencyMs: number | null;
      }
    >(
      `SELECT COUNT(*) AS totalRequests,
              SUM(final_cost) AS totalCostMicro,
              SUM(prompt_tokens) AS totalPromptTokens,
              SUM(completion_tokens) AS totalCompletionTokens,
              SUM(CASE WHEN status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests,
              AVG(upstream_latency_ms) AS avgTotalLatencyMs
         FROM usage_records
        WHERE created_at >= ?`,
    )
    .get(since) ?? {
    totalRequests: 0,
    totalCostMicro: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    errorRequests: 0,
    avgTotalLatencyMs: null,
  };
  return { windowLabel: `近 ${days} 天`, ...row };
}
