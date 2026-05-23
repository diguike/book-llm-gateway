# 第 12 章 v1.0 配套代码: 一键上线最小原型

v0.11 把变现链路也补齐了, 但 11 章每章产出的是一个**独立 example** —— 11 份 schema、
11 份环境变量、11 份 mock. 同事说「想试试」时, 没有一条 `docker compose up` 能起
整套. v1.0 的任务是把这 11 座孤岛**缝合成一个可部署的系统**, 不增加业务功能, 只做
工程整合.

## 这一章相对 v0.11 的核心变化

| 维度 | v0.11 | v1.0 |
|------|------|------|
| 环境变量管理 | `process.env.X` 散读 | `src/config/env.ts` zod 校验, 启动时一次性检查 |
| 健康检查 | 单一 `/healthz` (拼了所有信息) | `/healthz` (liveness, k8s 重启) + `/readyz` (readiness, k8s 摘流, 跑 DB + channels + wallets 三检查) |
| Migration | 0001..0007, 各章累加 | 0001..0008 (新增 0008 v1 release marker, 历史读者也能跑) |
| 部署形态 | 三个 terminal 各跑一个进程 | `docker compose up` 一条命令起整套 |
| 镜像 | 无 | 多阶段 Dockerfile (deps → builder → runner) |
| 端到端验证 | 单功能 test 脚本 | `npm run smoke` 一次跑完整链路 |
| 压测 | 无 | `npm run stress` autocannon 30 并发 10s |
| 部署目标对比 | 无 | DEPLOYMENT.md 三种 (Node / Bun / CF Workers) 对照 |

## 9 项核心能力对照

下面是 book.meta.yaml 的 minimal_prototype 清单, v1.0 全部覆盖. 跑哪条命令能验证它工作:

| 能力 | 实现位置 | 验证命令 |
|------|---------|---------|
| 多上游路由 | `src/router.ts` + `src/adaptors/` | `npm run smoke` 第 7 步 |
| 协议转换 | `src/adaptors/openai.ts` + `anthropic.ts` | `npm run smoke` 第 7-8 步 (openai 协议入站, mock 上游 OpenAI 协议) |
| 鉴权 | `src/auth/middleware.ts` | `npm run smoke` 第 4-5 步 (建 key + 用 key 调用) |
| 计费 | `src/billing/calculator.ts` | `npm run smoke` 第 9 步 (dashboard 查得到 totalCostMicro > 0) |
| 限流 | `src/limit/middleware.ts` | `npm run attack` (注入 GLOBAL_QPS_LIMIT=10 后跑攻击脚本) |
| 渠道 | `src/channels/` | `npm run failover-test` (上游 401 自动禁用 + 健康检查恢复) |
| 流式 | `src/streaming/sse-proxy.ts` | `npm run smoke` 第 8 步 (SSE 流式 + [DONE] 哨兵) |
| 可观测性 | `src/dashboard/` + `src/log/` | `npm run smoke` 第 9 步 (dashboard JSON 总览) |
| 成本优化 | `src/optimization/` | `npm run cost-router-test` (5 channel 按 cost_priority 排序) |

加上 v0.11 的钱包 / 支付:

| 能力 | 实现位置 | 验证命令 |
|------|---------|---------|
| 钱包 (乐观锁) | `src/wallet/service.ts::deductBalance` | `npm run wallet-concurrency-test` |
| 支付 (PaymentAdaptor) | `src/payment/` | `npm run payment-flow-test` |

## 快速开始

### 方式一: docker compose (推荐, 一条命令)

```bash
cd examples/12-ship-it
cp .env.example .env  # 至少改 ADMIN_TOKEN
docker compose up --build
```

起完后:

- 主网关: <http://localhost:3000>
- mock LLM 上游: <http://localhost:4010>
- mock 支付平台: <http://localhost:5010>

健康检查:

```bash
curl http://localhost:3000/healthz
# {"ok":true,"uptime_s":12,"ts":"2026-05-15T..."}

curl http://localhost:3000/readyz
# {"ok":true,"checks":[{"name":"sqlite",...},{"name":"channels",...},{"name":"wallets_table",...}],...}
```

跑端到端冒烟 (在另一个 terminal 里):

```bash
docker exec -it llm-gateway npx tsx src/scripts/e2e-smoke.ts
```

或本地直接跑 (需要先 `npm install`).

### 方式二: 不用 docker (本地 Node 环境)

```bash
cd examples/12-ship-it
cp .env.example .env  # 至少改 ADMIN_TOKEN
npm install
npm run migrate         # 跑 0001..0008 共 8 份 migration
npm run mock &          # mock LLM 上游, :4010
npm run mock-pay &      # mock 支付平台, :5010
npm run start           # 主网关, :3000
```

跑端到端冒烟 (会自己起所有依赖, 用临时数据库, 跑完清理):

```bash
npm run smoke
```

预期输出最后一行:

```
=== e2e-smoke PASSED === {"checks_passed":10,...}
```

## 配置: src/config/env.ts

v1.0 的所有环境变量统一收口到 `src/config/env.ts`. 启动时跑 `loadEnv()` 一次性校验,
缺失或类型错直接 `process.exit(1)`. 业务代码不再 `process.env.X` 散读, 全部从 zod
解析后的强类型 `env` 对象拿.

漏配示例 (故意把 `ADMIN_TOKEN` 改太短):

```bash
ADMIN_TOKEN=abc npm run start
# [env] config validation failed:
#   - ADMIN_TOKEN: ADMIN_TOKEN must be at least 8 chars
# (process exits with code 1)
```

完整字段清单见 `.env.example`.

## 健康检查端点

### `/healthz` (liveness)

进程还活着. k8s 失败重启 pod. 不检查依赖.

```bash
curl http://localhost:3000/healthz
# {"ok":true,"uptime_s":N,"ts":"..."}
```

### `/readyz` (readiness)

进程已准备好接客户端流量. k8s 失败摘流. 跑三项检查:

1. SQLite 可达 (`SELECT 1`);
2. channels 表至少有 1 个 active;
3. wallets 表已建 (env `READINESS_REQUIRE_WALLET=true` 时).

任何一项失败返 503 + 失败明细:

```bash
curl http://localhost:3000/readyz
# 200:
# {"ok":true,"checks":[{"name":"sqlite","ok":true,"duration_ms":0},
#                      {"name":"channels","ok":true,"detail":"active=5/5 (need ≥1)","duration_ms":0},
#                      {"name":"wallets_table","ok":true,"detail":"present","duration_ms":0}],...}
```

## 端到端冒烟测试

`npm run smoke` 跑一次完整请求生命周期, 自动起所有依赖, 跑完清理:

1. /healthz pass + /readyz pass
2. admin 建 org + user (自动建 wallet)
3. admin 建 key
4. admin 创建充值订单
5. mock 平台异步回调入账
6. 非流式 chat 调用 (走完整鉴权 → preConsume → 上游 → postConsume → observability)
7. 流式 chat 调用 (SSE 透传 + [DONE] 哨兵 + 流式计费)
8. dashboard JSON 总览查得到 totalRequests >= 2
9. 退款 → 异步回调 → 钱包扣穿 (允许变负)

## 短时压测

```bash
STRESS_DURATION_S=10 STRESS_CONCURRENCY=30 npm run stress
```

输出示例:

```json
{
  "stage": "result",
  "duration_s": 10,
  "concurrency": 30,
  "requests": 2561,
  "rps_avg": 256.11,
  "latency_p50_ms": 106,
  "latency_p99_ms": 402,
  "errors": 0
}
```

数字不是绝对值 (取决于硬件 / 上游延迟), 主要看 `errors` 是 0 + p99 在合理范围.

## 三种部署目标的对比

见 [DEPLOYMENT.md](./DEPLOYMENT.md).

简短结论:

- **现在就要上线 + 小团队**: Node.js + systemd. 直接跑 v1.0.
- **追求 runtime 性能**: Bun + 单机. 加一个 db client adapter.
- **流量全球分布**: CF Workers + D1. 改动大但能省运维.

## 续作路线图

v1.0 已经能上线, 但仍未覆盖 (见正文「续作路线图」一节):

- 多区域部署 (跨大区延迟)
- 审计合规 (SOC2 / 金融客户)
- 多租户子账户 (每个外部客户独立子账户)
- Postgres 切换 (突破 SQLite 单文件并发)
- Redis 切换 (限流 / 缓存跨进程共享)
- MCP server 对接

这些是 v2.0 的工程问题. 对小团队 / 创业者来说, v1.0 已经够用.

## 引用

- Docker 多阶段构建最佳实践: <https://docs.docker.com/build/building/best-practices/>
- Node.js 官方镜像最佳实践: <https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md>
- autocannon 用法: <https://github.com/mcollina/autocannon>
- Cloudflare Workers 限制: <https://developers.cloudflare.com/workers/platform/limits/>
- Drizzle + D1 适配: <https://orm.drizzle.team/docs/get-started-sqlite#cloudflare-d1>
