---
title: 目录
---

## 前言

[preface/](preface/) — 为什么写这本书、写给谁、覆盖什么、三条阅读路线、致谢。

## 第 1 章 什么是 LLM 中转站，为什么要做一个

[01-what-is-a-gateway/](book/01-what-is-a-gateway/) — 定义中转站、企业基建与对外创业两种场景的差异、本书的承诺、最小起点。

## 第 2 章 一个入口，多家上游

[02-one-endpoint-three-providers/](book/02-one-endpoint-three-providers/) — `ProviderAdaptor` 接口与统一 IR；接入 OpenAI 与 DeepSeek。

## 第 3 章 Anthropic 协议适配

[03-anthropic-is-different/](book/03-anthropic-is-different/) — 6 处协议差异拆解；用 Anthropic 压力测试 Adaptor 抽象。

## 第 4 章 不再共享主 Key

[04-stop-sharing-the-master-key/](book/04-stop-sharing-the-master-key/) — SQLite + Drizzle 持久层；内外双 Key 体系。

## 第 5 章 每一分钱的归属

[05-who-spent-my-money/](book/05-who-spent-my-money/) — token 双路对账、价格表、倍率、两阶段计费、UsageRecord。

## 第 6 章 限流与配额

[06-someone-is-abusing-my-gateway/](book/06-someone-is-abusing-my-gateway/) — QPS 滑动窗口 + TPM 预扣 + 每月配额。

## 第 7 章 SSE 流式透传与反向取消

[07-stream-is-broken/](book/07-stream-is-broken/) — SSE 协议、流式归一化、AbortController 全链路、流式计费闭环。

## 第 8 章 渠道池与故障转移

[08-the-key-just-got-banned/](book/08-the-key-just-got-banned/) — Channel + Ability 反范式索引、错误分类、健康检查、自动故障转移。

## 第 9 章 可观测性与看板

[09-where-did-this-request-go/](book/09-where-did-this-request-go/) — pino 结构化日志、trace_id 全链路、SSR 看板。

## 第 10 章 中转站为什么便宜

[10-why-is-relay-cheaper/](book/10-why-is-relay-cheaper/) — 5 种合法降本机制、3 种灰色玩法识别、模型指纹检测工具。

## 第 11 章 钱包与支付

[11-how-do-i-charge-users/](book/11-how-do-i-charge-users/) — 钱包 / 充值 / 退款最小模型、PaymentAdaptor 抽象、三道核心难题。

## 第 12 章 一键上线最小原型

[12-ship-it/](book/12-ship-it/) — monorepo 整合、Docker 化、e2e 压测、Node / Bun / CF Workers 部署对比。

## 附录 A 支付接入点设计

[appendix-a-payment-integration/](book/appendix-a-payment-integration/) — Stripe / 支付宝 / 微信支付接入要点速查。

## 附录 B 与 one-api / Portkey 的对照表

[appendix-b-comparison/](book/appendix-b-comparison/) — 按概念对照三家实现差异。
