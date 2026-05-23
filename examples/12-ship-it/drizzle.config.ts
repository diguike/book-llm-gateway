// Drizzle Kit 配置: 用于从 schema.ts 生成 SQL migration 文件
//
// 命令:
//   npm run drizzle:generate   -> 根据 schema.ts 生成新的 drizzle/000X_xxx.sql
//
// 注: 本章已经手写了一份 drizzle/0001_init.sql 作为「首份 migration」,
// 读者无需再跑生成命令就能启动. 后续章节 (Ch5+) 加新表时, 再用 generate.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? './data/gateway.db',
  },
});
