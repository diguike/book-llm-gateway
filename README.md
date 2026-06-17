---
title: AI Token 中转站实战：从 0 搭建企业级 LLM 网关
---

> 在线阅读 · [inferloop.dev/llm-gateway](https://inferloop.dev/llm-gateway)  
> 所有书目 · [inferloop.dev](https://inferloop.dev)

## 这本书在讲什么

用 TypeScript 从零搭一个企业级 LLM API 中转站（也叫 AI Gateway）。
覆盖路由、协议转换、鉴权、计费、限流、渠道管理、流式响应、可观测性，
以及一个常被讨论但很少讲透的话题：**中转站为什么能比官方便宜**。

读完这本书，读者应该能：

- 理解 one-api / new-api / portkey gateway 这类中转站的核心架构
- 用 TS 自己跑通一个最小但完整的网关原型
- 知道企业内部 LLM 网关和对外中转站在设计上的差异
- 看懂中转站成本优化背后的技术与商业机制

## 状态

| 字段 | 值 |
|------|-----|
| 阶段 | 全书写作完成，代码已验证 |
| 技术栈 | TypeScript + Node.js 20+、Hono、better-sqlite3 + Drizzle |
| 篇幅 | 12 章正文 + 2 篇附录 |
| 参考库 | one-api、new-api、portkey gateway、helicone、litellm |

## 怎么读这本书

- **想快速理解中转站长什么样**：先读[前言](preface/README.md)和[第 1 章](book/01-what-is-a-gateway/README.md)，再直接跳到[第 12 章](book/12-ship-it/README.md)把最小原型跑起来
- **系统学习**：从前言到第 12 章按顺序读，每章配套 `examples/` 跟着跑一遍
- **关心成本与商业机制**：重点读[第 5 章](book/05-who-spent-my-money/README.md)、[第 10 章](book/10-why-is-relay-cheaper/README.md)、[第 11 章](book/11-how-do-i-charge-users/README.md)

## 目录

**前言**

- [前言](preface/README.md)　为什么写这本书、写给谁、覆盖什么、三条阅读路线

**第一部分　从一个入口到多家上游**

- [第 1 章　什么是 LLM 中转站，为什么要做一个](book/01-what-is-a-gateway/README.md)
- [第 2 章　一个入口，多家上游](book/02-one-endpoint-three-providers/README.md)
- [第 3 章　Anthropic 协议适配](book/03-anthropic-is-different/README.md)

**第二部分　把网关做成生意**

- [第 4 章　不再共享主 Key](book/04-stop-sharing-the-master-key/README.md)
- [第 5 章　每一分钱的归属](book/05-who-spent-my-money/README.md)
- [第 6 章　限流与配额](book/06-someone-is-abusing-my-gateway/README.md)
- [第 7 章　SSE 流式透传与反向取消](book/07-stream-is-broken/README.md)
- [第 8 章　渠道池与故障转移](book/08-the-key-just-got-banned/README.md)
- [第 9 章　可观测性与看板](book/09-where-did-this-request-go/README.md)

**第三部分　成本、收费与上线**

- [第 10 章　中转站为什么便宜](book/10-why-is-relay-cheaper/README.md)
- [第 11 章　钱包与支付](book/11-how-do-i-charge-users/README.md)
- [第 12 章　一键上线最小原型](book/12-ship-it/README.md)

**附录**

- [附录 A　支付接入点设计](book/appendix-a-payment-integration/README.md)
- [附录 B　与 one-api / Portkey 的对照表](book/appendix-b-comparison/README.md)

完整目录另见 [SUMMARY.md](SUMMARY.md)。

## 配套代码

每章对应 `book/NN-xxx/examples/` 一份可独立运行的最小示例，
全书最后一章（第 12 章）汇总成一个能本地跑起来的最小原型：

```bash
cd examples/12-ship-it
npm install && npm run migrate && npm run smoke
```


## 相关书

来自同一作者的其他书:

- [《Hermes Agent 源码解读》](https://inferloop.dev/hermes-agent)
- [《LLM Infra 工程实战》](https://inferloop.dev/llm-infra)
- [《Agent Memory 工程实战》](https://inferloop.dev/claude-mem)
- [《百万级 AI Agent 平台架构》](https://inferloop.dev/enterprise-agent)
- [《OpenClaw 源码解析》](https://inferloop.dev/openclaw)
- [《Transformer 教学》](https://inferloop.dev/transformer)
- [《Claude Code Skill 开发指南》](https://inferloop.dev/claude-skill)
- [《Claude 插件官方指南》](https://inferloop.dev/claude-plugins)
- [《自己动手写 AI Agent》](https://inferloop.dev/ling-agent)
