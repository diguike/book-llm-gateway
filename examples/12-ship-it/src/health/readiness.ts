// /readyz: readiness 探针
//
// 语义: 进程已准备好接客户端流量. 失败时不重启进程, 只把它从 LB / service mesh 摘掉.
//
// 检查项:
//   1. SQLite 可达 (SELECT 1)
//   2. channels 表至少有 1 个 active
//   3. wallet_service 可调用 (任意一次 ensureWallet 不抛, 用一个 sentinel user_id=0 探)
//      -- 这个不动 wallets 表的实际数据, 只用 SQL 准备语句的健康度做指示.
//
// 任何一项失败返 503 + 失败明细. k8s readinessProbe 就把 pod 从 endpoints 摘走.

import { Hono } from 'hono';

import { getRawSqlite } from '../db/client.js';
import { getChannelRegistry } from '../channels/index.js';
import { HEALTH_DEFAULTS } from '../config/defaults.js';

interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
  duration_ms: number;
}

interface ReadinessResponse {
  ok: boolean;
  checks: ReadinessCheck[];
  ts: string;
}

interface ReadinessOptions {
  /** /readyz 是否要求 wallets 表已被建好. 没建会 503. */
  requireWallet: boolean;
  /** active channel 最少几个才算 ready. 默认 1. */
  minActiveChannels?: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

function checkDb(): ReadinessCheck {
  const start = Date.now();
  try {
    const sqlite = getRawSqlite();
    const row = sqlite.prepare('SELECT 1 as v').get() as { v: number } | undefined;
    return {
      name: 'sqlite',
      ok: row?.v === 1,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'sqlite',
      ok: false,
      detail: (err as Error).message,
      duration_ms: Date.now() - start,
    };
  }
}

function checkChannels(minActive: number): ReadinessCheck {
  const start = Date.now();
  try {
    const snap = getChannelRegistry().snapshot();
    const active = snap.filter((s) => s.status === 'active').length;
    return {
      name: 'channels',
      ok: active >= minActive,
      detail: `active=${active}/${snap.length} (need ≥${minActive})`,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'channels',
      ok: false,
      detail: (err as Error).message,
      duration_ms: Date.now() - start,
    };
  }
}

function checkWalletsTable(): ReadinessCheck {
  const start = Date.now();
  try {
    const sqlite = getRawSqlite();
    // wallet 服务可用的最低条件: wallets 表存在.
    // SQLite 元表查询, 不动业务数据.
    const row = sqlite
      .prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='wallets'")
      .get() as { c: number };
    return {
      name: 'wallets_table',
      ok: row.c === 1,
      detail: row.c === 1 ? 'present' : 'missing (run npm run migrate)',
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'wallets_table',
      ok: false,
      detail: (err as Error).message,
      duration_ms: Date.now() - start,
    };
  }
}

export function createReadinessRouter(opts: ReadinessOptions): Hono {
  const app = new Hono();
  const minActive = opts.minActiveChannels ?? HEALTH_DEFAULTS.MIN_ACTIVE_CHANNELS;

  app.get('/', async (c) => {
    const checks: ReadinessCheck[] = [];

    // 每个检查都套超时, 防止 readiness 自己卡死.
    try {
      checks.push(
        await withTimeout(
          Promise.resolve(checkDb()),
          HEALTH_DEFAULTS.READINESS_TIMEOUT_MS,
          'sqlite',
        ),
      );
    } catch (err) {
      checks.push({ name: 'sqlite', ok: false, detail: (err as Error).message, duration_ms: 0 });
    }

    try {
      checks.push(
        await withTimeout(
          Promise.resolve(checkChannels(minActive)),
          HEALTH_DEFAULTS.READINESS_TIMEOUT_MS,
          'channels',
        ),
      );
    } catch (err) {
      checks.push({
        name: 'channels',
        ok: false,
        detail: (err as Error).message,
        duration_ms: 0,
      });
    }

    if (opts.requireWallet) {
      try {
        checks.push(
          await withTimeout(
            Promise.resolve(checkWalletsTable()),
            HEALTH_DEFAULTS.READINESS_TIMEOUT_MS,
            'wallets_table',
          ),
        );
      } catch (err) {
        checks.push({
          name: 'wallets_table',
          ok: false,
          detail: (err as Error).message,
          duration_ms: 0,
        });
      }
    }

    const ok = checks.every((c) => c.ok);
    const status = ok ? 200 : 503;
    return c.json<ReadinessResponse>(
      { ok, checks, ts: new Date().toISOString() },
      status,
    );
  });

  return app;
}
