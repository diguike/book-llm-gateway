-- Drizzle Migration 0001: 三层数据模型 (orgs / users / keys) 首次落库
--
-- 命名规则: drizzle/<4 位编号>_<描述>.sql
--   - 后续章节加新表时编号递增 (Ch5 = 0002_*, Ch6 = 0003_*, ...);
--   - migrate.ts 按编号顺序应用, 已应用的记录在 __drizzle_migrations 表中, 不重复执行;
--   - 读者改 schema.ts 后用 `npm run drizzle:generate` 生成下一份, 不要手改已发布的 migration.

CREATE TABLE `orgs` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `name` text NOT NULL,
    `disabled_at` integer,
    `created_at` integer NOT NULL
);

CREATE TABLE `users` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `org_id` integer NOT NULL,
    `name` text NOT NULL,
    `email` text,
    `disabled_at` integer,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `users_org_email_idx` ON `users` (`org_id`, `email`);

CREATE TABLE `keys` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `user_id` integer NOT NULL,
    `key_hash` text NOT NULL,
    `key_preview` text NOT NULL,
    `name` text NOT NULL,
    `scopes` text DEFAULT 'chat' NOT NULL,
    `expires_at` integer,
    `disabled_at` integer,
    `last_used_at` integer,
    `created_at` integer NOT NULL,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `keys_key_hash_idx` ON `keys` (`key_hash`);
CREATE INDEX `keys_user_idx` ON `keys` (`user_id`);
