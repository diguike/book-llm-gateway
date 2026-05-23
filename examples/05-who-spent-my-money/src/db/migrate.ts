// 启动时自动跑迁移
//
// 简化实现 (够 Ch4 用即可):
//   - 维护一张 __drizzle_migrations 表, 记录已应用的文件名;
//   - 扫描 drizzle/ 目录下所有 .sql 文件, 按文件名排序;
//   - 未应用的文件按顺序执行, 每个文件包在事务里;
//   - 已应用的文件跳过.
//
// 与 drizzle-kit 自带的 migrator 行为一致, 但不依赖它的内部 hash 比对,
// 教学场景下文件名顺序就够用了. 生产环境读者可以替换成:
//   import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
//   migrate(db, { migrationsFolder: './drizzle' });

import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getRawSqlite } from './client.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';
const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle');

export function runMigrations(): { applied: string[]; skipped: string[] } {
  const sqlite = getRawSqlite();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite
    .prepare<[], { filename: string }>(`SELECT filename FROM ${MIGRATIONS_TABLE}`)
    .all();
  const appliedSet = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  const insertStmt = sqlite.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (filename, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // 一份 migration 文件可能含多条语句; better-sqlite3 的 exec 支持 ;
    // 分隔, 同时把整个 exec 放进事务保证原子.
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      insertStmt.run(file, Date.now());
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}

// 允许 `npm run migrate` 单独运行
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migrate.ts') ||
  process.argv[1]?.endsWith('migrate.js');

if (invokedDirectly) {
  const result = runMigrations();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
}
