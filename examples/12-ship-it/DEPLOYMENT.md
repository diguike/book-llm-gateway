# v1.0 部署指南: 三种目标对照

v1.0 的代码本身在三种部署目标上都能跑, 但每种目标对外部依赖 (better-sqlite3 native /
in-memory cache / 长连接 SSE) 的兼容程度不同, 改动量也不同. 这份文档列每种目标的
**取舍 + 改动清单 + 一份最小可工作配置**.

## 选哪种?

| 部署目标 | 适用场景 | 改动量 | 性能 | 痛点 |
|---------|---------|-------|------|------|
| Node.js + 单机 | 小团队 / 内部基建 / 个人中转站 | 0 | 中 | 单机, 没有跨机扩展 |
| Bun + 单机 | 想要更快冷启动 / 已经在用 Bun | 小 (better-sqlite3 兼容性) | 高 | better-sqlite3 在 Bun 上偶有兼容问题 |
| Cloudflare Workers + D1 | 全球边缘 / 不想运维 / 流量极不均匀 | 大 (替换 SQLite + 改 long-running) | 取决于 D1 | 长 SSE 连接受 Workers 限制 |

下面分别给出每种目标的「最少改动 + 最小可工作配置」.

## 一、Node.js + 单机 (推荐起点)

最简单, 不需要改任何代码. v1.0 默认就是这条路径.

### PM2

PM2 适合「单机起多个 Node 进程, 用 cluster 模式分摊请求」的场景. SQLite 在多进程下
**不能共享 in-memory 状态** (限流 / 看板缓存), 但 SQLite 文件本身的多进程读写没问题
(SQLite 用文件锁串行化写). 所以 PM2 cluster 模式只对「无状态请求路径」有意义.

```bash
npm install -g pm2

# 单进程
pm2 start "npx tsx src/index.ts" --name llm-gateway

# 多进程 (注意: 限流/缓存不跨进程, 真要跨进程上 Redis)
pm2 start "npx tsx src/index.ts" --name llm-gateway -i 2

# 开机启动
pm2 startup
pm2 save

# 查日志
pm2 logs llm-gateway
```

### systemd

更简单, 不引入额外依赖. 适合 Linux 服务器.

```ini
# /etc/systemd/system/llm-gateway.service
[Unit]
Description=LLM Gateway v1.0
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/llm-gateway
EnvironmentFile=/opt/llm-gateway/.env
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用:

```bash
sudo systemctl daemon-reload
sudo systemctl enable llm-gateway
sudo systemctl start llm-gateway
sudo journalctl -u llm-gateway -f
```

### 上 Nginx 反代

必须做的两件事:

1. `proxy_buffering off` —— SSE 流式不能被 Nginx 缓冲, 否则首字节延迟极大.
2. `proxy_read_timeout 600s` —— 长流式响应要把超时调大, 否则 Nginx 中途切流.

`nginx.conf.example` 里有完整可用的配置, 直接抄.

### 想用 dist 而不是 tsx?

教学版 v1.0 镜像直接 `npx tsx src/index.ts`. tsx 会在启动时即时编译 TS, 比 dist 慢
1-2 秒, 内存多 30MB 左右, 但省了编译步骤. 真正在意启动延迟的:

```bash
# 1. 加一个 tsc 配置 (compilerOptions.outDir = ./dist)
npm run build:dist  # tsc -p tsconfig.json (改 noEmit=false + outDir)

# 2. 跑编译产物
node dist/index.js
```

记得 `package.json` 加 `"main": "dist/index.js"`. Dockerfile 的 CMD 也改成
`["node", "dist/index.js"]`.

## 二、Bun + 单机

[Bun](https://bun.sh) 的吸引力在「比 Node 更快的冷启动 + 内置 TS / fetch」. 把 v1.0 跑
在 Bun 上需要解决一个问题: **better-sqlite3 在 Bun 上偶有兼容问题**.

### better-sqlite3 的 Bun 兼容现状

Bun 1.0+ 实现了大部分 N-API, better-sqlite3 通常能跑, 但偶尔在 native binding
加载阶段报 `dlopen failed`. 推荐两种应对:

- **方案 A: 用 Bun 自带的 `bun:sqlite`**. 它的 API 接近 better-sqlite3 但不完全一样,
  需要在 `src/db/client.ts` 里加一个 adapter 层: 探测到 Bun 时用 `bun:sqlite`,
  其他用 better-sqlite3.
- **方案 B: 强制 Bun 用 Node N-API 加载 better-sqlite3**. 启动时加 `--bun` flag.
  不保证未来版本仍能用.

最小改动 (方案 A 框架):

```ts
// src/db/client.ts (修改后)
let sqlite: import('better-sqlite3').Database;

if (typeof (globalThis as any).Bun !== 'undefined') {
  // Bun 环境: 用 bun:sqlite, 包一层兼容层
  const { Database } = await import('bun:sqlite');
  // ... API 适配 (prepare / all / get / run 大致一致, but transaction 和 returning 略不同)
  throw new Error('Bun adapter is a TODO -- see DEPLOYMENT.md, Bun 一节');
} else {
  const Better = (await import('better-sqlite3')).default;
  sqlite = new Better(process.env.DATABASE_URL!);
}
```

教学版 v1.0 不附带 Bun adapter, 留作扩展. 想推进的读者可以参考 LiteLLM 的 `src/db/client.py`
看它怎么做 SQLite / Postgres 双适配.

### 启动

```bash
# 安装 Bun (如果没有)
curl -fsSL https://bun.sh/install | bash

# 跑 (不需要 npm install, Bun 兼容 npm registry)
bun install
bun run src/index.ts
```

### 性能差异

实测 `npm run stress` 同样 30 并发 × 30s, Bun 比 Node 高约 30-50% RPS, 主要来自
fetch 实现 (Bun 用 BoringSSL + 自己的 HTTP 解析器). 但对于 LLM 网关来说, 上游
延迟才是瓶颈, runtime 开销占比小, 所以 Bun 收益不一定那么明显.

参考: [Bun docs - bun:sqlite](https://bun.sh/docs/api/sqlite)

## 三、Cloudflare Workers + D1

边缘部署. 适合「全球流量 / 不想运维服务器 / 流量极不均」的场景. 改动量最大, 几乎
是把整个持久层重写.

### 不能用的能力

Workers 的 [运行时限制](https://developers.cloudflare.com/workers/platform/limits/) 决定了:

| 能力 | Workers 上的状态 |
|------|----------------|
| `better-sqlite3` | ❌ 完全不可用. 必须换 D1. |
| `pino` 文件日志 | ❌ Workers 没有文件系统. 用 `console.log` 走 wrangler tail. |
| 长连接 SSE | ⚠️ 受限. CPU 时间默认 30s (付费可调到 5min), 单连接 wall time 无硬限. |
| `setInterval` 健康检查 | ❌ Workers 不能跑后台 worker. 用 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 替代. |
| in-memory 限流 | ⚠️ 可用但**不跨实例**. 必须换 [Durable Objects](https://developers.cloudflare.com/durable-objects/) 或 KV. |
| `Buffer` | ⚠️ 部分可用 (Workers polyfill), 加密 API 用 Web Crypto 不要用 `node:crypto`. |

### 改动清单

最少 7 处必改:

1. **`src/db/client.ts`**: 换 [D1 binding](https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/).
   D1 是 sqlite-compatible 的, 但 API 是 `env.DB.prepare(sql).all()` 而不是
   `db.prepare(sql).all()`. Drizzle 有 [d1 adapter](https://orm.drizzle.team/docs/get-started-sqlite#cloudflare-d1).

2. **`src/limit/sliding-window.ts`**: in-memory 滑动窗口换 Durable Object.
   一个 DO 实例对应一个限流键 (例如 user_id), DO 内部维护时间窗.

3. **`src/limit/tpm-reservation.ts`**: 同上.

4. **`src/log/logger.ts`**: 换 `console.log`. 配 [Logpush](https://developers.cloudflare.com/workers/observability/logging/logpush/)
   把日志推到 R2 / 第三方.

5. **`src/channels/health-checker.ts`**: `setInterval` 改 Cron Trigger.
   `wrangler.toml` 配 `[[triggers]] crons = ["*/1 * * * *"]`, 单独写一个
   `scheduled` handler 跑 health check.

6. **`src/streaming/sse-proxy.ts`**: SSE 透传基本可用 (Workers 的 fetch 支持 stream),
   但要注意 [Subrequest 50 个限制](https://developers.cloudflare.com/workers/platform/limits/#subrequests):
   一个请求最多并发 50 个 fetch. 我们的渠道 fallback 最多 3 attempts, 远低于这个.

7. **`src/payment/mock.ts`**: `crypto.createHmac` 换 Web Crypto:
   ```ts
   const key = await crypto.subtle.importKey(
     'raw', new TextEncoder().encode(secret),
     { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
   const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(joined));
   const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
   ```

### 最小 wrangler 配置

```toml
# wrangler.toml
name = "llm-gateway"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "llm-gateway"
database_id = "<your-d1-id>"

[[durable_objects.bindings]]
name = "LIMITER"
class_name = "RateLimiter"

[vars]
ADMIN_TOKEN = "" # 用 wrangler secret put 设
```

### 性能 / 成本

D1 当前免费额度 5GB / 5M 行读 / 100k 行写每天. 小流量足够, 大流量比单机 SQLite
更贵 (按行计费). 但全球延迟更低.

适合什么场景: **流量分布广 (北美 + 欧洲 + 亚太都要低延迟)** + **流量极不均 (白天高
晚上几乎为零, 不想为闲置容量付费)**. 不适合: **大流量稳定** (Worker request
单价 + D1 行单价加起来比单机 vps 贵).

### 教学版仓库现状

v1.0 examples/12-ship-it 没有附带 wrangler.toml 与 D1 改造, 因为这条路径的工作量
基本等于「重写持久层」, 一本书的最后一章塞不下. 想完整跑 CF Workers 的读者可以
按上面的清单改, 或参考 [Drizzle + D1 官方示例](https://orm.drizzle.team/docs/get-started-sqlite#cloudflare-d1).

## 三种部署目标的取舍总结

- **现在就要上线 + 团队 < 50 人**: Node.js + systemd. v1.0 本身.
- **追求 runtime 性能 + 团队接受 Bun**: Bun + 单机. 加一个 db client adapter.
- **流量全球分布 + 不想运维**: CF Workers + D1. 改动大, 长期收益高.

绝大多数读者起步就用 Node.js + 单机. 跑到 SQLite 的并发瓶颈 (大约 1-2k QPS, 取决于
写比例) 再考虑切 Postgres 或拆服务.
