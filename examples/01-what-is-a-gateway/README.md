# 第 1 章 v0.1 配套代码

30 行 Hono 透传——接收 OpenAI 协议请求，原样转发到上游 OpenAI 兼容 API。

## 依赖

- Node.js 20+
- npm

## 启动

```bash
cp .env.example .env
# 编辑 .env, 把 OPENAI_API_KEY 改成你自己的 Key
# 也可换成任意 OpenAI 兼容上游, 例如 DeepSeek:
#   OPENAI_BASE_URL=https://api.deepseek.com
#   OPENAI_API_KEY=sk-deepseek-xxxxx

npm install
npm run dev
```

服务会监听 `http://localhost:3000`。

## 验证

健康检查：

```bash
curl http://localhost:3000/healthz
# {"ok":true,"version":"v0.1"}
```

发起一次 OpenAI 协议请求（这里假设 .env 配的是 DeepSeek）：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-anything-v01-doesnt-check" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "用一句话解释 LLM 中转站是什么"}
    ]
  }'
```

预期输出大致如下：

```json
{
  "id": "chatcmpl-xxxxxxxx",
  "object": "chat.completion",
  "created": 1747300000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "LLM 中转站是位于客户端与上游 LLM API 之间的一层 HTTP 服务，统一暴露 OpenAI 兼容协议，承担路由、鉴权、计费、限流等职责。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 18, "completion_tokens": 56, "total_tokens": 74 }
}
```

服务端控制台会同时打印结构化日志：

```
[12:34:56.789] INFO: relay
    model: "deepseek-chat"
    status: 200
    latency_ms: 1234
```

## 故意暴露的缺陷

v0.1 是全书的起点，刻意把以下问题留给后续章节解决：

| 缺陷 | 解决章节 |
|------|---------|
| 上游 Key 共享，无法按用户吊销 | 第 4 章「不再共享主 Key」 |
| 只能对接单一上游 | 第 2 章「一个入口，多家上游」 |
| 无鉴权，任何客户端可消耗额度 | 第 4 章 |
| 无计费、无用量归因 | 第 5 章「每一分钱的归属」 |
| 无限流、无配额 | 第 6 章「限流与配额」 |
| 不支持流式响应 | 第 7 章「SSE 流式透传与反向取消」 |
| 无多渠道故障转移 | 第 8 章「渠道池与故障转移」 |
| 日志非结构化、无 trace | 第 9 章「可观测性与看板」 |

## 场景 A 企业内部基建需求清单

把这个 v0.1 放到企业内部 LLM 平台场景下，要补齐以下能力才能上线：

- [ ] 按部门 / 项目签发内部 Key（带 `owner`、`cost_center`、`expires_at` 元数据）
- [ ] Bearer Token 鉴权中间件，所有请求必须带合法内部 Key
- [ ] 多上游 provider 支持（OpenAI、Azure OpenAI、内网 vLLM / Ollama）
- [ ] 按 Key / 模型 / 业务线三个维度的用量记录
- [ ] 按月度配额限制单个项目的最大消费
- [ ] 全量 prompt 与响应留底（合规审计要求）
- [ ] 按 trace_id 反查任意一次请求的全链路
- [ ] 按部门聚合的成本归因报表
- [ ] Key 即时吊销 + 单部门吊销不影响其他部门
- [ ] 内部模型与外部模型的统一调用入口（同一套 SDK）

## 场景 B 对外创业卖 token 需求清单

把这个 v0.1 改造成对外销售的产品，要补齐以下能力：

- [ ] 用户注册 / 登录 / 密码找回
- [ ] 用户充值（支付宝 / 微信 / USDT）、余额账户
- [ ] 按用户签发 API Key、Key 与余额绑定
- [ ] 余额扣减接入请求计费链路，余额不足拒绝请求
- [ ] 多模型一站式（至少覆盖 OpenAI、Anthropic、Google、DeepSeek 四家）
- [ ] 多上游 Key 池 + 故障转移 + 自动禁用 + 健康检查
- [ ] 价差套利：同模型挂多个低价渠道，按权重路由
- [ ] Prompt caching 透传，降低重复 prompt 成本
- [ ] Batch API 异步通道，把可异步任务转 50% 折扣通道
- [ ] 用户侧用量看板（今日消耗、Top 模型、调用历史）
- [ ] QPS 限流防止单账号薅羊毛
- [ ] 公开的服务可用性页面 + SLA 承诺
- [ ] 退款与对账流程
- [ ] 模型指纹检测（自证不偷换模型，参考 Ch10 的 `model-fingerprint-cli`）

两份清单合计约 24 项，本书会逐一在后续章节落地。
