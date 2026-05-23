---
title: 附录 B 与 one-api / Portkey 的对照表
feishu_url: "https://www.feishu.cn/wiki/VE1Cw27ZEih3cjk5lEycHc2xndr"
last_synced: "2026-05-16T18:29:37"
---

## 适合谁读这个附录

如果你已经在用 one-api / new-api（Go 阵营事实标准），或者 Portkey gateway（TS 阵营最完整的开源实现），本书的实现思路对你来说很多概念是熟悉的，区别只是用 TS 重写了一遍并补齐了缺失的部分。这个附录给出三家在「同一个概念」上的实现位置与差异，帮助你跳过你已经会的部分，只挑你想看的章节读。

附录的结构：先用一两段话讲清三家的定位，再一张大表按概念列出三家的实现路径与本书的对应章节，最后单独说明在哪些场景下值得把本书的实现「翻译回」 Go 版本，以及在哪些场景下 Portkey 用户值得借鉴本书的设计。最后诚实交代本书没做的部分。

## 三家定位简述

**one-api（Go）**：中文社区事实标准。最早把「以 OpenAI 协议为前端 ABI、上游差异塞进 Adaptor」这件事跑通，是对外卖 token 类中转站的母体。Channel + Ability + Token 的表设计被几乎所有后来者抄走。new-api（Calcium-Ion fork）在它之上加了多 Key 单渠道、Claude 原生入站、表达式计费、Channel Affinity 几项增强，更接近商业网关形态。

**Portkey gateway v1.15.2（TS + Hono）**：TS 阵营最完整的开源 AI Gateway。单仓库、跨 runtime（Node / Bun / Cloudflare Workers）、78 个 Provider 覆盖、声明式 provider 配置 + 通用 transform 引擎。强项是协议适配与多策略路由（fallback / loadbalance / conditional）；弱项是缺计费、限流、API Key 管理、用量持久化（这些它假设你接 Helicone 或自己接）。

**本书 TS Mini Gateway**：用 TS + Hono + better-sqlite3 + Drizzle 重写一个最小但完整的网关，目标是覆盖**企业内部基建**与**对外卖 token**两种场景的入门工程师。性能基线低于 Go（单进程 + SQLite），但在教材场景下零外部依赖即可跑通。设计上从 one-api 抄了 Channel / Ability / 两阶段计费这些被时间验证过的模式，从 Portkey 抄了 Hono 路由 + 声明式 Adaptor 风格，自己补齐了 Key 哈希存储、TPM 限流、反向取消、SSR 看板、PaymentAdaptor、模型指纹检测这些两家都没覆盖完整的部分。

## 概念对照表

| 概念 | one-api 实现 | Portkey v1.15.2 实现 | 本书章节 / 文件 | 关键差异 |
|------|-------------|---------------------|----------------|---------|
| Provider 抽象 | `relay/adaptor/interface.go`（9 方法接口） | `src/providers/<name>/api.ts` 配置 + `chatComplete.ts` transform | Ch2 `src/adaptors/base.ts` | 本书用 5 方法精简版（init/route/convertReq/doRequest/convertResp） |
| 协议入站类型 | OpenAI / Claude / Gemini 多套（new-api） | 主 OpenAI 兼容 + `/v1/messages` | Ch3 主 OpenAI + 旁路 `/v1/messages` | 本书走 OpenAI 优先 + 单独留 Anthropic 直通 |
| Anthropic 适配器 | `relay/adaptor/anthropic/main.go::ConvertRequest` | `src/providers/anthropic/chatComplete.ts`（声明式 config） | Ch3 `src/adaptors/anthropic.ts` | 6 处差异全覆盖；双向翻译 |
| 流式归一化 | `relay/adaptor/anthropic/main.go::StreamHandler`（line 249-336） | `src/providers/anthropic/chatComplete.ts` 内 stream chunk transformer（line 640+ @v1.15.2） | Ch7 `src/streaming/anthropic-events.ts` | Ch7 复用 Ch3 的归一化器 |
| 内部 API Key | `model/token.go` 明文存储 + `sk-` 前缀 | 无内置（依赖平台账号） | Ch4 `src/auth/key.ts` SHA-256 哈希存储 | 本书更安全：明文只在创建时返回一次 |
| 鉴权 middleware | `middleware/auth.go::TokenAuth` | `src/middlewares/requestValidator/index.ts` | Ch4 `src/auth/middleware.ts`（admin / gateway 双 mw） | |
| 计费两阶段 | `relay/billing/billing.go` + `relay/controller/helper.go::preConsume/postConsume` | 无（依赖外部如 Helicone） | Ch5 `src/billing/calculator.ts` preConsume → reserved → refund | 本书直接借鉴 one-api |
| 倍率体系 | `relay/billing/ratio/model.go` 硬编码大字典 | 配置驱动（headers 透传） | Ch5 `src/multiplier/registry.ts` | new-api 用表达式（`pkg/billingexpr/`）更灵活 |
| 价格表 | `relay/billing/ratio/model.go`（写死单价） | `src/providers/<name>/api.ts`（部分） | Ch5 `src/billing/prices.ts` + `prices` migration | 本书可运行时改价 |
| Channel 模型 | `model/channel.go` Channel 表 | 无显式 Channel 概念（多 provider 路由配置） | Ch8 `src/channels/registry.ts` + `channels` 表 | 本书简化为单 Key 多 channel |
| Ability 反范式索引 | `model/ability.go`（group, model, channelId 三元主键） | 无明显对应 | Ch8 `abilities` 表 + `src/channels/router.ts` | 直接抄 one-api 设计 |
| 错误分类 | `monitor/manage.go::ShouldDisableChannel` | `src/handlers/handlerUtils.ts::tryTargetsRecursively` 重试判定 | Ch8 `src/channels/classifier.ts`（4 类） | 本书的关键字字典抄自 one-api |
| 健康检查 | `controller/channel-test.go` 主动 + `monitor/metric.go` 被动 | 配置 retry，无后台 worker | Ch8 `src/channels/health-checker.ts` 后台 worker | |
| QPS 限流 | `middleware/rate-limit.go` 内存计数 | `src/middlewares/cache/index.ts` 兼做 | Ch6 `src/limit/sliding-window.ts` 内存滑动窗口 | 本书定义 RateLimiter 接口预留 Redis adapter |
| TPM 限流 | 无原生（按 quota 间接限） | 无 | Ch6 `src/limit/tpm-reservation.ts` | 复用 Ch5 两阶段计费模块预扣 |
| 流式透传 | `relay/controller/text.go` + 各 adaptor 的 `StreamHandler` | `src/handlers/streamHandler.ts`（494 行） | Ch7 `src/streaming/sse-proxy.ts` | 本书加反向取消 + partial billing 三态机 |
| 反向取消 | 无显式实现 | 部分（依赖 hono context） | Ch7 AbortController 全链路 + `streaming/postConsumeStream.ts` | 本书重点能力 |
| 结构化日志 | `model/log.go` Log 表 | `src/middlewares/log/index.ts` | Ch9 `src/log/logger.ts`（pino） + `usage_records` 加 `trace_id` | |
| 用量看板 | 内置 Web 前端（`web/`） | 无（依赖 Helicone） | Ch9 `src/dashboard/routes.ts` SSR 看板 | 本书最小 SSR，不引前端框架 |
| 钱包 / 充值 | `model/topup.go` + `controller/topup.go` 多支付渠道 | 无 | Ch11 `src/wallet/service.ts` + `wallets` / `recharges` / `refunds` 表 | new-api 多了表达式计费场景 |
| 支付集成 | `controller/topup.go`（支付宝 / 微信 / Stripe / Epay） | 无 | Ch11 PaymentAdaptor 抽象 + Mock + 附录 A 三家速查 | 本书走「抽象 + Mock + 接入清单」 |
| Prompt cache 透传 | new-api 表达式计费支持 cache token 单独定价 | 部分（cache backend，非上游 prompt cache） | Ch10 `src/optimization/prompt-cache.ts` | 本书覆盖 OpenAI 自动 + Anthropic `cache_control` 显式两套 |
| Batch API | 无 | 无 | Ch10 `src/optimization/batch-channel.ts` | |
| 成本路由 | 部分（按 priority / weight） | 部分（fallback / loadbalance） | Ch10 `src/optimization/cost-router.ts` | 本书加价格维度排序 |
| 模型指纹检测 | 无 | 无 | Ch10 `src/tools/fingerprint.ts` 独立 CLI | 本书原创工具，5 探针（self_id / cutoff / tokenizer / refusal / math）覆盖 80% 偷换场景 |
| 部署形态 | 单二进制 | npm script + Docker + 跨 runtime | Ch12 `Dockerfile` + Node / Bun / CF Workers 三对比 | |

## 设计思路对比

### one-api：中文社区祖师爷

- **优势**：覆盖最完整、社区生态最大、表设计成熟（被几乎所有后来者抄走）、Go 性能基线高、单二进制部署省心。
- **局限**：Go 栈对应用层 TS 工程师不友好；Token 明文存库；倍率硬编码（new-api 用表达式 fork 出去解决）；`controller/` 顶层和 `relay/controller/` 子层重名增加阅读成本；前后端混在一个仓库。
- **看哪些代码（最值得读的 5 个文件）**：
  - `relay/adaptor/interface.go` — Adaptor 接口设计
  - `relay/adaptor/anthropic/main.go::ConvertRequest` — OpenAI ↔ Claude 协议映射全集
  - `relay/controller/helper.go::preConsumeQuota / postConsumeQuota` — 两阶段计费
  - `model/ability.go` + `model/cache.go::CacheGetRandomSatisfiedChannel` — 反范式索引 + 内存缓存
  - `monitor/manage.go::ShouldDisableChannel` — 错误分类字典

### Portkey gateway v1.15.2：TS 阵营最完整

- **优势**：单仓库 + Hono + 跨 runtime（Node / Bun / CF Workers）、Provider 适配是「声明式配置 + 通用 transform」的纯函数模式（教学价值高）、`tryTargetsRecursively` 一处覆盖 fallback / loadbalance / conditional 三种路由策略、Cache backend 内置四种（Redis / KV / File / Memory）。
- **局限**：偏商业产品；缺计费 / 限流 / API Key 管理 / 用量持久化（默认依赖外部 Helicone）；`src/handlers/handlerUtils.ts` 单文件 1353 行劝退；78 个 provider 大部分社区贡献质量参差；2.0 pre-release 漂移风险（行号引用要带 commit hash）。
- **看哪些代码**：
  - `src/index.ts` — 路由全景，298 行纯路由声明
  - `src/providers/openai/chatComplete.ts` — 声明式 Provider 配置范本
  - `src/handlers/handlerUtils.ts::tryTargetsRecursively`（line 476 @v1.15.2） — 路由策略核心
  - `src/handlers/streamHandler.ts` — SSE 流式透传 + 多协议归一化
  - `src/services/transformToProviderRequest.ts` — 通用参数转换引擎

### 本书 TS Mini Gateway

- **优势**：单仓库、SQLite + Drizzle 零外部依赖、教材友好（每章一份 migration，不让读者改老代码）、覆盖**企业基建 + 对外卖 token** 双场景、Anthropic 协议适配讲透（6 处差异专章）、Key 哈希存储、TPM 限流复用计费模块、反向取消全链路、PaymentAdaptor 抽象、模型指纹检测工具。
- **局限**：性能基线低于 Go（单进程 Node + better-sqlite3）；多副本部署需要切到 PostgreSQL + Redis；后台管理只给 admin HTTP API + SSR 看板，没有完整的前端控制台（one-api 有）；Provider 覆盖只有 OpenAI / DeepSeek / Anthropic 三家（其余留给读者自己加）。
- **看哪些代码**：跟着 SUMMARY.md 的 12 章 example 走，每章 example 可独立运行，每章 migration 独立。Ch12 给一份合并后的最终工程。

## 把本书的实现接到 one-api / Portkey

如果你已经有一个 one-api 实例，本书的哪些章节最值得「翻译回 Go 版本」？

- **Ch7 反向取消机制**：客户端 Ctrl+C 时 AbortController 全链路传到上游，省掉「白烧 token」的损失。one-api 当前没有显式实现。
- **Ch9 trace_id 全链路 + SSR 看板**：one-api 的 Web 前端是独立工程，trace_id 没贯穿。本书的 pino 结构化日志方案直接对应 Go 的 `slog`，迁移成本低。
- **Ch10 模型指纹检测工具**：5 探针检测「声称是 X 但行为像 Y」的偷换模型行为（self_id / 知识截止 / tokenizer echo / refusal pattern / math 一致性）。one-api / new-api 都没有，对采购第三方上游的中转站运营方有直接价值。

如果你已经在用 Portkey gateway，本书的哪些章节是它没覆盖的、值得借鉴落地？

- **Ch4 内部 Key 体系**：Portkey 默认透传 Bearer 给上游，假设你自己管 Key。本书的 SHA-256 哈希存储 + 元数据 + 即时吊销可以补上这块。
- **Ch5 两阶段计费**：Portkey 完全没有计费（默认接 Helicone）。本书的 preConsume + postConsume + UsageRecord 三件套可以直接接到 Portkey 的中间件链上。
- **Ch6 TPM 限流复用计费模块**：Portkey 的 cache 中间件兼做了一些限流但没有 TPM 维度。本书把 TPM 当作「另一种两阶段预扣」复用 Ch5 的模块，思路可借鉴。
- **Ch10 灰色玩法识别 + 防御**：Portkey 不涉及商业模式细节，本书把「为什么中转站比官方便宜」拆透到合法 / 灰色边界，并给出防御侧检测器。
- **Ch11 PaymentAdaptor**：Portkey 不做支付。本书的抽象接口与 ProviderAdaptor 形成对称设计，可作为接入支付的最小骨架。

## 我们没做的部分（与两者的差距）

诚实交代局限：

- **多区域部署**（跨大区延迟 / 数据本地化）：one-api 也没原生支持，需要外部 LB + 多副本同步。本书 Ch12 提了「多区域部署」是 v2.0 该解决的事情，正文不覆盖。
- **大规模日志存储**：Helicone 用 ClickHouse + S3 + Queue 方案处理百万级请求 / 天的查询。本书用 SQLite，单机够用（10 人左右团队 / 10w 条日志量级），更大规模需要自己换存储。
- **团队协作 / 多租户子账户**：new-api 有部分（用户分组 + 邀请码），本书只有 User / Key 两层，没有 Org / Sub-account 维度。对外卖 token 场景做大后这块要自己补。
- **后台管理 UI**：one-api 有完整 Web 前端（`web/default` + `web/classic`），本书只给 admin HTTP API + 一份 SSR 看板。理由是「前端工程不属于网关本质」，留空间给读者按自己技术栈选 Next.js / Nuxt / Astro 都行。
- **Provider 覆盖广度**：one-api 有 40+ adaptor，Portkey 有 78 家。本书只覆盖 OpenAI + DeepSeek + Anthropic 三家。第四家以后用 `OpenAICompatibleAdapter` 配置化基类（base URL + auth header pattern + model list）即可覆盖 90% 国产模型，思路在 Ch2 给出。
- **审计合规（SOC2 / 金融客户）**：none of three 覆盖。Helicone 在 web 层有部分实现，对 LLM Gateway 本身不算核心能力，本书 Ch12 列入 v2.0 路线图。

如果你的需求落在上述任何一项，本书不是合适的起点 —— 直接看 one-api（Go 性能基线）或 Helicone（企业级特性最完整）会更合适。本书的定位是「TS 工程师从 0 跟到 1 跑通的最小但完整的网关」，不是「直接拿去打商业战的成品」。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
