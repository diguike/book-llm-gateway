-- Drizzle Migration 0005: v0.9 可观测性
--
-- 变更点:
--   1. usage_records 加 channel_id (本次请求实际命中的 channel) -- v0.8 渠道切换是日志里
--      才能看到的, 入库表没记. 反查时无法回答「这一笔账消耗了哪个 channel」;
--   2. usage_records 加 upstream_latency_ms (上游 fetch 起到 first byte / parse 完成) --
--      看板要按 channel 算 P50/P95 延迟, 必须有这一列;
--   3. usage_records 加 attempted_channels (JSON 数组字符串) -- 故障转移时, 一次请求
--      可能试过 [2, 1], 看板的「Channel 健康度」需要这个反范式索引来算每个 channel 的
--      总尝试次数与命中次数. 不放进 channels 表是为了避免高频写入 channels 主表.
--
-- usage_records.trace_id 在 0002 已经创建并加了 UNIQUE 索引, 本章不再动它.
--
-- 注: usage_records 的列已经够多 (16 列), v0.9 之后单条 row 写入大约 200 字节,
-- 一天 100 万笔请求 200MB, SQLite 完全扛得住. 教学场景不引入冷热分离 / 分区表.
-- 真要做大规模日志聚合, Helicone 的方案是单独把每条 request 的 prompt / completion
-- 全文落 ClickHouse, 走列式压缩 + 倒排索引; 本书 SQLite 路线只关心账单与统计字段,
-- 不存全文.

ALTER TABLE `usage_records` ADD COLUMN `channel_id` integer;
ALTER TABLE `usage_records` ADD COLUMN `upstream_latency_ms` integer;
ALTER TABLE `usage_records` ADD COLUMN `attempted_channels` text;

-- 看板的「Channel 健康度」聚合: GROUP BY channel_id, 必须建索引
CREATE INDEX IF NOT EXISTS `usage_records_channel_time_idx`
  ON `usage_records` (`channel_id`, `created_at`);
