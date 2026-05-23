-- Drizzle Migration 0008: v1.0 release marker
--
-- 这一份不增加任何业务表结构变更. 它只在 __drizzle_migrations 里写一行，
-- 让运维 / 看板能直接 SELECT MAX(filename) 出来确认「数据库是否到达 v1.0 schema」.
--
-- 为什么不把 0001-0007 合并成一份「初始化 schema」?
--   1. 已经按 v0.4 ~ v0.11 跟着读到这里的读者, 数据库里已经有 0001-0007 的应用记录,
--      合并后他们的 __drizzle_migrations 与新 schema 不一致, 升级路径断掉.
--   2. 教学价值: 7 份 migration 是「从空网关到 v0.11」的演化史, 每一份对应一章的
--      新增功能, 保留对照关系比合并更有用.
--   3. 工程实践: 真实生产中 migration 不应当被「合并」, 它是不可变的历史. 即便冗长,
--      也要按时间线一份一份保留.
--
-- 如果是全新部署 (fresh install), npm run migrate 会按 0001-0008 顺序一次跑完,
-- 体感上就是「一份初始化 schema」, 与合并的效果等价.

-- 这一行用 COMMENT 表达, 没有副作用. SQLite 不支持纯 COMMENT, 用一个无害的 SELECT 占位.
SELECT 'v1.0_release_marker' AS version;
