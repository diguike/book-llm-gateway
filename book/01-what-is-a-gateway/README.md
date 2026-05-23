---
title: 第 1 章 什么是 LLM 中转站，为什么要做一个
feishu_url: "https://www.feishu.cn/wiki/B96LwyXVDi0QLKksgvPc27sFnRq"
last_synced: "2026-05-16T18:28:24"
---

## 1.1 从一段直连代码说起

任何用过 OpenAI API 的工程师，回忆自己写下的第一段调用代码，几乎都长这样：

```ts
const resp = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [...] }),
});
```

接入第一个业务时，这段代码没有任何问题。问题出现在第二个业务、第三个业务，以及第二家上游供应商接入之后。

公司里的另一个团队需要同样的能力，运维把 `OPENAI_API_KEY` 复制给了他们。第三个团队也要用，再复制一次。两个季度以后，这把 Key 出现在四个 Git 仓库、两份 Notion 文档、若干工程师的本地环境变量里。账单到来时，财务问起「这个月 8 万元的 OpenAI 消费，能不能拆出每个团队各花了多少」，没人能给出答案——日志里只有 `200 OK`，没有任何按业务线归因的字段。

某个工程师不小心把 Key 提交到了公开仓库。安全团队要求立刻吊销，运维照做，于是公司所有依赖 LLM 的服务在那一刻同时下线。等到新 Key 重新分发完毕、所有服务重启，已经过去了 40 分钟。

这一连串看上去都不致命的小问题，本质上指向同一件事：**直连上游 API 的调用模式，缺少一个统一的入口层**。这一层在传统后端架构里叫 API Gateway，在 LLM 应用场景里被称为 LLM Gateway，国内社区更习惯叫「中转站」或「AI Token 中转站」。

本章不解决任何具体工程问题，只做三件事：把这个概念讲清楚、把两种典型场景说透、把全书的最小起点跑起来。

## 1.2 LLM 中转站的定义

> **LLM 中转站（LLM Gateway）是位于客户端与上游 LLM API 之间的一层 HTTP 服务，对外通常暴露 OpenAI 兼容协议，对内承担路由、协议转换、鉴权、计费、限流、渠道管理、可观测等职责。**

拆开这个定义里的几个关键词：

- **位于客户端与上游 LLM API 之间**：客户端不再直连 OpenAI / Anthropic / DeepSeek，而是把请求发给中转站，由中转站代为转发。
- **对外通常暴露 OpenAI 兼容协议**：OpenAI 的 `/v1/chat/completions` 是事实标准，绝大多数客户端 SDK（openai-python、openai-node、LangChain、LlamaIndex、Cherry Studio、Open WebUI 等）都默认按这套协议工作。中转站对外说「OpenAI 协议」，是为了让客户端零成本接入。
- **对内承担多种职责**：路由（按 model 字段决定打到哪家上游）、协议转换（OpenAI 协议入站、Anthropic Messages 协议出站）、鉴权（签发并校验内部 Key）、计费（按 token 与价格表算账单）、限流（QPS / TPM 两个维度）、渠道管理（一个 model 后挂多个 Key 或多家上游做故障转移）、可观测（按 trace_id 反查全链路）。

形态上，中转站既可以是一个独立部署的 HTTP 服务（本书的形态），也可以是一个 SDK 形态的进程内组件（如 LangChain 的 Router）。两者的边界视团队规模、合规要求、横向扩展能力而定。本书选择独立 HTTP 服务，因为它能同时覆盖企业基建与对外创业两种场景，且与 one-api / Portkey / Helicone 等主流开源项目的形态一致。

## 1.3 场景 A：企业内部基建

第一种典型场景是大中型公司的内部 LLM 基建。这类公司通常有 5 到 50 个业务线同时调用 LLM——客服机器人、文档摘要、代码助手、营销文案、数据分析助手——每条线背后是不同的产品经理、不同的开发节奏、不同的预算。

直连模式下，这些业务线共用一两把上游 Key，由此带来的真实问题清单大致如下：

1. **Key 泄露无法精细吊销**：4.1 节描述的场景。一旦 Key 泄露，要么所有业务全停，要么承担继续被滥用的风险。
2. **用量无法按团队归因**：上游账单只有一个数字。财务要拆账时只能让各业务线自己估算自己的用量，估算结果之和往往比真实账单大 30%。
3. **配额无法分配**：客服机器人在大促期间预期会突发 10x 流量，但没有任何机制保证它能优先于「营销文案这种非关键路径」用到上游配额。结果是大促日营销团队不小心跑了一个 prompt 测试脚本，把当月配额烧掉一半。
4. **合规审计缺位**：金融、医疗、政企客户要求所有外发 prompt 与上游响应留底备查。直连模式下这一层只能落在各业务线自行实现，落地质量参差不齐。
5. **多家上游接入靠手抄**：A 业务想换 DeepSeek 省钱、B 业务想用 Claude 做长文档分析。每个业务线各自接一遍上游 SDK，协议差异在每个业务的代码里都重写一遍。
6. **本地模型无法平滑接入**：公司部署了 vLLM / Ollama 的内网模型，业务线要在同一套 SDK 里同时调用 OpenAI 与内网模型，需要在客户端做条件分支。

中转站作为统一入口收口这六件事：**所有业务线只跟中转站说话**，中转站把上游差异（多家 provider、协议、Key 分发、故障转移）藏在内部。代表形态是公司内部的「AI 平台」「LLM 中台」，对外不是商业产品，但对内是所有 LLM 应用的必经通道。

国内最常见的开源选型是 one-api 与其 fork new-api，TS 阵营对应的产品是 Portkey 的自托管版本。

## 1.4 场景 B：对外创业卖 token

第二种典型场景是创业者把中转站当成产品对外卖。这类产品的市面价格通常是官方 API 价格的 80%-90%，少数甚至能压到 50% 以下。差异化卖点大致是这样几条：

1. **多模型一站式**：OpenAI、Anthropic、Google、DeepSeek、Moonshot、智谱、阶跃……一把 Key 全打通，开发者不用挨家开通。
2. **支付方便**：官方账号普遍要求 Visa / Mastercard 信用卡或 Google Pay，对国内开发者不友好。中转站做支付宝、微信支付、USDT 充值。
3. **比官方便宜**：来源是供应商价差套利（同样的 GPT-4o，企业渠道、教育渠道、批量采购的单价不同）、缓存复用（prompt caching 透传）、batch 折扣转嫁、以及——市面上一部分玩家干的不那么光明的事，比如悄悄把 GPT-4o 替换成 GPT-4o-mini。
4. **针对开发者优化**：标准 OpenAI 协议、合理的限流策略、可观测的用量看板、API 维度的子账号管理。

代表项目是 one-api / new-api，市面上以「中转站」「AI API」「LLM 中转」为关键词的服务多数基于这两个项目魔改而来。这条路线的代表读者群是个体开发者与小团队创业者，盘子不大但赛道仍有空间——尤其是面向特定垂直人群（学生、海外华人、Claude Code 重度用户）的定向产品。

社区调研与公开测评显示，第三方中转站在模型一致性上参差不齐，部分服务存在用低价模型冒充声称模型的现象——「声称卖 GPT-4o，实际下游是别的模型」并不罕见。这层灰色玩法的存在意味着，认真做合规的中转站反而有差异化空间——这是第 10 章会深入讨论的护城河。

> **关于书中价格与对比数据**：本书 Ch10 会用代码量化这五件合法降本机制（prompt caching / batch / 渠道倍率 / 成本路由 / 企业渠道），并提供一个本机可跑的指纹检测 CLI（`model-fingerprint-cli`），读者可以用它直接验证手上接入的中转站「声称的模型」是否与「实际行为」一致，不需要相信任何二手数字。

## 1.5 两种场景的核心差异

两种场景共享同一套底层基建（路由、协议转换、鉴权、计费、限流、渠道、流式、可观测），但在产品形态与工程优先级上差异明显。下表把核心差异列出来：

| 维度 | 场景 A 企业内部基建 | 场景 B 对外创业卖 token |
|------|--------------------|----------------------|
| 用户来源 | 公司内部业务线，已知且受控 | 互联网开放注册，匿名且不可信 |
| Key 分发模型 | 按部门 / 项目签发，元数据丰富（owner、cost_center） | 按账号签发，强调充值与余额绑定 |
| 计费目的 | 内部成本归因与预算管控，对账面向财务 | 真金白银的营收，对账面向用户与税务 |
| 限流动机 | 防止单个业务拖垮整体可用性，保护其他业务线 | 防止滥用账号薅羊毛，保护自己利润 |
| 多 provider 驱动力 | 模型能力适配业务场景（长文档 → Claude、推理 → o1） | 价差套利与故障转移，最大化毛利 |
| 对外 SLA | 内部协商，可接受短时降级 | 合同义务，需明确 uptime 承诺与赔付条款 |

> 读这张表的方式不是「记住哪一列对应哪种场景」，而是理解**同一个技术模块在两种场景下的工程权重不同**。例如限流模块：场景 A 关注「按业务线分配公平份额」，场景 B 关注「按账号防止异常调用消耗利润」。两套实现共享同一套 QPS / TPM 算法，但策略层（谁优先、超额怎么处理、违约是否降级）需要分别建模。

## 1.6 本书的承诺

本书的承诺是：**用 TypeScript 从 0 搭建一个能覆盖两种场景的最小可上线网关**，到第 12 章结束时，读者在本机能跑起一个具备以下能力的服务：

- 接收 OpenAI 协议请求，路由到 OpenAI / DeepSeek / Anthropic 三家上游（Ch 2-3）
- 内部 Key 鉴权 + 按用户 / 模型维度的用量记录与账单（Ch 4-5）
- QPS + TPM 两个维度的限流、月度配额（Ch 6）
- SSE 流式响应稳定透传、客户端取消时反向取消上游（Ch 7）
- 多渠道故障转移与健康检查（Ch 8）
- trace_id 全链路追踪 + 最小可用看板（Ch 9）
- Prompt caching 透传、batch 异步通道、模型指纹检测工具（Ch 10）
- 钱包 + 充值 + 退款的最小变现链路（Ch 11）
- Docker 化、一条命令起整套服务（Ch 12）

章节分工如下：

- **第 1 章到第 9 章是两种场景共享的基建**：路由、协议、鉴权、计费、限流、流式、渠道、可观测。无论企业基建还是对外创业，这九章都必读。
- **第 10 章「中转站为什么便宜」**：对外创业场景的护城河。企业基建读者可以挑读其中的「成本路由」与「Prompt caching 透传」两节，跳过其余。
- **第 11 章「钱包与支付」**：对外创业场景的变现链路。企业基建读者跳过即可。
- **第 12 章「一键上线」**：两种场景都读。

每章的代码示例在 `examples/<chapter>/` 目录下独立成包，互不依赖。读者可以从任意一章跳进去单独跑通，也可以跟着主线从第 1 章一路演进到第 12 章。第 12 章会把前 11 章的孤岛 example 合并成一份可部署的 monorepo 工程。

## 1.7 与其他开源项目的定位差异

LLM 网关赛道已经有不少开源项目，本书的角色不是再造一个，而是用一本书的篇幅把「为什么这么设计」讲清楚。下表把四个主流项目与本书的关系列出来：

| 项目 | 语言 | 教学价值 | 与本书的关系 |
|------|------|---------|------------|
| [one-api](https://github.com/songquanpeng/one-api) | Go | 设计模式参考 | 主要借鉴：统一 IR + Adaptor 接口、Ability 反范式索引表、两阶段计费、错误分类自动禁用。代码层面的具体实现差异较大，但架构思想直接迁移。 |
| [Portkey](https://github.com/Portkey-AI/gateway) | TypeScript | 主参考（跟读源码） | 栈一致（Hono + TS），本书的 Provider 抽象、SSE 透传层、内存限流实现都参考其 v1.15.2 版本的源码组织方式。 |
| [Helicone](https://github.com/Helicone/helicone) | TypeScript | 偶尔查阅 | 代理 + 可观测平台。本书的可观测章节（第 9 章）参考其 Manager + Store 拆分模式。 |
| [LiteLLM](https://github.com/BerriAI/litellm) | Python | 偶尔查阅 | provider 抽象设计最完整的实现，但语言不同。本书的 `ProviderAdaptor` 接口设计参考其 `BaseConfig` 抽象。 |

简单概括四家项目的定位：

- **one-api**：国内社区认知度最高，功能最完整，但代码量大、Go 语言对应用层 TS 工程师不友好。它适合直接拿来部署、不适合作为教学材料。
- **Portkey**：商用产品 OSS 版本，代码质量高，但模块边界为了产品化做了较多妥协，作为教材直接读源码会有理解门槛。
- **Helicone**：偏向「观测平台」而非「网关」，把日志与看板做得很重，路由层相对薄。
- **LiteLLM**：Python 生态主流选择，provider 数量遥遥领先（100+ 家），但语言不同。

本书的角色是**用 TypeScript 把上述项目里值得迁移的设计思想，用 5000 行级别的代码重新实现一遍，并在每一段代码旁边讲清楚「为什么这么写」**。读完本书的读者能够具备两种能力中的至少一种：自己从零搭一个 mini 网关，或者读懂 one-api / Portkey 这类生产级网关的源码。

## 1.8 一个 30 行的最小起点

下面是本书的 v0.1。这段代码做的事情非常简单：接收 OpenAI 协议请求，原样转发给真正的 OpenAI（或任意 OpenAI 兼容上游），把上游响应原样回给客户端。

```ts
// examples/01-what-is-a-gateway/src/index.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import pino from 'pino';
import 'dotenv/config';

const logger = pino({ transport: { target: 'pino-pretty' } });
const app = new Hono();

// 入参校验：messages 与 model 必填
const ChatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.any() })).min(1),
}).passthrough();

app.post('/v1/chat/completions', async (c) => {
  const raw = await c.req.json();
  const parsed = ChatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.format() }, 400);
  }

  const upstream = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
  const resp = await fetch(`${upstream}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parsed.data),
  });

  logger.info({ model: parsed.data.model, status: resp.status }, 'relay');
  return c.json(await resp.json(), resp.status as 200);
});

serve({ fetch: app.fetch, port: 3000 });
logger.info('Gateway listening on http://localhost:3000');
```

这就是 v0.1 的全部。它能正确接收 OpenAI 协议的 `chat.completions` 请求并转发，对客户端而言与直连 `api.openai.com` 行为一致。配套代码可直接 `npm install && npm run dev` 跑起来。

注：上面正文是为了方便讲解的极简版本。实际仓库里 `examples/01-what-is-a-gateway/src/index.ts` 还多了三处不影响主线的工程化改动：（1）用 `await c.req.json().catch(() => null)` 防御非法 JSON 报文导致进程崩；（2）转发响应时改用 `await resp.text()` + `new Response(body, ...)` 而不是 `c.json(await resp.json(), ...)`，避免对上游响应体做 JSON 解码再编码（流式与错误响应都更安全）；（3）补了一个 `GET /healthz` 与一条 `latency_ms` 字段，给后续章节的容器化探活与可观测留接口位。

这段代码非常刻意地暴露了几个问题，留给后续章节解决：

1. **上游 Key 写死在环境变量里**：所有访问网关的客户端都共享同一把上游 Key，**这就是第 1.3 节描述的「Key 泄露无法精细吊销」问题在网关侧的再现**。第 4 章引入内部 Key 体系解决。
2. **只能对接单一上游**：`upstream` 是一个常量，无法按 `model` 字段路由到不同 provider。第 2 章引入 Provider 抽象解决。
3. **没有任何鉴权**：任何拿到 `http://localhost:3000` 这个地址的客户端都能消耗上游额度。第 4 章引入 Bearer Token 鉴权解决。
4. **不计费、不限流、不可观测**：第 5 章到第 9 章逐一补齐。
5. **不支持流式**：现在的实现是 `await resp.json()` 一次性读完，流式请求会被破坏。第 7 章重写流式透传层。

第 1 章的目标到此为止——把概念立稳、把第一行代码跑起来。剩下的所有问题，都是后续章节的合同。

## 1.9 本章小结

第 1 章把「LLM 中转站」这个概念拆成可操作的工程定义：一层 HTTP 服务，对外暴露 OpenAI 兼容协议，对内承担多种网关职责。两种典型场景（企业基建与对外创业）在底层基建上完全重合，在产品形态与工程权重上存在六个维度的差异，本书前 9 章服务两种场景，第 10 章起向对外创业倾斜。

读完本章，读者应该能够：

- 用一段话向同事解释 LLM 中转站是什么、解决哪些问题
- 区分企业基建与对外创业两种场景在 Key 分发、计费、限流、SLA 上的差异
- 在本机跑通 30 行的 v0.1 版本，理解它故意暴露的 5 个缺陷
- 对照 one-api / Portkey / Helicone / LiteLLM 的定位，理解本书的取舍

## 配套代码

完整可运行的 v0.1 代码在 `examples/01-what-is-a-gateway/`，包括：

- `src/index.ts`：30 行的 Hono 透传实现
- `.env.example`：环境变量模板
- `README.md`：启动命令、curl 示例、预期输出
- 「场景 A 企业基建需求清单」与「场景 B 对外创业需求清单」两份对照文档

按照 README 的指引 `npm install && npm run dev` 即可起服务。请准备一把可用的 OpenAI Key（或任意 OpenAI 兼容上游的 Key，比如 DeepSeek），写入 `.env` 文件后即可发起测试请求。

## 下一章预告

v0.1 的实现把上游 Key 直接暴露在配置文件中，且只能对接单一上游。当业务需要在不修改客户端代码的前提下接入第二家、第三家上游时——客户端发 `model: gpt-4o-mini` 打到 OpenAI、发 `model: deepseek-chat` 打到 DeepSeek——单 Provider 的硬编码架构无法响应。

第 2 章引入贯穿全书的第一个核心抽象 **`ProviderAdaptor` 接口** 与 **统一 IR（Intermediate Representation，中间表示）**。这套抽象同时参考 one-api 的 `relay/adaptor/interface.go` 与 LiteLLM 的 `BaseConfig`，把「请求归一化 → 路由 → 响应归一化」这条主干立起来。读完第 2 章，读者将拥有一个能根据 `model` 字段自动路由到 OpenAI 或 DeepSeek 的 v0.2 网关——并且为任何新的 OpenAI 兼容上游补一个适配器只需要约 30 行代码。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)
