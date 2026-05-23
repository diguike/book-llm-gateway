---
title: 第 12 章 一键上线最小原型
feishu_url: "https://www.feishu.cn/wiki/QkhXwOUt9icKrTk7KVOcjCjJnec"
last_synced: "2026-05-16T18:29:29"
---

## 12.1 11 座孤岛，缝合成一个可部署系统

跟到这里的读者已经手握 11 份 example. 每一份都能独立 `npm install` 跑起来，每一份都
对应一章的核心议题:

```
examples/
  01-what-is-a-gateway/             30 行透传
  02-one-endpoint-three-providers/  按 model 路由
  03-anthropic-is-different/        协议适配
  04-stop-sharing-the-master-key/   Key 鉴权
  05-who-spent-my-money/            两阶段计费
  06-someone-is-abusing-my-gateway/ QPS + TPM
  07-stream-is-broken/              SSE 流式
  08-the-key-just-got-banned/       渠道池故障转移
  09-where-did-this-request-go/     trace_id + 看板
  10-why-is-relay-cheaper/          降本三件套
  11-how-do-i-charge-users/         钱包 + 支付
```

11 份各跑各的，单独看每一份都是合格的教学示例: 但作为一个**系统**, 它有四个缺口:

1. **schema 没合并**. 11 份各有自己的 `data/gateway.db`, 切到下一章必须删表重灌。
2. **环境变量分散**. 每一份的 `.env` 覆盖范围不一样，上线时不知道哪个字段一定要配。
3. **依赖手动起**. 跑 v0.11 的 e2e 要先开 mock LLM 上游 (terminal 1) + mock 支付平台
   (terminal 2) + 主网关 (terminal 3). 同事尝试一下要消耗 3 个 terminal + 一份操作
   清单，没有「一条命令起整套」的体验。
4. **没有健康检查**. v0.9 加了一个 `/healthz`, 但它返的是「网关启动后的状态总览」,
   不是 k8s 期望的「liveness + readiness 二分」. 部署到 k8s / Nginx 反代后面，探针
   不知道该问哪个端点。

第 12 章的目标是把这 4 个缺口补上，不增加业务功能。跟完这一章，读者得到的是一个**单一
工程目录**, `docker compose up` 起整套，端到端 smoke 一次跑通完整请求生命周期，三种
部署目标 (Node / Bun / Cloudflare Workers) 各自的 trade-off 写得清清楚楚。

四个缺口背后其实是同一件事。教学示例与工程产品的**完成度差距**. 教学示例只需要在「能
说明问题」的范围内可运行。工程产品需要让一个**没看过书的同事**也能拉起来用。这两者
的工作量比通常是 1:3 ——示例代码写完，整合工作才刚开始。第 12 章把这 1:3 里属于网关
本身的部分填齐，让读者拿到这本书时，完整路径已经走完。

v1.0 不增加业务功能这件事值得多说一句。整本书的 v0.X 编号意味着「能跑但仍有明显缺
口」, v1.0 意味着「可上线」. 从 v0.11 到 v1.0 不是新功能跃升，而是工程成熟度跃升。
对照语义版本号 (semver) 的语义, major 版本号增加表达的是「兼容性 / 接口稳定性」，不是
「新增能力」. v1.0 的兑现处恰好是这个——前 11 章的能力一个不少，但「拼成一个能交付出去
的东西」.

工程成熟度跃升的另一个潜台词是「问题暴露的时机往前移」. v0.11 之前，一个错误的环境
变量、一个 schema 没跑过的部署、一个 channel 全部 disabled 的状态，这些问题都要等到
**第一次发请求时**才暴露。流量进来之后才挂，客户已经看到了 502, 才反过来排查. v1.0
把这些问题统统提前到「启动期」或「探针期」: 配错 env 启动失败, schema 没跑 readyz 503,
channel 全挂 readyz 503 + 看板秒级可见: 流量被挡在网关之前，客户看不到 502, 你看到
告警。这是 v0.X 跟 v1.0 之间最实在的差别。

跟到这里的读者大概率会做一件事。把 v0.11 的某个 example 或 v1.0 拉出来，配上自己的
真实上游 key, 起在公司内网或某个 vps 上，让小范围用户开始用。这一章就是为了让这个动作
能在两小时内完成，而不是两周——后者通常发生在「示例代码很零散，整合工作要从头做」的
项目上。

下面按四个缺口逐一处理。

## 12.2 配置管理: zod 校验 + 三套环境

v0.11 的代码里有这种散读:

```ts
// v0.11 (src/index.ts)
const PORT_FROM_ENV = Number(process.env.PORT ?? 3000);
const MOCK_PAY_BASE_URL = process.env.MOCK_PAY_BASE_URL ?? 'http://localhost:5010';
const MOCK_PAY_SECRET = process.env.MOCK_PAY_SECRET ?? 'test-mock-secret';
const PAYMENT_NOTIFY_BASE = process.env.PAYMENT_NOTIFY_BASE ?? `http://localhost:${PORT_FROM_ENV}`;
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 4096);
const GLOBAL_QPS_LIMIT = Number(process.env.GLOBAL_QPS_LIMIT ?? 0);
// ... 12 行类似
```

它能跑。但它有三个问题:

- **拼写错误不报错**. `OPENAI_API_KEY` 写成 `OPENAI_KEY`, 上线后第一次发请求才上游 401.
- **类型错误延迟暴露**. `PORT=abc npm run start`, 启动成功，但 listen 时报「invalid
  port: NaN」，看不出根因。
- **必填字段没强制**. `ADMIN_TOKEN` 留默认值 `admin-change-me` 上生产，等于裸奔。

v1.0 把所有 env 收口到 `src/config/env.ts`, 用 zod 在启动时一次性校验:

```ts
// src/config/env.ts (节选)
const EnvSchema = z.object({
  NODE_ENV: z.enum(['dev', 'prod', 'test']).default('dev'),
  PORT: intFromString(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (SQLite file path)'),
  ADMIN_TOKEN: z.string().min(8, 'ADMIN_TOKEN must be at least 8 chars'),
  // ... 30+ 字段
});

export function loadEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] config validation failed:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  // 跨字段约束: prod 模式 ADMIN_TOKEN 不能是默认值
  if (parsed.data.NODE_ENV === 'prod' && parsed.data.ADMIN_TOKEN === 'admin-change-me') {
    console.error('[env] ADMIN_TOKEN is still the default placeholder. set a strong random token in production.');
    process.exit(1);
  }
  return parsed.data;
}
```

主入口 `src/index.ts` 启动第一行就调:

```ts
const env = loadEnv();
const bootLogger = getRootLogger();
bootLogger.info({ node_env: env.NODE_ENV, port: env.PORT }, 'env_validated');
```

故意配一个错误的 env 看效果:

```bash
ADMIN_TOKEN=abc npm run start
# [env] config validation failed:
#   - ADMIN_TOKEN: ADMIN_TOKEN must be at least 8 chars
# (process exits with code 1)
```

启动失败比运行时失败快得多。一个 typo 的 env 名在 v0.11 之前会等到第一次发请求时上游
401 才报错; v1.0 启动就报, exit code = 1, systemd / docker / k8s 都能识别为启动失败，
不会把流量调度到这个坏实例。

业务代码不再 `process.env.X` 散读。主路径直接用强类型 `env`:

```ts
// v1.0 (src/index.ts)
const DEFAULT_MAX_TOKENS = env.DEFAULT_MAX_TOKENS;     // 类型 number
const GLOBAL_QPS_LIMIT = env.GLOBAL_QPS_LIMIT;         // 类型 number
const SSE_HEARTBEAT_MS = env.SSE_HEARTBEAT_MS;         // 类型 number
```

不再有 `Number()` 转换，也不再有 `?? defaultVal`. 默认值在 `src/config/defaults.ts`
统一管理。

**三套环境**通过 `NODE_ENV=dev|prod|test` 区分，主要差异是:

- `dev`: ADMIN_TOKEN 可以用默认值 (开发方便), LOG_LEVEL 通常 `debug`.
- `prod`: ADMIN_TOKEN 不能等于 `admin-change-me` (启动失败), 没配真实上游 key 时会
  warn (允许只用 mock channel 跑，但是会提醒).
- `test`: 与 dev 相同的宽容度，但用更短的健康检查 / SSE 心跳间隔 (跑 e2e 测试更快).

跨字段校验集中在 `loadEnv()` 内部，不散落到业务代码。这种「校验是 env.ts 的责任，
业务只读强类型 env 对象」的纪律，让后续加新字段的工作量稳定在「改 1 个文件」.

值得特别说的是 `loadEnv()` 的「单例 + 缓存」语义: 它内部维护一个 `cached: AppEnv | null`,
第一次调用做完整 zod 解析，后续调用直接返回缓存。这避免了「同一份代码多次跑 schema
解析」的浪费 (schema 实例化是一次性成本，但 `safeParse` 本身有可观开销). 同时它也强制
了一个不变量——**整个进程生命周期内 env 不可变**. 想动态改环境。先重启进程，别在运行
时偷偷修改 `process.env`. 这条不变量让限流 / 计费这些「读 env 配置作为决策因子」的模块
不需要担心配置突变。

另一个易踩的坑是 `migrate.ts` 这种 cli 入口要不要校验 env. v1.0 的选择是**不强制**——
`migrate.ts` 只读 `DATABASE_URL` 一个字段，让它跑全套 zod 校验等于让运维必须配上所有
上游 key 才能 migrate, 这违反直觉。所以入口分两类: `index.ts` (主网关。进 `loadEnv()`,
`migrate.ts` 直接读 `process.env.DATABASE_URL`. 这是工程上的合理妥协: env.ts 只对**有
义务校验全集的入口**强制，不污染纯运维工具。

## 12.3 Migration 合并。保留 0001-0007, 新增 0008 v1 marker

v0.11 跑 `npm run migrate` 会顺序应用 7 份 migration:

```
0001_init.sql              orgs / users / keys
0002_billing.sql           prices / usage_records
0003_quota.sql             keys.monthly_quota
0004_channels.sql          channels / abilities + 反范式索引
0005_observability.sql     usage_records 加 trace_id / channel_id / latency
0006_cost_optimization.sql channels.cost_priority + prices 加 cache/batch 单价
0007_payment.sql           wallets / recharges / refunds
```

v1.0 的合理做法是「合并成一份初始化 schema」吗。实际上不是。三个理由:

**理由一。不破坏老读者的升级路径**. 如果一个读者从 v0.4 一路跟到现在，他的本机 SQLite
里已经有 0001-0007 全部应用记录。我们如果把这些合并成 `0001_initial_v1.sql`, 他的
`__drizzle_migrations` 表与新 schema 不一致，升级会跑挂。真实生产中也是这个原则——
**migration 一旦发布就不能回头改**, 它是不可变的历史。

**理由二。教学价值**. 7 份 migration 是「从空网关到 v0.11」的演化史，每一份对应一章
的新增功能。保留对照关系比合并更有用。读者按章对照「这一章动了哪些表」，能看到
schema 怎么从 3 张表 (orgs / users / keys) 长到 13 张表的全过程。

**理由三: fresh install 体感等价**. 如果是全新部署, `npm run migrate` 按 0001-0008
顺序一次跑完，总耗时 < 100ms. 体感上和「一份初始化 schema」没区别。

v1.0 新增的 `0008_v1_release.sql` 不增加任何表，只是一个版本标识:

```sql
-- drizzle/0008_v1_release.sql
SELECT 'v1.0_release_marker' AS version;
```

它写进 `__drizzle_migrations` 表后，运维直接 `SELECT MAX(filename) FROM __drizzle_migrations`
就能确认「这个数据库到没到 v1.0 schema」. 以后 v1.1 再加新表时，编号往 0009 走。

migration 的另一道纪律是「从不跑 down」. 这一点跟很多教程相反——很多 ORM 教学会同时
教 up 和 down. 真实生产的经验是。一次错误的 down 比十次错误的 up 更致命 (前者是数据
不可逆丢失). 我们的 `migrate.ts` 实现里完全没有 down——文件名只匹配 .sql, 不区分 up/down,
不暴露 rollback 接口: 想要回退。备份 SQLite 文件, restore 回去。这种朴素方法跑得稳，
不引入新故障面。

跨章节的 schema 演化里有几个值得记的设计动作:

- v0.4 → v0.5: `users` 加 `balance_micro`, 但**不动**任何老字段: 这是「演进不破坏」
  的第一次实践。
- v0.5 → v0.8: `usage_records` 表 (Ch5 建。在 Ch8 加 `channel_id`, 在 Ch9 加 `trace_id`.
  既不重命名字段，也不删字段，只 ALTER TABLE ADD COLUMN. SQLite 在这种纯加列的场景
  下零代价 (不重写表).
- v0.10 → v0.11: 余额从 `users.balance_micro` 搬到 `wallets.balance_micro`. 这次有「数据
  迁移逻辑」(老 user 的 balance 复制到新 wallet, 由 cli/seed-wallet.ts 完成), 但 SQL
  层依然是「只加新表 + 只加新字段」，不破坏 `users.balance_micro`. 老接口仍然可用，
  v1.0 整合时才彻底删。

8 份 migration 加起来约 530 行 SQL. 一份「初始化 schema」如果合并起来也是这个量级。
跑 `npm run migrate` 在新环境的总耗时 < 100ms, 不是性能瓶颈。

## 12.4 Docker 化。多阶段构建 + docker-compose

v1.0 的 `Dockerfile` 分三阶段，这是 Node.js 镜像的标准模式
([Docker 官方最佳实践](https://docs.docker.com/build/building/best-practices/),
[Node.js 官方 docker 推荐](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)):

```dockerfile
ARG NODE_VERSION=20
ARG NODE_IMAGE=node
ARG NODE_VARIANT=slim

# ---------- stage 1: deps ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- stage 2: builder ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build  # = tsc --noEmit, 失败时整个镜像构建失败

# ---------- stage 3: runner ----------
FROM ${NODE_IMAGE}:${NODE_VERSION}-${NODE_VARIANT} AS runner
WORKDIR /app
ENV NODE_ENV=prod
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
```

三阶段的工程价值:

1. **deps 阶段**只跑一次 `npm ci`. Docker 构建缓存按 layer 命中, package.json 不变时
   这一层完全不重跑。这是镜像构建提速的核心——平时改业务代码, deps 层永远命中。
2. **builder 阶段**装上完整源码 + 跑 `npm run build`. v1.0 用 `tsc --noEmit` 当 build,
   只做类型校验 + 不落 dist 文件。想用 dist 的部署见 `DEPLOYMENT.md`.
3. **runner 阶段**用最干净的基底，只复制必要的部分: node_modules + drizzle + src +
   tsconfig. 不带文档、测试脚本、git 历史。攻击面更小，镜像更轻。

`USER node` 让进程以非 root 运行. node 官方镜像预置 uid=1000 的 `node` 用户，直接用
即可。跑 `docker exec -it` 进容器，默认就是 node 用户。

`HEALTHCHECK` 让 docker 自带的健康探针每 30 秒打一次 `/healthz`. 失败 3 次后容器状态
变成 `unhealthy`, docker swarm / k8s 据此摘流或重启。

为什么不用 alpine? alpine 用 musl libc, better-sqlite3 / node-gyp 在它上面经常踩坑——
编译产物在 glibc 容器里又跑不动。教学版用 `-slim` (Debian glibc) 最稳，镜像 ~250MB,
比 alpine 多 100MB 但兼容性零负担。真要用 alpine, 把 ARG `NODE_VARIANT` 传成 `alpine`,
RUN apt-get 换成 RUN apk add. v1.0 的 Dockerfile 就把这两个 ARG 暴露出来了，国内 /
内网环境也可以传 `NODE_IMAGE=docker.m.daocloud.io/library/node` 走镜像加速。

`docker-compose.yml` 起整套环境:

```yaml
services:
  gateway:
    build: .
    ports: ['3000:3000']
    environment:
      MOCK_BASE_URL: http://mock-upstream:4010      # 用 docker network 内的 hostname
      MOCK_PAY_BASE_URL: http://mock-payment:5010
      PAYMENT_NOTIFY_BASE: http://gateway:3000
    volumes:
      - ./data:/app/data       # SQLite 持久化到宿主机
    depends_on:
      mock-upstream: { condition: service_healthy }
      mock-payment:  { condition: service_healthy }
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1))..."]
      # 片段截断, 完整版 (含 interval / timeout / retries / start_period) 见 examples/12-ship-it/docker-compose.yml
  mock-upstream:
    build: .
    command: ['npx', 'tsx', 'src/scripts/mock-upstream.ts']
    ports: ['4010:4010']
    healthcheck: ...
  mock-payment:
    build: .
    command: ['npx', 'tsx', 'src/scripts/mock-payment-platform.ts']
    ports: ['5010:5010']
    healthcheck: ...
```

`depends_on.condition: service_healthy` 让 gateway 等 mock 两个服务都 healthy 才启动。
不然 gateway 可能在 mock 还没起来时第一次跑 channel 健康探针就把 mock 标成 disabled.

`volumes: ./data:/app/data` 把 SQLite 文件挂到宿主机，容器重启不丢数据: 真要做生产
持久化用命名卷 (`gateway-data:/app/data`) 更稳，但教学场景用 bind mount 让读者直接看
到文件。

跑 `docker compose up --build` 的预期输出:

```
[+] Building 6.3s (24/24) FINISHED
 ✔ Service mock-upstream  Built
 ✔ Service mock-payment   Built
 ✔ Service gateway        Built
[+] Running 4/4
 ✔ Network ship-it_default            Created
 ✔ Container llm-gateway-mock-upstream  Healthy
 ✔ Container llm-gateway-mock-payment   Healthy
 ✔ Container llm-gateway                Healthy
```

三个容器都到 `Healthy` 后，主网关在 :3000 可用。一条命令。

实测构建一次镜像 (alpine + 国内 daocloud 镜像源。总耗时约 60 秒，最终镜像大小 ~366MB. 这个数字是用 alpine variant 实测的; slim 默认会略大 (约 450MB), 多出来的是 glibc + Debian 基础包。
这里面 node_modules 占大头，一些极致优化 (only production deps + 不带 src + tsc 编译
后只放 dist) 能压到 200MB 左右，但教学版选稳定不选极致——直接 `npx tsx src/index.ts`
启动，容器里同时存在 src + node_modules + drizzle, 出问题时 `docker exec -it` 进去
直接读源码。真要节流再走 dist 路径, DEPLOYMENT.md 的 Node.js 一节给完整步骤。

`docker compose down -v` 关闭整套环境并清掉 volumes (注意 -v 会删本地 SQLite 文件).
平时改业务代码后只需 `docker compose up --build gateway`, 重新构建并起 gateway 一个
服务, mock 两个保持不变。这是 docker-compose 的增量构建特性，不需要每次都把整套
拆掉重起。

## 12.5 健康检查端点: liveness vs readiness

v0.9 加的 `/healthz` 把所有信息塞一起:

```ts
// v0.9
app.get('/healthz', (c) => {
  const snap = registry.snapshot();
  return c.json({
    ok: true,
    version: 'v0.9',
    channels: { total, active, disabled, probing },
    streaming: { sse: true, heartbeat_ms, max_channel_attempts },
    health_checker: { interval_ms },
    limits: { global_qps, global_tpm, ... },
  });
});
```

它对人友好 (curl 一下能看到所有状态), 对 k8s 不友好. k8s 的探针有两种:

- **liveness**: 失败重启 pod. 只能放「重启能解决」的检查 (例如事件循环卡死).
- **readiness**: 失败摘流。放「依赖未就绪」的检查 (例如 DB 还没 migrate).

把两件事混在一起的后果。一个 channel 暂时全部 disabled (受上游 401 风控影响。让
v0.9 的 healthz 返 200 还是 503? 返 503 会触发 pod 重启，但重启没用——上游 401 不
随重启消失，重启后还是 disabled, 反复 crashloop. 返 200 又骗了 k8s, 流量继续打过
来全部 502.

v1.0 把它拆开:

**`/healthz` (liveness)**, 只问「进程还活着吗」:

```ts
// src/health/liveness.ts
app.get('/', (c) =>
  c.json({
    ok: true,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  }),
);
```

任何更复杂的逻辑都不属于 liveness. 进程不死, /healthz 就 200.

**`/readyz` (readiness)**, 跑三项检查:

```ts
// src/health/readiness.ts (节选)
function checkDb(): ReadinessCheck {
  const sqlite = getRawSqlite();
  const row = sqlite.prepare('SELECT 1 as v').get() as { v: number };
  return { name: 'sqlite', ok: row.v === 1, duration_ms: ... };
}
function checkChannels(minActive: number): ReadinessCheck {
  const snap = getChannelRegistry().snapshot();
  const active = snap.filter((s) => s.status === 'active').length;
  return {
    name: 'channels', ok: active >= minActive,
    detail: `active=${active}/${snap.length} (need ≥${minActive})`,
    duration_ms: ...,
  };
}
function checkWalletsTable(): ReadinessCheck {
  // SQLite 元表查询, 不动业务数据
  const row = sqlite.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='wallets'"
  ).get();
  return { name: 'wallets_table', ok: row.c === 1, ... };
}
```

`/readyz` 任一项失败就返 503 + 失败明细:

```bash
curl http://localhost:3000/readyz | jq
{
  "ok": true,
  "checks": [
    { "name": "sqlite", "ok": true, "duration_ms": 0 },
    { "name": "channels", "ok": true, "detail": "active=5/5 (need ≥1)", "duration_ms": 0 },
    { "name": "wallets_table", "ok": true, "detail": "present", "duration_ms": 0 }
  ],
  "ts": "2026-05-15T..."
}
```

`/readyz` 503 时, k8s 把 pod 从 service endpoints 摘掉，不重启 (因为重启没用——比如
DB 文件没挂上来，重启还是没 DB). 等依赖恢复后 readyz 自动 200, k8s 自动把流量加回来。

每个检查都套超时 (默认 2s), 防止 readyz 自己卡死. SQLite ping 通常 < 1ms, 但极端
场景 (磁盘 IO 阻塞: 可能挂住，不能让 readyz 跟着挂。

v1.0 旧的「状态总览」端点搬到 `/admin/info`, 走 admin Bearer 鉴权，不让公网随便看
内部状态。探针端点保持公开 + 极薄。

readiness 检查可以更激进一点——比如要求至少 N 个 channel 是 active (默认 1, 通过
env `MIN_ACTIVE_CHANNELS` 调). 单 channel 满足语义底线，但生产场景下通常希望同 group
至少有 2-3 个 channel 互为备份。用 N=3 时，一个 channel 被风控 disabled 不会让 readyz
立即 503 (因为还有 2 个 active), 但全部 3 个挂掉会立即触发 503 + 摘流——再来的请求
会被 LB 路由到其他 region 的网关实例。

全新部署的边界值得提一句。默认 `MIN_ACTIVE_CHANNELS=1`, 意味着 admin 必须先注册至少 1 个 active channel 后 readyz 才会 200. 全新部署还没注册任何 channel 时 readyz 会一直 503, **这是预期行为不是 bug**——它的语义是「网关还没准备好接流量」. admin 注册第一个 active channel 后 readyz 自动 200, 不需要重启进程。第一次按 `docker compose up` 起整套的读者看到 503 不要慌，检查 `/admin/channels` 是不是空的。

readiness 还有一个常见误区。把它做成「全功能验证」，比如往上游真的发一笔请求看返回。
这是反模式. readiness 该做的是「依赖是否就绪」，不是「依赖是否完美工作」. 真发请求会
让上游频繁吃到无意义流量，上游又会按 QPS 限流, readyz 跟着 503, 雪崩。我们的 readyz
只查本地状态——SQLite 在不在、channel 在不在、wallets 表在不在。上游真坏了，让 channel
故障转移 + 健康检查机制自己处理 (Ch8 的内容), 不要拉着 readyz 一起报警。

## 12.6 端到端冒烟。一次跑完整请求生命周期

v0.11 之前每个能力有自己的 e2e 脚本——`stream-test.ts` / `failover-test.ts` /
`payment-flow-test.ts` 等。它们各跑各的，没有一个脚本能验证「整个系统串起来工作」.

v1.0 加 `npm run smoke`, 用 `src/scripts/e2e-smoke.ts` 一次跑完 10 步:

```
// e2e-smoke 自动起所有依赖, 跑完清理:
// step  1. /healthz pass        (liveness)
// step  2. /readyz pass         (readiness, 含 sqlite + channels + wallets)
// step  3. admin 建 org + user  (自动建 wallet)
// step  4. admin 建 key         (sk-gw-xxx)
// step  5. admin 创建充值订单   (10 元 mock 支付)
// step  6. 等 mock 平台异步回调入账, wallet.balance = 10
// step  7. 非流式 chat 调用     (鉴权 → preConsume → 上游 → postConsume → observability)
// step  8. 流式 chat 调用       (SSE 透传 + [DONE] 哨兵 + 流式计费)
// step  9. dashboard JSON 总览查得到 totalRequests >= 2
// step 10. 退款触发 + 异步回调到账, 钱包扣穿
```

实测一次:

```
[23:46:09.367] ready: gateway-liveness {"url":".../healthz","latency_ms":1532}
[23:46:09.370] ready: gateway-readiness {"url":".../readyz","latency_ms":3}
[23:46:09.370] --- step 1: /healthz pass ---
[23:46:09.370] --- step 2: /readyz pass ---
[23:46:09.429] --- step 3: user + wallet created --- {"userId":1,"walletId":1}
[23:46:09.440] --- step 4: key issued --- {"keyId":1}
[23:46:09.480] --- step 5: recharge order created --- {"rechargeId":1,"outTradeNo":"USR1NO..."}
[23:46:10.984] --- step 6: recharge callback processed --- {"balanceCny":10}
[23:46:11.308] --- step 7: non-stream chat ok ---
[23:46:11.827] --- step 8: stream chat ok --- {"received_bytes":2612}
[23:46:12.300] --- step 9: dashboard observable --- {"total_requests":4,"total_cost_micro":156}
[23:46:13.300] --- step 10: refund callback drained wallet --- {"balanceMicro":-78}
[23:46:13.300] === e2e-smoke PASSED === {"checks_passed":10,...}
```

10 步全过, 5 秒. smoke 用临时目录 (`/tmp/gw-smoke-xxxxx`) 做 SQLite 文件，跑完 rm -rf,
不污染开发数据: 它也用一组独立端口 (13000 / 14010 / 15010), 不跟你正在开发的本地实例
冲突。

smoke 在 CI 里就是「一次必跑的回归」: 每次合并 PR 前都跑一遍, 9 个能力全部健在才放过。
跑挂了直接看哪一步报错，每步都明确写出语义。

`e2e-smoke.ts` 内部用 `child_process.spawn` 起三个独立进程 (mock-upstream / mock-payment
/ gateway), 然后 `Promise.race` + 轮询 `/healthz` 等它们都 ready. 每个 child stdout
带前缀输出到主进程 (`[mock-upstream] ...`), 方便定位是哪一边的日志: 跑完时通过
SIGTERM 优雅关闭，不靠 `kill -9` (后者会让 SQLite 来不及 flush WAL, 下次跑可能数据
不一致).

设计上有一个小细节值得说: smoke 不依赖任何网络。三家上游 (OpenAI / DeepSeek / Anthropic)
的 API key 留空也能跑通——所有调用都打到 mock-upstream 这个本地进程上，走完一整套
鉴权 / 计费 / 流式 / 看板逻辑: 这意味着 CI runner 可以完全离线，不需要为测试单独申请
真实 key + 不需要担心被上游限流。上线前再单独跑一笔「打真实 OpenAI」的烟雾测试就行，
那条不进 CI.

smoke 故意覆盖到的「易回归」场景，每一个都对应一类历史踩坑:

- **建 user 时自动建 wallet (step 3)**: v0.10 → v0.11 升级时，老 user 没 wallet 被
  漏掉，第一次发请求 409. v1.0 在 admin/users POST 路由里强制 ensureWallet.
- **mock 平台异步回调入账 (step 6)**: v0.11 时 PAYMENT_NOTIFY_BASE 在 docker compose
  环境里写错主机名 (写 localhost 而非 gateway), mock 平台无法回调. smoke 的 step 6
  是这条链路的回归保险。
- **流式 [DONE] 哨兵 (step 8)**: v0.7 加流式, v0.10 改 mock 上游 + cache 字段时漏
  发 [DONE], 客户端等超时. smoke 显式断言 sawDone.
- **dashboard JSON 字段 (step 9)**: v0.9 把 `getTodaySummary().totalRequests` 字段
  改名时，仪表盘前端没同步，看板空白. smoke 显式 assert >= 2.
- **退款扣穿 (step 10)**: v0.11 设计「允许扣穿」是为了应对「用户已花掉部分余额」
  的退款场景. smoke 故意先消费再退款，验证 wallet.balanceMicro < 0 而不是抛异常。

这些场景在不跑 smoke 的项目里通常不会自动暴露，而是要等到生产用户上报「我的钱怎么
没到账」「为什么充了钱看板没数」之类的问题，才反向定位到代码改动. CI 跑 smoke 把这
个反馈延迟从「天」缩短到「PR 提交后几分钟」.

## 12.7 短时压测: autocannon 30 并发

教学版的压测目的不是「跑一个高数字」，而是「证明 v1.0 在合理并发下不挂」. 选 autocannon
([repo](https://github.com/mcollina/autocannon)) 因为它是 Node 原生 + 不需要额外安装，
直接 `import autocannon from 'autocannon'`.

`src/scripts/stress.ts`:

```ts
const result = await autocannon({
  url: `${BASE}/v1/chat/completions`,
  method: 'POST',
  connections: CONCURRENCY,        // 默认 30, env 调
  duration: DURATION_S,            // 默认 10s, env 调
  headers: {
    Authorization: `Bearer ${key.plaintext}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ model: 'mock-gpt-4o-mini', messages: [...], max_tokens: 4 }),
});
```

实测一次 (10 秒 30 并发, mock 上游, SQLite 后端):

```json
{
  "stage": "result",
  "duration_s": 10,
  "concurrency": 30,
  "requests": 2561,
  "rps_avg": 256.11,
  "latency_p50_ms": 106,
  "latency_p99_ms": 402,
  "errors": 0,
  "non2xx": 0
}
```

256 RPS, p50 106ms, p99 402ms, **0 错误**. 这个数字不是绝对值，不要拿它跟生产网关比。
教学版的 mock 上游每条 chunk sleep 250ms (打字机效果), 跟真实 OpenAI / DeepSeek 的
延迟分布不一样。

要拿到更高的真实数字，跑 100 并发 30s:

```bash
STRESS_CONCURRENCY=100 STRESS_DURATION_S=30 npm run stress
```

env 名称 `STRESS_CONCURRENCY / STRESS_DURATION_S` 定义在 `src/scripts/stress.ts` 顶部 (约 L10), 改名时要同时改这两个地方。

要逼出 SQLite 的写锁瓶颈，把 `MOCK_CHUNK_INTERVAL_MS=10` 让 mock 上游打字快一点，然后
看 RPS 上升到 1000-2000 后就上不去了——这是 SQLite 单写者模型的天花板，突破要切 Postgres.

真实生产压测建议跑 wrk2 (`--rate` 控速率。或 k6 (`stages` 阶梯式增压), autocannon 在
教学版里够用。

压测里要看的几个数字，每一个都对应一类生产问题:

- **errors / timeouts**: 必须 0. 任何非 0 都意味着代码层面有 bug 或资源耗尽 (文件句柄、
  内存、连接池).
- **non2xx**: 限流 / 余额不足 / channel 全挂会让请求返 4xx / 5xx, 数字大说明业务策略
  设得太紧或上游不健康。不一定是 bug.
- **p99 latency**: 与 p50 的比值 (尾延迟比。通常生产健康线是 < 5x. 我们的实测 402/106 ≈
  3.8x, 在线。比值过高意味着 GC / SQLite 写锁 / 上游慢请求拖累了部分请求。
- **rps_avg vs rps_max**: 我们没单独输出 max, 但 autocannon 的明细里有。如果 max >> avg
  说明 throughput 抖动大，有「成片成片的等待 + 成片成片的处理」，通常是事件循环被
  同步阻塞 (例如 better-sqlite3 同步写吞掉了一段时间的 IO).

把这几个数字的基线记在仓库里 (例如 `docs/baseline.md`), 每次大改后跑 stress 对比基线，
能在合并代码前发现性能退化。这是教学版没做但生产强烈建议的工程动作。

## 12.8 三种部署目标: Node / Bun / Cloudflare Workers

v1.0 的代码在三种目标上都能跑，但每种目标对外部依赖 (better-sqlite3 native /
in-memory cache / 长连接 SSE) 的兼容程度不同，改动量也不同。完整对比表见
`examples/12-ship-it/DEPLOYMENT.md`. 这里给出选型决策:

**Node.js + 单机** (推荐起点). 改动量 0, v1.0 默认就是这条路径. PM2 跑 cluster 模式
注意 SQLite 的多进程行为——SQLite 文件的多进程读写没问题 (文件锁串行化写), 但 in-memory
状态 (限流 / 看板缓存。不跨进程。真要跨进程上 Redis. 上 Nginx 反代时必须 `proxy_buffering off`
+ `proxy_read_timeout 600s`, 否则 SSE 流式被缓冲或中途切流。

**Bun + 单机**. 改动量小. Bun ([bun.sh](https://bun.sh)) 的 fetch / TS 内置带来 30-50%
RPS 提升，但 better-sqlite3 在 Bun 上偶有 native binding 加载问题
([Bun docs - bun:sqlite](https://bun.sh/docs/api/sqlite)). 推荐方案 A: 在
`src/db/client.ts` 加 adapter 层，探测到 Bun 时用 `bun:sqlite`. v1.0 教学版没附带这个
adapter, 留作扩展。

**Cloudflare Workers + D1**. 改动量大. Workers 的运行时
[限制](https://developers.cloudflare.com/workers/platform/limits/) 决定了至少 7 处必改:

1. `better-sqlite3` 完全不可用，必须换 D1 ([Drizzle + D1 适配](https://orm.drizzle.team/docs/get-started-sqlite#cloudflare-d1)).
2. `pino` 文件日志换 `console.log` + Logpush.
3. SSE 长连接受 CPU 时间 30s (付费 5min) 限制，大流式要拆。
4. in-memory 限流换 Durable Objects 或 KV.
5. `setInterval` 健康检查换 Cron Triggers.
6. `node:crypto` 换 Web Crypto.
7. Subrequest 50 个并发限制 (我们 fallback 最多 3 attempts, 远低于此，不影响).

适合什么场景: 流量分布广 (北美 + 欧洲 + 亚太都要低延迟) + 流量极不均 (白天高晚上几乎
为零，不想为闲置容量付费). 不适合。大流量稳定 (Worker request 单价 + D1 行单价加起来
比单机 vps 贵).

简短决策树:

- 现在就要上线 + 团队 < 50 人: Node.js + systemd. v1.0 本身。
- 追求 runtime 性能 + 团队接受 Bun: Bun + 单机。加一个 db client adapter.
- 流量全球分布 + 不想运维: CF Workers + D1. 改动大，长期收益高。

绝大多数读者起步就用 Node.js + 单机。跑到 SQLite 的并发瓶颈 (1-2k QPS, 取决于写比例)
再考虑切 Postgres 或拆服务。

下面就 Node.js + 单机这条路径再展开两个真实生产场景的细节，因为这是绝大多数读者会
直接踩到的。

**systemd 配置的细节**. v1.0 的服务文件在 DEPLOYMENT.md 里有完整版本，几个关键字段
值得展开:

- `Type=simple`: 进程一启动 systemd 就认为「服务起来了」，不依赖任何 ready 信号。
  对 Node 进程来说够用，因为 Node 的 listen() 是同步的，一行 `serve()` 之后服务
  立即可用。
- `Restart=on-failure` + `RestartSec=5`: 进程因任何原因 exit code != 0 时自动重启，
  间隔 5 秒。避免 crashloop 把日志刷爆 (每秒重启 vs 每 5 秒重启在故障期间是十倍量
  级的差异).
- `EnvironmentFile=/opt/llm-gateway/.env`: 把 .env 交给 systemd 加载，不需要自己 source.
  这条让 .env 与代码分离，升级版本时不动 .env, 降低误操作。
- `StandardOutput=journal`: 日志走 systemd journal, `journalctl -u llm-gateway -f`
  实时看。比自己写文件 + logrotate 简单。真要把日志推到 ELK / Loki, 加一个 `journald`
  output plugin 即可。

**Nginx 反代的细节**. SSE 流式不能被 Nginx 缓冲, `nginx.conf.example` 里有完整配置
但有两条最关键:

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;             # (new) SSE 不能缓冲
    proxy_read_timeout 600s;         # (new) 长流式不能中途切流
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

`proxy_buffering off` 不开会发生什么: Nginx 默认把上游的响应缓存到 4KB 以上才下发，
SSE 的每条 chunk 通常 < 100 字节，客户端要等 N 条 chunk 累积到 4KB 才看到第一字节。
对话式 UI 看到的就是「等几秒突然全部跳出来」，完全失去打字机效果。

`proxy_read_timeout 600s` 不调会发生什么: Nginx 默认 60 秒，流式响应只要在 60 秒内
没有任何字节传输就被切。长一些的回答 (例如代码生成 800 token) 单条 chunk 间隔可能
> 60 秒，主链路就突然 502.

这两条 Nginx 配置占了绝大多数「v1.0 部署上线后流式异常」的根因。上 Nginx 之前先
直连测试 (跑 `npm run smoke` 第 8 步，流式过), 上 Nginx 之后再测一次，任何不一致
都按这两条排查。

**Bun 的现状细节**. Bun 1.x 的 fetch 实现确实更快，主要因为它用 BoringSSL + 自家
HTTP 解析器替代了 Node 的 undici. 但 LLM 网关的瓶颈在上游延迟 (一次 chat completion
通常 1-30 秒), runtime 开销占比 < 1%, 所以 Bun 的 30-50% RPS 提升对实际系统体感
不明显。真正受益的是「冷启动延迟」——Serverless 场景下 Bun 比 Node 快 200-400ms,
但我们 v1.0 是常驻进程，冷启动只发生一次，也不太关心。

值得 Bun 的两类场景: (1) 已经在用 Bun 的团队，不要为这一个网关单独引入 Node 心智
负担; (2) 极度追求开发体验 (Bun 的 `bun --watch`、test runner 都很顺手。的小团队。
其他场景 Node 完全够用。

**Cloudflare Workers + D1 的现状细节**. v1.0 教学版没有附带 wrangler.toml + D1 改造
的完整代码，这条路径的工作量基本等于「重写持久层 + 改一些 N-API 调用」. 但只要走
完上面的 7 处必改，我们的业务逻辑 (鉴权 / 计费 / 限流 / 渠道管理。几乎可以原样保留——
这是 IR + Adaptor + 抽象层设计的红利. Drizzle ORM 切换 SQLite ↔ D1 ↔ Postgres 只动
client 初始化, schema.ts / queries 不动。想接 Workers 的读者按 DEPLOYMENT.md 的清单
逐项改，大约 1-2 周能把第一个版本跑起来。

## 12.9 续作路线图: v2.0 该解决什么

v1.0 已具备上线能力，但仍有不少工程问题留作 v2.0:

**多区域部署 (跨大区延迟)**. 单机部署对国内外用户的延迟差异显著——美国服务器对国内
用户的 RTT 通常 200-300ms, 流式响应的首字节延迟劣化明显。多区域要解决。按用户地理位置
路由到最近的网关、跨区域 channel 池共享、跨区域账单聚合等。工程量大. CF Workers + D1
是其中一条路径。

**审计合规 (SOC2 / 金融客户)**. 网关一旦服务金融 / 医疗等行业客户，会被要求 SOC2 Type II
审计。主要改动是。所有金额变动写不可变审计日志 (我们的 usage_records 已经接近这个语义，
但还需要追加防篡改的 hash 链), admin 操作全部留痕，数据加密 (at-rest + in-transit),
访问控制矩阵。这条路径不增加业务能力，但增加非常多的代码量。

**多租户子账户 (每个外部客户独立子账户)**. v1.0 的 org 是单层的——一个 org 直接挂用户。
真实 SaaS 卖 token 业务里，每个外部客户 (公司。是一个 org, org 下还要细分子账户给客户
公司的不同部门 / 项目，每个子账户独立计费 / 独立配额 / 独立 admin. 数据模型变成 org →
sub-account → user → key 四层。配额传递、子账户间转账、跨子账户聚合账单是新工作量。

**Postgres 切换 (突破 SQLite 单文件并发)**. SQLite 单写者模型在 1-2k QPS 后就吃满写锁，
上 Postgres 是必经路径: 因为我们用 Drizzle ORM, schema 层切换工作量小，但有些细节要重写:
SQLite 的「全库写锁 + 乐观锁单 SQL」在 Postgres 是「行级锁 + 真正的并发」，行为略不同;
SQLite 的 `INSERT ... RETURNING` 在 Postgres 上对应 `INSERT ... RETURNING` 没问题，但
某些 `RAISE EXCEPTION` 模式要换。计费 / 钱包模块完全可以保持 API 不变。

**Redis 切换 (限流 / 缓存跨进程共享)**. 单机扩成多机后，限流必须跨进程. Redis (或更
轻量的 KeyDB / Dragonfly) 是标准答案. v0.6 的 RateLimiter 接口已经预留了 adapter
扩展点，加一个 RedisRateLimiter 实现就好. TPM 预扣的「乐观锁两阶段」在 Redis 上用
Lua 脚本能搞定，不会引入新难题。

**MCP server 对接**. Anthropic 的 MCP (Model Context Protocol) 规范 2025 年起在 Claude
生态推开。把 LLM 网关包装成 MCP server, 让 Claude Code / Claude Desktop 等客户端能
直接调用网关里的工具 / 资源，是一条新增能力。不影响现有 OpenAI / Anthropic 协议路径，
独立挂一组 `/mcp/*` 路由就行. v2.0 的 nice-to-have.

MCP 在网关侧落地的几个具体动作: 暴露 `list_tools` (返回这个网关提供哪些工具，例如
「按 trace_id 反查请求」「按 user 看消费详情」「按 model 算成本对比」), 暴露 `list_resources`
(每个 channel / 每个 user / 每条最近请求都是一个资源, MCP client 可以拉起来直接看),
以及暴露 `prompts` (例如「为某个客户的对话历史做摘要」这类常用提示词). 这条路径让
Claude Desktop 用户不离开他们的 IDE 就能管理整个网关——对内部工具型团队来说体验跃升。

除了上面六个明显方向，还有一类不大不小的工程改进。把 v1.0 的「目录化 schema」彻底
collapse 成「class-based service」. 现在我们的 wallet/service.ts 暴露的。函数列表
(`deductBalance` / `creditBalance` / `handleRechargeCallback` / `handleRefundCallback`),
这种风格在小团队里读起来直接，但当业务方法到 30 个以上时, namespace 会发散。切到
class-based service (例如 `WalletService.deduct(walletId, amount)`) 能让 IDE 跳转和
单元测试 mock 都更顺手。这种重构不影响行为，但能让代码长期可维护性更好——大约 v2.0
中期会面对。

这些都是工程问题，不是科研问题: 投入足够时间都能解决。但对小团队 / 创业者来说, **v1.0
已经够用**——10 人左右的内部 LLM 平台，或者月活几千的对外中转站, v1.0 的能力清单已经
覆盖核心需求。把 v2.0 的功能压到 v1.0 里完成不仅会让书臃肿，也会让初次部署的读者疲于
理解次要细节。

「v1.0 已经够用」这句话不是营销话术，它是有具体数字支撑的。实测 v1.0 在 mock 上游
+ SQLite 后端 + 30 并发下能跑到 256 RPS, 0 错误: 真实 OpenAI 上游的延迟通常 2-30 秒，
单实例并发上限被上游响应时间拉低，实际 QPS 能到 50-200. 一个月活 1 万的中转站，假设
每个用户每天 10 次调用，月调用量 = 1 万 × 10 × 30 = 300 万次，折合 QPS ≈ 1.2. v1.0
的容量是这个数字的 50-150 倍，完全不需要担心架构层面的扩容。真要担心的是上游账户额度、
合规、客服响应速度——这些都不是网关代码能解决的问题。

## 配套代码

完整可运行的 v1.0 代码在 `examples/12-ship-it/`. 完整目录:

```
examples/12-ship-it/
  package.json                # 整合所有依赖 + 新加 build/start/migrate/smoke/stress/docker:* scripts
  tsconfig.json
  .env.example                # 完整环境变量清单 (zod 校验输入源)
  Dockerfile                  # 多阶段构建 (deps → builder → runner)
  docker-compose.yml          # gateway + mock-upstream + mock-payment-platform 一键起整套
  .dockerignore
  drizzle/
    0001_init.sql ... 0007_payment.sql       # 沿用 v0.4 ~ v0.11 的 7 份, 历史读者也能跑
    0008_v1_release.sql                       # v1.0 release marker
  src/
    config/
      env.ts                  # (new) 新增: zod schema 校验所有 env, 启动时一次性检查
      defaults.ts             # (new) 新增: 默认值集中管理
    health/
      liveness.ts             # (new) 新增: /healthz (k8s liveness)
      readiness.ts            # (new) 新增: /readyz (k8s readiness, DB + channels + wallets 三检查)
    index.ts                  # (new) 改: 启动时调 loadEnv() + 挂 /healthz /readyz, 旧 inline /healthz 搬 /admin/info
    (其余沿用 v0.11)
  scripts/
    e2e-smoke.ts              # (new) 新增: 一次跑完整请求生命周期 (10 步, 自动起依赖)
    stress.ts                 # (new) 新增: autocannon 短时压测
    (其余沿用 v0.11: mock-upstream / mock-payment-platform / payment-flow-test 等)
  README.md                   # 完整部署手册 + 9 项核心能力对照
  DEPLOYMENT.md               # (new) 新增: Node / Bun / CF Workers 三种部署目标对比 + trade-off
```

启动方式 (二选一):

**docker compose** (一条命令起整套):

```bash
cd examples/12-ship-it
cp .env.example .env  # 至少改 ADMIN_TOKEN
docker compose up --build
```

**本地 Node** (不用 docker):

```bash
cd examples/12-ship-it
cp .env.example .env  # 至少改 ADMIN_TOKEN
npm install
npm run migrate            # 0001..0008, 共 8 份
npm run mock &             # mock LLM 上游, :4010
npm run mock-pay &         # mock 支付平台, :5010
npm run start              # 主网关, :3000
```

跑 e2e 冒烟 (任一启动方式都适用):

```bash
npm run smoke
# === e2e-smoke PASSED === {"checks_passed":10,...}
```

跑短时压测:

```bash
npm run stress
# {"stage":"result","requests":2561,"rps_avg":256.11,"latency_p99_ms":402,"errors":0}
```

构建 docker 镜像:

```bash
npm run docker:build
# llm-gateway:v1.0
```

更详细的部署手册 (PM2 / systemd / Nginx 反代 / Cloudflare Workers 改动清单。见
`examples/12-ship-it/DEPLOYMENT.md`.

## 续作路线图

第 1 章承诺过用 TS 从 0 搭一个能覆盖企业基建与对外卖 token 双场景的最小可上线网关。
v1.0 兑现了这个承诺。对照 `book.meta.yaml` 的 `minimal_prototype` 清单, 9 项能力全部
落到代码:

- [x] 多上游路由 (Ch2)
- [x] 协议转换 (Ch3)
- [x] API Key 鉴权 (Ch4)
- [x] 计费 (Ch5)
- [x] 限流 (Ch6)
- [x] 流式 (Ch7)
- [x] 渠道管理 (Ch8)
- [x] 可观测性 (Ch9)
- [x] 成本优化 (Ch10)

加上 v0.11 的钱包 + 支付链路，这是一个**今晚就能交付出去**的网关。跑 docker compose up
起整套，配上你的真实上游 key, 改 ADMIN_TOKEN, 上 Nginx 反代，一个能用的中转站就上线了。

如果要把它推到 v2.0, 上面 12.9 节列的六个方向是优先级最高的工程问题: 但对于绝大多数
读者——准备给公司搭内部 AI 网关的工程师，想做对外卖 token 创业的开发者——v1.0 的能力
清单已经覆盖了起步阶段所有的核心需求。

最后说一句感谢。跟着这本书一路从 30 行的透传写到 v1.0 的可上线原型，是一段不短的旅程。
中间有 6 张数据库表的领域建模, 11 份独立 example 的工程演化，几千行 TypeScript 代码的
实际产出。如果你跟到这里，那么你不仅理解了 LLM 中转站每一层的设计取舍，也手握一份能
独立运行 / 二次开发 / 长期演进的代码骨架。这个骨架未必能覆盖你具体业务的所有需求，但
它给出了一个干净的起点——比从零写起省下数周时间，比直接 fork 一个庞然大物易于改动。

写到这里，这本书要交付给读者的内容到此为止。余下的工作是你自己的——把它部署到你的
服务器，接上你的真实上游，配上你的客户，让它跑起来。祝顺利。

最后留一份「上线检查清单」，真实上线前过一遍。不是流程教条，是踩过坑后回头总结的
最低门槛:

- [ ] `.env` 里的 `ADMIN_TOKEN` 已经改成强随机字符串 (至少 32 位), 没留默认 `admin-change-me`.
- [ ] 至少配了一家真实上游的 API key, 并且通过 admin/channels 接口注册成 active channel.
- [ ] 跑过一次 `npm run smoke`, 10 步全过。
- [ ] 跑过一次 `npm run stress`, errors = 0.
- [ ] Nginx 反代配了 `proxy_buffering off` + `proxy_read_timeout 600s` (流式必备).
- [ ] /healthz 与 /readyz 在外网可访问，但 /admin/* 走 Bearer 鉴权 (公网能 curl 但不能
      绕过 admin token).
- [ ] 看板鉴权 token 不要等于 ADMIN_TOKEN (万一泄露范围更小), 单独配一个 dashboard token.
- [ ] 数据备份策略明确: SQLite 文件每天凌晨 cron 备份到对象存储 (R2 / S3), 至少保留
      30 天.
- [ ] 监控告警配上: /readyz 5 分钟 503 → 告警, channel active 数 = 0 → 告警，看板
      today_cost_micro 超阈值 → 告警 (防止某个用户失控刷上游费用).

清单上每一条都对应一类真实事故: 全部打勾再上线，心里踏实很多。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
