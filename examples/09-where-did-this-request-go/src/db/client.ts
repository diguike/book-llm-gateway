// SQLite 连接 + Drizzle 实例
//
// 为什么选 better-sqlite3:
//   - 同步 API, 代码读起来不需要到处 await, 教学价值高 (research/ts-stack-selection.md);
//   - native module, 单文件数据库, 零额外服务依赖, 读者 npm install 完即可跑;
//   - Drizzle 对它有一等支持 (drizzle-orm/better-sqlite3).
//
// 单例模式: 整个进程共享一个 Database 与 Drizzle 实例.
// SQLite 默认是单写多读, better-sqlite3 自带串行化, 不会出并发写冲突.

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as schema from './schema.js';

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  _sqlite = openSqlite();
  _db = drizzle(_sqlite, { schema });
  return _db;
}

/** 直接拿到底层 better-sqlite3 实例, 用于跑原始 SQL (例如 migration 文件) */
export function getRawSqlite(): Database.Database {
  if (_sqlite) return _sqlite;
  _sqlite = openSqlite();
  _db = drizzle(_sqlite, { schema });
  return _sqlite;
}

function openSqlite(): Database.Database {
  const url = process.env.DATABASE_URL ?? './data/gateway.db';
  // 相对路径基于当前工作目录解析; 启动前自动创建父目录, 省去读者 mkdir 一步.
  const absPath = resolve(process.cwd(), url);
  mkdirSync(dirname(absPath), { recursive: true });
  const sqlite = new Database(absPath);
  // WAL 模式: 写不阻塞读. 单进程网关也能拿到性能收益.
  sqlite.pragma('journal_mode = WAL');
  // 外键强制开启 (SQLite 默认关闭, 不开就形同虚设)
  sqlite.pragma('foreign_keys = ON');
  return sqlite;
}

export { schema };
