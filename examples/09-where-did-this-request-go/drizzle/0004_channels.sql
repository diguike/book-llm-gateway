-- Drizzle Migration 0004: v0.8 渠道池 + 故障转移
--
-- 变更点:
--   1. 新增 channels 表: 一行 = 一个上游渠道 (provider + key + base_url + 倍率 + priority + weight + status).
--      同一个 model 背后可挂多个 channel (同 provider 多 Key 或不同 provider 等价模型).
--   2. 新增 abilities 表: (group, model, channel_id, priority) 联合主键的反范式索引表.
--      每次 channel CRUD 时由代码同步刷新本表, 把笛卡儿积展开 -- 高频选渠道场景下
--      避免对 channels.enabled_models 这种大字符串做 LIKE 扫描.
--
-- 设计参考:
--   - one-api model/channel.go::Channel:        渠道基础结构 (id/key/status/priority/weight/models/group)
--   - one-api model/ability.go::Ability:        三元组反范式索引表
--   - one-api model/ability.go::AddAbilities:   把 (group × model) 笛卡儿积写进 abilities
--   - one-api model/cache.go::CacheGetRandomSatisfiedChannel: 启动时把 abilities 全量加载到内存
--   - one-api monitor/manage.go::ShouldDisableChannel: 错误分类决定是否自动禁用
--
-- channels.status 三态:
--   - active   : 正常, 参与轮询
--   - disabled : 被错误分类器或运营手动禁用, 不参与轮询; health-checker 会定期来探活
--   - probing  : health-checker 正在做探针请求, 中间过渡态 (不参与轮询直到结果出来)
--
-- channels.api_key 字段加密 / 哈希存储:
--   v0.8 简化为「明文存」, 仅用 NOT NULL 标注. 生产环境应当用 AES-GCM + 一把 master key
--   (类似 Vault sealed/unsealed 机制). 这条边角在 Ch12 上线整合时统一处理, v0.8 范围不展开.

CREATE TABLE `channels` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,

  -- 人类可读的名字, 用于日志与 admin 后台 (例: "OpenAI 主号" / "DeepSeek 国内分号 1")
  `name` text NOT NULL,

  -- provider 标识. 决定使用哪个 ProviderAdaptor: openai / deepseek / anthropic / mock
  `provider` text NOT NULL,

  -- 上游真实 API Key. 注: 教学场景明文存; 生产环境应加密.
  `api_key` text NOT NULL,

  -- 上游 base URL. 不写 /v1 路径, adaptor 自己拼.
  `base_url` text NOT NULL,

  -- 该渠道支持的模型清单 (JSON 数组字符串). 例: ["gpt-4o-mini","gpt-4o"]
  -- CRUD 时由代码 parse 后展开到 abilities 表; 运行时选渠道不查这一列.
  `enabled_models` text NOT NULL DEFAULT '[]',

  -- 用户分组. 简化版只支持单个 group (one-api 用逗号分隔多组, v0.8 不上这套).
  `group_name` text NOT NULL DEFAULT 'default',

  -- 优先级, 越大越优先. 同 model 下先选最大 priority 的 channel.
  -- 故障转移把它当成层级, 同层全挂之后才跳到下一层.
  `priority` integer NOT NULL DEFAULT 0,

  -- 同优先级内的加权随机权重. 0 = 不参与, > 0 按累加权重命中.
  `weight` integer NOT NULL DEFAULT 1,

  -- 渠道倍率 (千分位). 1000 = 1.0x. 与 user × model 倍率三合一, 计费快照里独立保留这一档.
  `channel_multiplier` integer NOT NULL DEFAULT 1000,

  -- 状态机: active / disabled / probing
  `status` text NOT NULL DEFAULT 'active',

  -- 上次被禁用的时间 (unix ms). 用于 health-checker 决定多久后探活.
  `disabled_at` integer,

  -- 禁用原因 (错误分类器写入: upstream_401 / upstream_429 / upstream_5xx_streak ...).
  `disabled_reason` text,

  -- 最近一次探活时间 (unix ms). 控制最小探活间隔, 防止心跳风暴.
  `last_probed_at` integer,

  `created_at` integer NOT NULL
);

CREATE INDEX `channels_status_idx` ON `channels` (`status`);
CREATE INDEX `channels_provider_idx` ON `channels` (`provider`);

-- ============================================================
-- abilities: (group, model, channel_id, priority) 反范式索引表
-- ============================================================
--
-- 为什么需要这张表 (而不是直接扫 channels):
--   1. enabled_models 是 JSON 数组字符串, 用 LIKE '%model%' 查会误命中
--      (例: 找 gpt-4 会同时命中 gpt-4o / gpt-4o-mini / gpt-4-turbo);
--   2. 选渠道是热路径, 每个请求都跑一次. 范式化的多对多 (channels JOIN channel_models)
--      虽然语义正确, 但 JOIN + 排序在高 QPS 下会变成 DB 瓶颈;
--   3. 反范式后只查一张表, (group, model) 复合索引一次定位, ORDER BY priority DESC
--      取头部即可. 对 SQLite / PostgreSQL / MySQL 都是 O(log N) 查询.
--
-- 每个 channel 的 (group × model) 笛卡儿积都展开成 abilities 行:
--   channel 1 group=default models=["gpt-4o","gpt-4o-mini"] priority=10
--   -> abilities (default, gpt-4o,      1, 10)
--      abilities (default, gpt-4o-mini, 1, 10)
--
-- enabled = false 的行不参与选渠道. channel 被禁用时, 不删 ability 行,
-- 只把 enabled 改成 false; 恢复时再翻回 true, 减少 DB 写放大.

CREATE TABLE `abilities` (
  `group_name` text NOT NULL,
  `model` text NOT NULL,
  `channel_id` integer NOT NULL,

  -- 冗余 priority, 与 channel 行保持同步. 反范式的代价就是双写,
  -- 但读路径少一次 JOIN, 整体收益正.
  `priority` integer NOT NULL DEFAULT 0,

  -- 冗余 weight, 同上.
  `weight` integer NOT NULL DEFAULT 1,

  -- ability 级别的 enabled 开关. channel.status != 'active' 时, 这一行的 enabled 置 false.
  -- 选渠道时只看本字段, 不再回查 channels 表.
  `enabled` integer NOT NULL DEFAULT 1,

  PRIMARY KEY (`group_name`, `model`, `channel_id`)
);

-- 选渠道的核心查询: WHERE group=? AND model=? AND enabled=1 ORDER BY priority DESC
CREATE INDEX `abilities_lookup_idx` ON `abilities` (`group_name`, `model`, `enabled`, `priority`);
