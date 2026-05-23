# 第 2 章 v0.2 配套代码

一个入口，多家上游。客户端发的请求体只改 `model` 字段，就能在 OpenAI 与 DeepSeek 之间切换，对外响应格式完全一致。

## 目录结构

```
src/
  index.ts           # Hono 入口, 按 model 路由
  types/
    ir.ts            # IR 类型定义 (OpenAI 兼容)
  adaptors/
    base.ts          # ProviderAdaptor 接口
    openai.ts        # OpenAI 实现 (兼容族基类)
    deepseek.ts      # DeepSeek 实现 (继承 OpenAIAdaptor)
  router.ts          # model 前缀 -> adaptor 注册表
```

## 依赖

- Node.js 20+
- npm

## 启动

```bash
cp .env.example .env
# 编辑 .env, 填入你自己的 OPENAI_API_KEY 与 DEEPSEEK_API_KEY
# 任一上游 Key 为空时, 对应的请求会被上游拒绝, 但服务本身能正常起来

npm install
npm run dev
```

服务监听 `http://localhost:3000`。

## 验证：同一请求体只换 model 字段

健康检查会返回当前注册的路由表：

```bash
curl http://localhost:3000/healthz
# {"ok":true,"version":"v0.2","routes":[
#   {"prefix":"deepseek-","provider":"deepseek"},
#   {"prefix":"gpt-","provider":"openai"},
#   {"prefix":"o1-","provider":"openai"},
#   {"prefix":"o3-","provider":"openai"}
# ]}
```

发起一次 OpenAI 请求：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "user", "content": "用一句话解释 LLM 中转站"}
    ]
  }'
```

把同一个请求体的 `model` 字段从 `gpt-4o-mini` 改成 `deepseek-chat`，再发一次：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "用一句话解释 LLM 中转站"}
    ]
  }'
```

两次请求对外响应结构完全一致（OpenAI Chat Completions 格式）。

服务端控制台会打印结构化日志，注意 `provider` 字段不同：

```
[12:34:56.789] INFO: relay
    provider: "openai"
    model: "gpt-4o-mini"
    status: 200
    latency_ms: 812

[12:34:58.012] INFO: relay
    provider: "deepseek"
    model: "deepseek-chat"
    status: 200
    latency_ms: 1456
```

## 相对 v0.1 的核心变化

| 变化 | 文件 | 说明 |
|------|------|------|
| 抽出 ProviderAdaptor 接口 | `src/adaptors/base.ts` | 4 个最小必要方法：name / getEndpoint / buildRequest / parseResponse |
| 抽出 IR 类型 | `src/types/ir.ts` | 用 OpenAI Chat Completions 协议作为统一 IR |
| OpenAI 适配器 | `src/adaptors/openai.ts` | 作为「OpenAI 兼容族基类」可复用 |
| DeepSeek 适配器 | `src/adaptors/deepseek.ts` | 继承 OpenAIAdaptor，只换 baseURL，14 行实现 |
| 模型路由表 | `src/router.ts` | model 前缀 → adaptor 注册表 |
| Hono 入口重写 | `src/index.ts` | 走「校验 → 路由 → 构造请求 → 转发 → 归一化」五步 |
| 日志加 provider 字段 | `src/index.ts` | 后续 Ch9 升级为 trace_id 全链路 |

## 添加新的 OpenAI 兼容上游

例如要加 Moonshot，只要三步：

1. 在 `src/adaptors/` 下新建 `moonshot.ts`，10 行内继承 `OpenAIAdaptor` 即可
2. 在 `.env.example` 加 `MOONSHOT_BASE_URL` 与 `MOONSHOT_API_KEY`
3. 在 `src/index.ts` 的 `router` 数组里追加一条 `{ prefix: 'moonshot-', adaptor: new MoonshotAdaptor(...) }`

第 3 章 Anthropic 不能用这种「继承换 baseURL」的简化路径，原因见正文。

## 暂不支持的能力

| 缺陷 | 解决章节 |
|------|---------|
| 无鉴权 | 第 4 章 |
| 不计费、不限流、不可观测 | 第 5-9 章 |
| 不支持流式 | 第 7 章 |
| 异构协议（Anthropic）适配 | 第 3 章 |
