-- Drizzle Migration 0006: v0.10 成本优化字段
--
-- 变更点:
--   1. channels.cost_priority (integer, default 100) -- 成本路由档位.
--      越小越便宜, 主路径在选 channel 时按这个字段升序排. 同优先级再走 weighted 权重.
--      与 channels.priority (高/低可用性档位) 互补: priority 解决「兜底」, cost_priority
--      解决「省钱」. 默认 100, 不影响 v0.9 行为.
--
--   2. channels.supports_batch (integer/boolean, default 0) -- 是否支持 batch API.
--      priority=low 的请求会被路由到 supports_batch=1 的 channel, 走异步通道吃 50% 折扣.
--
--   3. prices.cache_input_price_micro_per_1m (integer, nullable) -- 缓存命中时的 input 单价.
--      Anthropic cache read 是 base × 0.1, OpenAI cache read 是 base × 0.5,
--      Gemini cache read 是 base × 0.1, DeepSeek cache hit 约 base × 0.1.
--      null 时回退到 inputPriceMicroPer1M (无缓存折扣).
--      官方文档 (2026 年 5 月对外公布价):
--        - Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
--        - OpenAI prompt caching:    https://openai.com/index/api-prompt-caching/
--        - DeepSeek context caching: https://api-docs.deepseek.com/news/news0802
--        - Gemini pricing:           https://ai.google.dev/gemini-api/docs/pricing
--
--   4. prices.batch_input_price_micro_per_1m (integer, nullable) -- batch API 通道的 input 单价.
--      OpenAI batch 文档: https://developers.openai.com/api/docs/guides/batch
--      typically = base × 0.5. null 时不支持 batch.
--
--   5. prices.batch_output_price_micro_per_1m (integer, nullable) -- batch API 通道的 output 单价.
--
--   6. usage_records.cached_input_tokens (integer, default 0) -- 上游 usage 里返回的
--      缓存命中 token 数. 计费时这部分按 cache 单价算, 剩余按 input 单价算.
--      字段命名向 Anthropic / OpenAI 双方对齐:
--        Anthropic: usage.cache_read_input_tokens
--        OpenAI:    usage.prompt_tokens_details.cached_tokens
--
--   7. usage_records.cache_write_tokens (integer, default 0) -- 缓存写入 token 数 (Anthropic only).
--      Anthropic 5min cache write 是 base × 1.25, 1h cache write 是 base × 2.
--      本章 v0.10 计费简化: cache_write 按 input 单价计 (不加价), 给读者留扩展点.
--
--   8. usage_records.batch_mode (integer/boolean, default 0) -- 这一笔是否走 batch 通道.
--      看板按此字段过滤「同步实时 vs 异步 batch」的实际成本对比.

ALTER TABLE `channels` ADD COLUMN `cost_priority` integer NOT NULL DEFAULT 100;
ALTER TABLE `channels` ADD COLUMN `supports_batch` integer NOT NULL DEFAULT 0;

ALTER TABLE `prices` ADD COLUMN `cache_input_price_micro_per_1m` integer;
ALTER TABLE `prices` ADD COLUMN `batch_input_price_micro_per_1m` integer;
ALTER TABLE `prices` ADD COLUMN `batch_output_price_micro_per_1m` integer;

ALTER TABLE `usage_records` ADD COLUMN `cached_input_tokens` integer NOT NULL DEFAULT 0;
ALTER TABLE `usage_records` ADD COLUMN `cache_write_tokens` integer NOT NULL DEFAULT 0;
ALTER TABLE `usage_records` ADD COLUMN `batch_mode` integer NOT NULL DEFAULT 0;

-- 成本路由热路径要按 cost_priority 升序选, 加一个组合索引
CREATE INDEX IF NOT EXISTS `channels_status_cost_idx`
  ON `channels` (`status`, `cost_priority`);
