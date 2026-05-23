-- Drizzle Migration 0003: v0.6 限流 + 月度配额
--
-- 变更点:
--   1. keys 表加 qps_limit / tpm_limit / monthly_quota_micro / monthly_used_micro /
--      quota_reset_at 五列, 用于按 Key 维度配置限流与月度配额上限.
--   2. 不动 users / orgs / usage_records / prices 表 - 限流是新维度,
--      复用 Ch5 已有的两阶段计费链路即可.
--
-- 字段说明:
--   qps_limit              : 每秒最多请求数. 0 = 不限.
--   tpm_limit              : 每分钟最多 token 数 (input + output 总和). 0 = 不限.
--   monthly_quota_micro    : 月度配额上限 (微元). 0 = 不限. 超过返 402.
--   monthly_used_micro     : 当月累计已用金额 (微元). postConsume 时累加.
--   quota_reset_at         : 上次重置月度累计的 unix ms. 跨月时归零.
--
-- SQLite ALTER TABLE 只能 ADD COLUMN, 这套表只能新增列, 不能改老列;
-- 老 keys 行 (Ch4 / Ch5 期间签的) 默认 0 = 不限制, 不破坏既有调用.

ALTER TABLE `keys` ADD COLUMN `qps_limit` integer NOT NULL DEFAULT 0;
ALTER TABLE `keys` ADD COLUMN `tpm_limit` integer NOT NULL DEFAULT 0;
ALTER TABLE `keys` ADD COLUMN `monthly_quota_micro` integer NOT NULL DEFAULT 0;
ALTER TABLE `keys` ADD COLUMN `monthly_used_micro` integer NOT NULL DEFAULT 0;
ALTER TABLE `keys` ADD COLUMN `quota_reset_at` integer NOT NULL DEFAULT 0;
