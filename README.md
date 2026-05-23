---
title: AI Token 中转站实战：从 0 搭建企业级 LLM 网关
---

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
| 阶段 | `init` 完成，等待启动 `research` |
| 目标技术栈 | TypeScript + Node.js 20+ |
| 结构 | flat（章节扁平） |
| 参考库 | one-api、new-api、portkey gateway、helicone、litellm |

## 目录

`SUMMARY.md` 在 `toc` 阶段定稿后会写入。

## 配套代码

每章对应 `book/NN-xxx/examples/` 一份可独立运行的最小示例，
全书最后一章会汇总成一个能本地跑起来的最小原型。
