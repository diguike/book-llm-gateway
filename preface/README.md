---
title: 前言
feishu_url: "https://www.feishu.cn/wiki/ZvV5wPXPeiQ5BPkH9OLcXaqRnOf"
last_synced: "2026-05-16T18:28:20"
---

> **配套资源**  
> 源码仓库 · [github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)  
> 在线阅读 · [inferloop.dev/llm-gateway](https://inferloop.dev/llm-gateway)

## 一笔 8 万元的 OpenAI 账单

2025 年某个月初，一位朋友的财务找到他，问「这个月公司 OpenAI 账单 8 万元，能不能拆出每个团队各花了多少」。他打开后台看了五分钟，给出的答案是「拆不出来」——所有业务线共用同一把上游 Key，账单只有一个总数。两周后，一名新入职的工程师不小心把这把 Key 提交到了公开仓库，安全团队要求立刻吊销，于是公司里所有依赖 LLM 的服务在那一刻同时下线，等到新 Key 重新分发完毕、所有服务重启完成，已经过去了 40 分钟。

这是「直连上游 API」这种调用模式的典型代价。同样这家公司，如果一开始就走了一层 LLM Gateway（中转站），账单按内部 Key 维度自然就拆开了，吊一把 Key 不会牵连其他业务，新 Key 上线只需改一行配置。直接收益不止「省事」，而是把「无法归因的 8 万元」「无法局部止血的 40 分钟」这类损失关进笼子。

写这本书的第一个动因来自这种亲眼看到的反复浪费。中转站这件事在中文社区其实早有成熟方案——one-api、new-api、Portkey、Helicone、LiteLLM 五个项目互相借鉴，覆盖了从开源自托管到商业 SaaS 的所有形态。但仔细看会发现一个问题：最被国内开发者认可的 one-api / new-api 是 Go 写的，对应用层的 TypeScript 工程师不友好；TS 阵营的 Portkey 与 Helicone 偏商业产品，作为教材的可读性不强；Python 生态的 LiteLLM provider 数量遥遥领先但语言不同。Node.js / TypeScript 工程师如果想系统理解中转站的工程实现，要么硬啃 Go 源码，要么对着 Portkey 的 1300 行单文件 handler 逆向。这本书想填的是这个空缺。

第二个动因是「中转站为什么能比官方便宜」这件事。市面上的中转站普遍把同一个模型卖到官方价的 80%-90%，少数能压到 50% 以下。这背后涉及供应商价差套利、prompt caching 透传、batch 折扣转嫁、企业渠道返点，以及——很少有人公开承认的——偷换模型这种黑色玩法。社区多份调研与公开测评显示，第三方中转站在模型一致性上参差不齐，部分服务存在用低价模型冒充声称模型的现象，「声称卖 GPT-4o，实际下游是别的模型」并不罕见。这本书会用一整章拆开这套机制：哪些是合法的成本路径、哪些是灰色玩法、运营方与采购方各自如何识别和防御，配套一个独立的指纹检测 CLI（`model-fingerprint-cli`）让读者能自己审计接入的中转站。

第三个动因是把企业级网关的核心能力——路由、协议转换、鉴权、计费、限流、渠道管理、流式、可观测——用一本书的篇幅系统讲清楚，并配套一份读者能跑起来的最小原型。这八件能力散落在各家开源项目里，但没有一份资料把它们按「从 0 到 1 的演进顺序」串起来过。本书的 12 章正文按 v0.1 → v1.0 的版本演进组织，每一章对应一次能力增量，每一章都有一份独立可运行的代码 example，每一章都用一个具体的工程问题作为开场——「Key 泄露怎么吊」「账单怎么拆」「上游挂了怎么换」「客户端 Ctrl+C 时如何不白烧 token」——读完一章，读者手里多一份解决该问题的最小可运行代码。

## 这本书写给谁

适合阅读的读者：

- 1-3 年 Node.js / TypeScript 后端经验的工程师，想理解中转站背后的工程原理
- 用过 OpenAI / Anthropic / [百炼](https://www.aliyun.com/benefit/ai/aistar?userCode=okjhlpr5) 这类模型 API、想给公司搭一套内部 LLM 网关的应用层全栈工程师
- 想自己跑一个对外中转站的个体开发者，需要先把合规边界和核心机制看清楚
- 已经在用 one-api / Portkey 但想读懂源码、做二次开发的运营方

不太适合阅读的读者：

- 完全没有后端经验、只写过前端的读者（本书的代码示例假设你能读懂 Hono / SQLite / fetch / async-await）
- 只关心 prompt 调优、不打算碰基础设施的应用层开发者
- 期待深入 CUDA / 推理引擎 / 模型训练细节的读者——这部分内容在《LLM Infra 工程实战》里讲，本书严格只讨论应用层往上的网关侧

## 覆盖什么 / 不覆盖什么

12 章正文 + 2 个附录，按演进顺序大致是这样：

- **Ch1-Ch3** 立基：定义中转站、引入 ProviderAdaptor 接口与统一 IR、把协议差异最大的 Anthropic 适配讲透
- **Ch4-Ch6** 收口：内部 Key 体系、两阶段计费 + UsageRecord、QPS / TPM 限流
- **Ch7-Ch9** 强化：SSE 流式透传与反向取消、渠道池与故障转移、trace_id 全链路 + SSR 看板
- **Ch10-Ch12** 收尾：「中转站为什么便宜」的成本机制专章、钱包与支付、Docker 化一键上线
- **附录 A** 支付接入点设计速查（Stripe / 支付宝 / 微信支付）
- **附录 B** 与 one-api / Portkey 的概念对照表

明确不覆盖的内容：

- 模型推理与训练细节（GPU、CUDA、量化、KV cache 实现等）——这是另一本书的范围
- 完整的支付平台对接代码（合规地区差异大、SDK 升级频繁）——只在附录 A 列接入清单与坑位
- 多租户 SaaS 的全套财务系统（发票、税务、订阅生命周期）——本书的钱包模型够「能跑通」但不够「能上市」
- 完整的前端控制台（one-api 有的那种 React 后台）——本书只给最小 SSR 看板与 admin HTTP API

## 怎么读这本书

按读者类型推荐三条路线：

**路线 A：企业基建工程师（最短路径，约 1 周）**

目标是给公司搭一个内部 LLM 网关。Ch1-Ch9 全读，Ch10 挑读「成本路由 fallback」一节，Ch11 跳过（企业内部不需要钱包模型），Ch12 全读。附录 B 用来对照已有的 one-api / Portkey 部署做迁移规划。这条路线读完手里有一套覆盖路由、鉴权、计费、限流、流式、可观测、故障转移的完整网关，能直接接入公司业务线。

**路线 B：对外中转站创业者（完整路径，约 2-3 周）**

目标是开一个对外卖 token 的中转站。12 章 + 2 个附录全部按顺序读，重点章是 Ch10（成本护城河 + 灰色玩法识别）、Ch11（钱包与支付的三道核心难题）、附录 A（支付接入清单）。Ch10 的「模型指纹检测 CLI」可以拿去审计自己接入的上游，确保自己不被价差套走。读完读者会有一个能跑通注册、充值、计费、退款、对账完整链路的最小原型，加上一份合规边界的明确认知。

**路线 C：想看源码深挖的工程师（自由路径）**

目标是补齐对中转站工程实现的理解。每章都可以独立读，建议至少精读 Ch3（Anthropic 协议适配，全书最复杂的一章）、Ch5（两阶段计费 + 微元精度）、Ch7（流式透传与反向取消）、Ch8（渠道池与故障转移）、Ch10（成本机制）。附录 B 的「看哪些代码（最值得读的 5 个文件）」一节列了 one-api 与 Portkey 的源码精读清单，配合本书的 TS 实现对照阅读，能把一类设计模式吃得很透。

每章末尾都有「下一章预告」一节，一路咬合到 Ch12，跟着读不会断线。代码示例放在 `examples/<chapter>/` 下，每章独立成包不依赖其他章，跳进任意一章 `npm install && npm run dev` 都能跑起来。Ch12 会把前 11 章的代码合并成一份可部署的 monorepo。

## 配套资源

- 本书参考的开源项目（重点跟读源码）：
  - [Portkey gateway v1.15.2](https://github.com/Portkey-AI/gateway) — TS 主参考，本书的 Provider 抽象、SSE 透传、内存限流参考其源码组织
  - [one-api](https://github.com/songquanpeng/one-api) — 设计模式参考，统一 IR / Adaptor / Ability / 两阶段计费的来源
  - [LiteLLM](https://github.com/BerriAI/litellm) — provider 抽象设计参考，BaseConfig 是 ProviderAdaptor 接口的灵感来源
  - [Helicone](https://github.com/Helicone/helicone) — 可观测层 Manager + Store 拆分模式
- 调研与测评来源：上游官方文档（OpenAI / Anthropic / Google / DeepSeek 的 prompt caching 与 batch API）、中文社区综述（gm7.org 灰产专题、虎嗅相关报道、V2EX `gpt` 节点讨论）、one-api / new-api GitHub Issues 里关于「为什么便宜」的讨论，详见 Ch10 末尾的「调研与测评来源」一节
- 勘误与反馈：欢迎在本书源仓库提 issue，或在 inferloop.dev 站点留言

## 致谢

感谢 Portkey、one-api、LiteLLM 三个项目的作者与贡献者，本书的工程实现大量借鉴了三家的设计思想与源码组织方式。感谢一路同行的工程师朋友们贡献的真实事故案例与反复打磨的产品经验。书中所有引用的源码路径、价格数据、压测结果，均可通过仓库的 `verify-report.yaml` 反向追溯到原始测试运行。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)
