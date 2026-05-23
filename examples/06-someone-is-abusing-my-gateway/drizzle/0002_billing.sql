-- Drizzle Migration 0002: v0.5 计费链路
--
-- 变更点:
--   1. users 表加 balance_micro / user_multiplier 两列;
--   2. 新增 prices 表 (model × provider × 时间窗的单价);
--   3. 新增 usage_records 表 (每次请求的账单).
--
-- 注意 SQLite 的 ALTER TABLE 只能 ADD COLUMN, 不能 ALTER COLUMN 或 DROP COLUMN.
-- 这是为什么 0001 中已经存在的列不能再去改, 只能新加.

-- ----- users: 增列 -----
ALTER TABLE `users` ADD COLUMN `balance_micro` integer NOT NULL DEFAULT 0;
ALTER TABLE `users` ADD COLUMN `user_multiplier` integer NOT NULL DEFAULT 1000;

-- ----- prices -----
CREATE TABLE `prices` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `model` text NOT NULL,
    `provider` text NOT NULL,
    `input_price_micro_per_1m` integer NOT NULL,
    `output_price_micro_per_1m` integer NOT NULL,
    `model_multiplier` integer NOT NULL DEFAULT 1000,
    `effective_from` integer NOT NULL,
    `effective_to` integer,
    `created_at` integer NOT NULL
);
CREATE INDEX `prices_model_provider_idx` ON `prices` (`model`, `provider`);

-- ----- usage_records -----
CREATE TABLE `usage_records` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `trace_id` text NOT NULL,
    `user_id` integer NOT NULL,
    `org_id` integer NOT NULL,
    `key_id` integer NOT NULL,
    `model` text NOT NULL,
    `provider` text NOT NULL,
    `prompt_tokens` integer NOT NULL DEFAULT 0,
    `completion_tokens` integer NOT NULL DEFAULT 0,
    `estimated_prompt_tokens` integer NOT NULL DEFAULT 0,
    `prompt_cost` integer NOT NULL DEFAULT 0,
    `completion_cost` integer NOT NULL DEFAULT 0,
    `final_cost` integer NOT NULL DEFAULT 0,
    `pre_reserved_cost` integer NOT NULL DEFAULT 0,
    `multiplier_snapshot` integer NOT NULL DEFAULT 1000000000,
    `status` text NOT NULL DEFAULT 'reserved',
    `is_stream` integer NOT NULL DEFAULT 0,
    `error_message` text,
    `created_at` integer NOT NULL,
    `finalized_at` integer
);
CREATE UNIQUE INDEX `usage_records_trace_idx` ON `usage_records` (`trace_id`);
CREATE INDEX `usage_records_user_time_idx` ON `usage_records` (`user_id`, `created_at`);
CREATE INDEX `usage_records_key_time_idx` ON `usage_records` (`key_id`, `created_at`);
CREATE INDEX `usage_records_model_time_idx` ON `usage_records` (`model`, `created_at`);
CREATE INDEX `usage_records_status_idx` ON `usage_records` (`status`);
