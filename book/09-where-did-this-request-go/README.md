---
title: 第 9 章 可观测性与看板
feishu_url: "https://www.feishu.cn/wiki/KUoMwYk75ieCnhk33CocfsFxnAg"
last_synced: "2026-05-16T18:29:07"
---

## 9.1 v0.8 之后还差一双眼睛

v0.8 之后，单 Key 风控 / 限速 / 维护这些故障网关都能毫秒级自动切走。客户端无感，业务方电话不再深夜响。看上去一切都好。

然后接到产品方一条消息: 「上周三下午，我们的客户 A 反馈某个对话的回答质量异常，内容前后矛盾。帮我查一下当时是什么情况」.

打开服务器，第一反应是 `grep`:

```bash
ssh prod
grep "客户 A 的某个关键字" /var/log/gateway.log
```

什么都没有。原因: 我们日志里没存 prompt / completion 全文 (合规与体积考虑，也不应该存). 改 grep:

```bash
grep "客户 A 对应的 Key 前缀" /var/log/gateway.log | grep "2024-XX-XX 14:"
```

跑出来 1 万多行 `console.log` 格式的日志，字段不一致，时间戳格式参差不齐，跨小时还被 logrotate 切走了。半小时翻完，找不到那次对话对应的请求是哪一条，当时命中的是哪个 channel, 是不是触发过故障转移，是不是切到了某个质量差的备用 channel.

最后只能两手一摊: 「日志没法反查，但下次我们改进一下」. 下次又来一条同样的问题: 这是 v0.9 要解决的痛点。

具体拆开有四件事:

1. **日志结构化**. v0.8 的日志混着 `pino-pretty` 着色文本和零散 `console.log`. 不同模块字段命名漂移 (`trace_id` / `traceId` / `request_id`). 想按 `key_id = 42` 反查根本做不到，字符串里命中 `42` 的行成千上万。

2. **trace_id 全链路**. v0.8 的 `traceId` 是主路径 `randomBytes(16).toString('hex')` 生成的，而且只贯穿 `billing_*` 这几条日志: 鉴权失败 / 限流命中的 401/429 没有 trace_id, 故障转移的 channel 切换日志也没有统一关联键。

3. **DB 里只存账单，不存运行时元数据**. usage_records 有 trace_id 但没有 channel_id / upstream_latency_ms. 看板想按 channel 维度算「每个 channel 今日错误率」，数据源根本不存在。

4. **看板缺位**. 运营每天问的是「今天花了多少钱」「哪个 Key 用得最猛」「哪个 channel 不健康」. 这些问题 SQL 都能算，但每次都要登服务器跑一遍，没人愿意。

这一章把这四件事一起做完。配套代码 (`examples/09-where-did-this-request-go/`) 增量约 800 行，核心是新增的 `src/log/` (logger + middleware) 和 `src/dashboard/` (queries + render + routes) 两个子目录，加上一份 `drizzle/0005_observability.sql` 给 usage_records 补三列字段。

这一章的工程价值在哪里。不是「可观测性是一种最佳实践，我们应该有」这种空洞的说法，而是具体到「事故发生时，你能在多久内定位到根因」这件事上. v0.8 的事故响应时间是分钟到小时级，取决于运维多熟悉日志位置; v0.9 之后是秒级，任何工程师拿到 trace_id 都能复现整条链路。这种差异在双场景下都重要——企业基建场景里影响的是业务方对网关的信任，对外卖 token 场景里影响的是 SLA 兑现率与客户挽留率。没有可观测性的网关在小规模时还能凑合，用户超过 50 个就开始崩盘——客服每天回复「我们查一下」，工程师每天翻日志，最后大家都疲于奔命。

## 9.2 pino 结构化日志: 从 console.log 到 JSON one-liner

先把日志收口到一个根 logger. 本书前 8 章每个模块自己 `pino({transport:{target:'pino-pretty'}})` new 一个实例，各跑各的。这种写法本地开发能跑，但生产环境有几个问题:

- **格式不可控**. `pino-pretty` 默认输出带颜色的多行格式，不能直接被 ELK / Loki / Datadog 摄取。真要接日志聚合，需要切换成单行 JSON.
- **配置不可复用**. base 字段 (service / env / pid) 每个 `pino()` 都写一遍，漏一个就少一段上下文。
- **没法做 child binding**. pino 的 `child(bindings)` 必须从同一个根 logger 派生，才能让请求级的 `trace_id` 跨函数调用自动传递 (官方文档 [Child Loggers](https://getpino.io/#/docs/child-loggers)). 散在多个 logger 里就废了。

v0.9 的 `src/log/logger.ts` 把根 logger 收口成单例:

```ts
function buildRootLogger(): Logger {
  const env = process.env.NODE_ENV ?? 'development';
  const level = process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug');
  const usePretty = (process.env.LOG_PRETTY ?? (env === 'production' ? 'false' : 'true')) === 'true';

  const opts: LoggerOptions = {
    level,
    base: { service: 'gateway', env, pid: process.pid },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level(label) { return { level: label }; },
    },
  };

  if (usePretty) {
    return pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname,service,env' },
      },
    });
  }
  return pino(opts);
}

const rootLogger = buildRootLogger();

export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return rootLogger.child(bindings);
}
```

两个写法值得说一下。

`base: { service, env, pid }` 是 pino 的「永远会附带的字段」. 每条日志都自动带上，不用每次写。跨进程聚合时 (例如多副本部署), service + pid 一组合就能在 Loki 里过滤出某个特定进程的日志。

`timestamp: () => ...` 替换默认的 unix ms number 为 ISO 字符串。不少日志聚合系统对字符串时间戳更友好 (Kibana 直接识别，不需要再加 mapping). 性能损失是每条日志多一次 `new Date().toISOString()`, 一次约 1us, 在主路径上不会成为瓶颈。

`transport` 模式是 pino 9.x 推荐的写法 (替代旧版的 `prettyPrint: true` API). 它把 pretty-print 这种昂贵操作放到独立 worker thread, 主线程只往一个管道写 JSON, 然后 worker 负责拼字符串 / 着色。生产环境直接关掉 pretty, 单条日志的 CPU 开销从几十微秒降到 1-2 微秒。

字段字典也写在 `logger.ts` 里:

```ts
export const LogFields = {
  TRACE_ID: 'trace_id',
  REQUEST_ID: 'request_id',
  USER_ID: 'user_id',
  KEY_ID: 'key_id',
  CHANNEL_ID: 'channel_id',
  CHANNEL_NAME: 'channel_name',
  MODEL: 'model',
  PROVIDER: 'provider',
  PROMPT_TOKENS: 'prompt_tokens',
  COMPLETION_TOKENS: 'completion_tokens',
  UPSTREAM_LATENCY_MS: 'upstream_latency_ms',
  TOTAL_LATENCY_MS: 'total_latency_ms',
  STATUS: 'status',
  ERROR_CODE: 'error_code',
  ATTEMPTED_CHANNELS: 'attempted_channels',
  // ...
} as const;
```

这一行的工程价值: 全 repo 任何 `logger.info({...})` 的 key 只能从字典里取，评审代码时一眼看出有没有人写了 `traceId` 而不是 `trace_id`. one-api 的 `model/log.go::Log` 结构 (`UserId / RequestId / ChannelId / PromptTokens / CompletionTokens / ElapsedTime`) 是同一思路，只是它用 Go struct 强约束，我们这里用 TS const + 评审约束。

字段命名漂移是真实事故源。之前在一个多人协作的项目里见过这样的事。主路径打 `trace_id`, 后台 worker 打 `traceId`, 客户支持的查询脚本 grep 时漏掉一半。反查「上周三客户的某次对话」漏掉了 worker 那条 retry 日志，误判为「网关没有重试就把错误透给了客户端」，实际是 worker 重试过 3 次，只是字段名不一致 grep 不到。字段字典这一招在书写代码时多花 30 秒，事故时省 3 小时。

为什么不用 Zod / TypeScript interface 强类型校验: 两个原因: 一是 pino 的 `info(obj, msg)` 签名接受任意 record, 强类型化要么用 generic 包一层 (开发体验下降), 要么改用 wrapper 函数 (失去 pino 原生 API 的灵活性). 二是日志字段会随业务演进，新增字段时不应当卡在「先改类型，再改用法」的两步。字典 + 评审是一个 80/20 解——足够防御常见漂移，不阻塞开发节奏。

跟一行实际输出对比. v0.8 用 `pino-pretty`:

```
[2026-05-15 10:00:00.123] INFO: billing_pre_consumed
    trace_id: "70e47a4036d9844b02c3d353afe92a43"
    record_id: 8
    channel_id: 2
```

v0.9 默认 JSON:

```json
{"level":"info","time":"2026-05-15T02:00:00.123Z","service":"gateway","env":"production","pid":12345,"trace_id":"abc-123-def","request_id":"abc-123-def","user_id":1,"key_id":1,"record_id":8,"first_channel_id":2,"msg":"billing_pre_consumed"}
```

一行 JSON 直接进 Loki / ELK, 按字段索引 / 聚合都能做。

## 9.3 trace_id middleware: 排在所有 middleware 之前

trace_id 的生成位置很讲究. v0.8 是在主路径 `app.post('/v1/chat/completions', ...)` 处理函数里 `randomBytes(16).toString('hex')`. 这意味着:

- 鉴权失败 (auth middleware 拦截。的 401 日志没有 trace_id;
- 限流命中 (limit middleware 拦截。的 429 日志没有 trace_id;
- 这两类响应回客户端时，客户端拿到 `error: invalid_key` 但没有任何关联 ID, 反馈给运维时只能描述「我下午 3 点遇到一次 401」.

v0.9 把 trace_id 提到一个独立的 middleware, 挂在 Hono 最外层，排在 auth / limit 之前:

```ts
export const traceMiddleware: MiddlewareHandler<{ Variables: TraceVariables }> = async (c, next) => {
  const startedAt = Date.now();
  const clientGiven = c.req.header('x-request-id');
  const traceId =
    typeof clientGiven === 'string' && clientGiven.length > 0 && clientGiven.length < 200
      ? clientGiven
      : randomUUID();

  const logger = createChildLogger({
    trace_id: traceId,
    request_id: traceId,
    method: c.req.method,
    path: c.req.path,
  });

  c.set('trace_id', traceId);
  c.set('logger', logger);
  c.header('X-Request-Id', traceId);

  try {
    await next();
  } finally {
    logger.info(
      { status: c.res?.status ?? 0, total_latency_ms: Date.now() - startedAt },
      'request_completed',
    );
  }
};
```

几个设计点逐个说。

**生成方式**. 用 `crypto.randomUUID()` (Node 18+ 内置，标准 36 字符 UUIDv4). 不用 v0.8 的 `randomBytes(16).toString('hex')` 自定义格式，因为 UUID 与上游 OpenAI 等的 `x-request-id` 响应头格式一致，跨系统对账时不需要再做格式转换. one-api 的 `helper.GetRequestID(ctx)` 也是自定义格式，在跨厂商对账时偶尔会被混淆，这是少数我们故意不抄它的地方。

为什么不用 nanoid? nanoid 短 (21 字符 vs UUID 36 字符), 但需要额外依赖. `crypto.randomUUID()` 是 Node 内置，不引入新包。性能上单次 1-2us, 网关主路径完全不敏感。字符长度多 15 个字节，在日志单条 200-500 字节的量级里可以忽略。

**客户端可复用**. 如果客户端传了 `X-Request-Id` 头 (常见做法，客户端方便自己关联), 网关就复用。否则生成新的。上限 200 字符防御「客户端塞超大字符串」.

**响应头回写**. `c.header('X-Request-Id', traceId)` 把 trace_id 通过响应头给客户端: 客户端遇到「这次调用网关返回异常」时，把这个值发给运维，一行 grep 定位。这一招是从 AWS API Gateway 学来的——AWS 任何 API 调用响应都带 `x-amzn-RequestId` 头，客户提工单时把这个 ID 贴上, AWS 后端能立刻定位到具体那一次调用的内部日志。

**child logger 一次性绑定**. `createChildLogger({ trace_id, request_id, method, path })` 让后续所有 `ctx.logger.info({...})` 调用都自动带上这四个字段，不需要手动 spread. 这是 pino child logger 的核心价值 (`getpino.io/#/docs/child-loggers`).

**统一尾部日志**. `try { await next() } finally { logger.info({status, total_latency_ms}, 'request_completed') }`. 这一行是看板 QPS / 错误率的核心数据源——不需要每条业务日志都打，一个统一的尾部日志覆盖所有路径 (200 / 4xx / 5xx 都会经过 finally).

为什么放在 `finally` 而不是 `next()` 之后? `next()` 内部如果抛异常 (Hono 兜底 500), 没有 `finally` 的尾部日志会丢失这次请求. `try / finally` 让无论抛不抛异常都有一条完整的尾部日志，看板的「请求总数」不漏一笔。这是 pino 在 Express / Koa 上的标准用法 (官方文档 transport 章节的 middleware example), Hono 上没有差异。

挂载顺序:

```ts
const app = new Hono<{ Variables: AppVariables }>();
app.use('*', traceMiddleware);       // 第一个
app.route('/admin/dashboard', ...);
app.route('/admin', ...);
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, handler);
```

trace middleware 在 `app.use('*', ...)` 顶层挂. auth / limit 之前发生的所有 401/429/400 日志都会带 trace_id, 这是 v0.8 的核心遗憾。

## 9.4 把 trace_id 推到每一个下游

middleware 注入了 `ctx.logger`, 但前提是后续代码愿意「不从 import 全局，而是从 ctx 取 logger」. v0.8 的写法:

```ts
import pino from 'pino';
const logger = pino({ transport: { target: 'pino-pretty' } });

// 主路径
logger.info({ trace_id: traceId, record_id, ... }, 'billing_pre_consumed');
```

每一行 log 都要手动加 `trace_id`, 漏一行就断线. v0.9 改成:

```ts
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
  const logger = c.get('logger');
  const auth = c.get('auth');
  const reqLogger = logger.child({ user_id: auth.userId, key_id: auth.keyId, org_id: auth.orgId });

  // 后续所有 log 自动带 trace_id + user_id + key_id + org_id
  reqLogger.info({ record_id, model, first_channel_id }, 'billing_pre_consumed');
});
```

`logger.child(...)` 在主路径上再叠一层，把鉴权后才知道的 `user_id / key_id / org_id` 也 bind 进去。这之后所有 `reqLogger.info({...}, 'event_name')` 自动带 7 个字段，不用手动 spread.

child logger 的开销极低. pino 官方文档明确说 child 是「prototype chain 链接」，不复制 base 字段，每次创建 < 100ns/次。网关主路径每个请求只 new 一次 child logger, 性能上完全可以忽略。

跟一次实际请求的 stdout 输出 (实测):

```json
{"level":"info","trace_id":"verify-1778795766995257695","request_id":"verify-1778795766995257695","method":"POST","path":"/v1/chat/completions","user_id":1,"key_id":1,"org_id":1,"record_id":20,"model":"mock-gpt-4o-mini","first_channel_id":1,"first_channel_name":"mock-primary","is_stream":true,"est_prompt_tokens":11,"pre_reserved_micro_cny":75,"msg":"billing_pre_consumed"}
{"level":"info","trace_id":"verify-1778795766995257695","request_id":"verify-1778795766995257695","method":"POST","path":"/v1/chat/completions","user_id":1,"key_id":1,"org_id":1,"attempt":0,"channel_id":1,"channel_name":"mock-primary","provider":"mock","attempted_channels":[1],"upstream_latency_ms":2,"msg":"stream_upstream_connected"}
{"level":"info","trace_id":"verify-1778795766995257695","request_id":"verify-1778795766995257695","method":"POST","path":"/v1/chat/completions","status":200,"total_latency_ms":2528,"msg":"request_completed"}
{"level":"info","trace_id":"verify-1778795766995257695","request_id":"verify-1778795766995257695","method":"POST","path":"/v1/chat/completions","user_id":1,"key_id":1,"org_id":1,"record_id":20,"channel_id":1,"channel_name":"mock-primary","model":"mock-gpt-4o-mini","provider":"mock","terminal_status":"finalized","prompt_tokens":4,"completion_tokens":17,"final_cost_micro_cny":72,"attempted_channels":[1],"upstream_latency_ms":2515,"msg":"stream_settled"}
```

一次流式请求, stdout 输出 4 条 (debug 级别还有 1 条 `request_started`), 每条都带 `trace_id`. grep `verify-1778795766995257695` 立刻拿到完整链路。

后台 worker 怎么办? `channels/health-checker.ts` 跑在主循环之外，没有 ctx. v0.9 把它的 logger 改成:

```ts
import { createChildLogger } from '../log/logger.js';
const logger = createChildLogger({ component: 'health-checker' });
```

`component: 'health-checker'` 让看板 / 日志聚合时能按 `service+component` 精确过滤后台任务。真要复用某次 admin 主动触发探活的 trace_id, 调用方传一个 traceId 进来用 `createChildLogger({ trace_id, component })` 即可——本章范围内 health-checker 是定时任务，没有源头 trace_id, 留一个 component 标签足够。

## 9.5 usage_records 加三列。让 DB 也能反查

日志输出做完了，但日志是「会被切割 / 压缩 / 过期」的存在。跨日反查仍然依赖日志聚合系统。更可靠的反查路径是 DB 里直接查 `usage_records`——这张表的行寿命与账单一样长 (按合规要求通常保留 1-3 年).

v0.8 的 `usage_records` 已经有 `trace_id` (UNIQUE INDEX), 但缺三列，看板和反查时严重不够用:

- **channel_id**: 本次请求实际命中的 channel. v0.8 故障转移时只在日志里记 attempt 与 channel_id, 入库表没记。反查时无法回答「这一笔账消耗了哪个 channel」.
- **upstream_latency_ms**: 上游 fetch 起到 first byte / parse 完成的耗时。看板要按 channel 算 P50/P95 延迟必须有这一列。
- **attempted_channels**: 一次请求尝试过的 channel id 列表 (JSON 数组). 故障转移时这个值才能反映真实的「为了完成这次请求，网关付出了几次尝试」.

`drizzle/0005_observability.sql`:

```sql
ALTER TABLE `usage_records` ADD COLUMN `channel_id` integer;
ALTER TABLE `usage_records` ADD COLUMN `upstream_latency_ms` integer;
ALTER TABLE `usage_records` ADD COLUMN `attempted_channels` text;

CREATE INDEX IF NOT EXISTS `usage_records_channel_time_idx`
  ON `usage_records` (`channel_id`, `created_at`);
```

注意 SQLite 3.35+ (2021-03 起。支持 ALTER TABLE 的 ADD / DROP / RENAME COLUMN, 但不支持 ALTER TYPE (改列的类型必须走 「新建表 + 数据迁移 + 替换」). 所以 v0.5 的 schema 里就要把字段类型设计到位，后续章节只增字段不改类型。

字段写入时机. v0.8 主路径在故障转移循环内，每次尝试都会失败 / 成功一次, channel_id 只有在循环结束时才知道。加一个新函数:

```ts
export function recordObservability(input: {
  recordId: number;
  channelId: number | null;
  upstreamLatencyMs: number | null;
  attemptedChannels: number[];
}): void {
  const db = getDb();
  db.update(usageRecords)
    .set({
      channelId: input.channelId,
      upstreamLatencyMs: input.upstreamLatencyMs,
      attemptedChannels: JSON.stringify(input.attemptedChannels),
    })
    .where(eq(usageRecords.id, input.recordId))
    .run();
}
```

主路径在「确定一次请求的最终结果」之后 (无论 200 / 4xx / 5xx) 调一次 `recordObservability(...)` 即可。与 `postConsume` (金额结算。解耦，各自负责自己的那部分字段。

为什么不把 channel_id 也放进 postConsume? postConsume 的语义是「实结金额」，只关心 token 数与价格. observability 字段 (channel_id / latency / attempted) 是事后审计字段，不参与计费。拆开两条 UPDATE 让代码意图清晰——一份代码改 status + cost, 另一份代码改 observability 字段，互不影响。

这是一种「关注点分离」的实践。真到 Ch12 整合的时候, postConsume 仍然只与「价格 + 倍率 + 余额」打交道，不需要知道 channel 是怎么选出来的; recordObservability 不需要知道这次请求最终算了多少钱。两个函数可以独立测试，独立替换: 真要把 observability 字段下沉到独立的「请求审计表」(例如 audit_logs), 主路径只需要把 recordObservability 改成写新表, postConsume 不动。这是 single-responsibility 在 ORM 时代的工程意义。

字段填好之后，反查 SQL 直接 join 即可。一份按 trace_id 的「全单表查询」recipe:

```sql
-- 按 trace_id 找出账单 + channel 详情
SELECT
  u.id,
  u.trace_id,
  u.user_id,
  u.key_id,
  u.channel_id,
  c.name AS channel_name,
  c.provider,
  u.model,
  u.prompt_tokens,
  u.completion_tokens,
  u.final_cost,
  u.upstream_latency_ms,
  u.attempted_channels,
  u.status,
  u.error_message,
  u.created_at,
  u.finalized_at
FROM usage_records u
LEFT JOIN channels c ON c.id = u.channel_id
WHERE u.trace_id = ?;
```

`LEFT JOIN` 而不是 `INNER JOIN`: 故障转移失败到底的请求会把 channel_id 写成 NULL (没有任何一次成功的 channel), 用 INNER JOIN 会把这种「请求全失败」的行漏掉。反查的目的恰恰是搞清楚「为什么这次请求失败了」，漏行就废了。

更细的反查路径: 同一个 trace_id 在日志里的所有事件 (通过 `stdout | grep trace_id` 或 Loki 按字段过滤):

```bash
# 本地 stdout
grep "verify-xyz" /var/log/gateway.log

# Loki
{service="gateway"} | json | trace_id="verify-xyz"
```

usage_records 行回答「这一笔的账单与命中的 channel」，日志事件回答「这一笔经过了哪些 middleware / 触发过哪些异常分支 / 上游响应耗时分布」. 两路证据交叉对比，任意一笔请求的全貌可以在 30 秒内还原。

几条常用反查 SQL 单独列一遍，它们都基于「`usage_records.trace_id` 已经全链路打通」这一前提。

**按用户找今日花钱 Top 10 的请求**:

```sql
SELECT trace_id, model, channel_id, prompt_tokens, completion_tokens, final_cost,
       upstream_latency_ms, attempted_channels, status, created_at
  FROM usage_records
 WHERE user_id = ?
   AND created_at >= ?
 ORDER BY final_cost DESC
 LIMIT 10;
```

**找最近 1 小时所有触发过故障转移的请求** (`attempted_channels` JSON 数组长度 > 1):

```sql
SELECT trace_id, model, channel_id, attempted_channels, status, created_at
  FROM usage_records
 WHERE created_at >= strftime('%s', 'now', '-1 hours') * 1000
   AND attempted_channels IS NOT NULL
   AND json_array_length(attempted_channels) > 1
 ORDER BY created_at DESC;
```

`json_array_length` 是 SQLite 内置 JSON 函数. PostgreSQL 上换成 `jsonb_array_length`, 语义一致。

**找最近 24 小时上游延迟 > 5 秒的请求** (用来定位慢上游):

```sql
SELECT trace_id, channel_id, model, upstream_latency_ms, status
  FROM usage_records
 WHERE created_at >= strftime('%s', 'now', '-24 hours') * 1000
   AND upstream_latency_ms > 5000
 ORDER BY upstream_latency_ms DESC
 LIMIT 50;
```

这三段 SQL 是任何对外卖 token 网关的「常驻查询」，工程师能背。真要做成 admin/usage 接口的 query 参数，加几个 if 分支即可，不再展开。

## 9.6 最小看板: SSR HTML 不引入前端框架

看板的本质是「把聚合查询结果摊到表格里」. React / Vue 这种 UI 框架在这件事上没有任何价值——表格不需要状态管理，不需要客户端路由，也不需要交互。反而要引一堆构建工具 / loader / bundler.

为什么强调这一点。因为「先上一个前端框架」是后端工程师做内部工具时常见的过度工程: 看板做完之后第一次需求迭代是「能不能加一个时间范围切换」，用框架的话需要 useState + useEffect; SSR 加 query string + 服务端读取参数，一行代码完事。第二次需求「能不能加一个 channel 详情下钻」，框架要加路由; SSR 加一个新 handler. 真正需要交互的需求 (例如「能不能编辑 channel 配置」) 在 admin API 已经有了，看板不该揽这件事——看板的边界是「只读展示」.

v0.9 的看板用纯字符串拼 SSR HTML, 不依赖前端框架:

- 后端: Hono handler 跑聚合 SQL, 拿到数据对象;
- 渲染。纯字符串模板拼 `<table>`, XSS 用 `escapeHtml` 防御;
- 自动刷新: `<meta http-equiv="refresh" content="30">`, 浏览器每 30s 重载。不需要 WebSocket, 不需要 SSE 推送，不需要前端轮询。

文件拆三层:

```
src/dashboard/
  queries.ts   # 聚合 SQL, 返回普通对象
  render.ts    # 纯字符串模板拼 HTML
  routes.ts    # 路由 + 看板专用鉴权
```

`queries.ts` 走原始 SQL (better-sqlite3.prepare), 不用 Drizzle. 原因: 看板用的聚合 (`SUM` / `COUNT` / `GROUP BY` / `strftime` 时间窗。在 Drizzle 上写起来既要 import sql 又要拼 Drizzle 表达式，远不如直接看 SQL 清晰。真要换 PostgreSQL, 只改 strftime 那一句就行。

5 大 section + 全局摘要卡片。每一个对应一段 SQL.

**今日 QPS (按分钟聚合)**:

```sql
SELECT strftime('%H:%M', created_at / 1000, 'unixepoch', 'localtime') AS minute,
       COUNT(*) AS count
  FROM usage_records
 WHERE created_at >= ?       -- 今日 0 点
 GROUP BY minute
 ORDER BY minute ASC;
```

`strftime('%H:%M', created_at/1000, 'unixepoch', 'localtime')` 把 unix ms 转成本地时区的「时:分」字符串。同一分钟内的请求聚合成一行。渲染时用 ASCII sparkline (`▁▂▃▄▅▆▇█`) 一行画出来——一眼看出峰值时间分布，不需要图表库。

**今日花费 · 按用户 / 按模型**:

```sql
SELECT user_id AS dimension,
       SUM(final_cost) AS totalCostMicro,
       COUNT(*) AS totalRequests,
       SUM(prompt_tokens) AS totalPromptTokens,
       SUM(completion_tokens) AS totalCompletionTokens
  FROM usage_records
 WHERE created_at >= ?
   AND status IN ('finalized','canceled','partial')
 GROUP BY user_id
 ORDER BY totalCostMicro DESC
 LIMIT 20;
```

`status IN ('finalized','canceled','partial')` 排除 `refunded` (上游失败已退款，不计费。和 `reserved` (还没结算，看板里展示是误导). canceled / partial 都已经实际消耗 token, 必须计费，看板上也要算进去。

**Top 10 Key 用量**: 类似上面, GROUP BY key_id. 多查一列「errorRequests = 错误数」:

```sql
SUM(CASE WHEN status IN ('refunded','failed') THEN 1 ELSE 0 END) AS errorRequests
```

这种 `CASE WHEN ... THEN 1 ELSE 0 END` + SUM 是 SQL 里算「条件计数」的标准写法。

**Channel 健康状态**: LEFT JOIN channels 表，让没有今日请求的 channel 也出现 (= 0 流量，但运营要看到它存在):

```sql
SELECT c.id AS channelId,
       c.name AS name,
       c.status AS status,
       c.disabled_reason AS disabledReason,
       COUNT(u.id) AS totalRequests,
       SUM(CASE WHEN u.status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests,
       AVG(u.upstream_latency_ms) AS avgUpstreamLatencyMs
  FROM channels c
  LEFT JOIN usage_records u
    ON u.channel_id = c.id AND u.created_at >= ?
 GROUP BY c.id, c.name, c.status, c.disabled_reason
 ORDER BY c.priority DESC, c.id ASC;
```

`AVG(upstream_latency_ms)` 自动忽略 NULL 行，单 channel 全 NULL 返 NULL (`avgUpstreamLatencyMs` 字段在渲染时显示为 `-`).

**错误率 Top 5 模型** (今日 ≥ 5 笔):

```sql
SELECT model,
       COUNT(*) AS totalRequests,
       SUM(CASE WHEN status IN ('refunded','failed','partial') THEN 1 ELSE 0 END) AS errorRequests
  FROM usage_records
 WHERE created_at >= ?
 GROUP BY model
HAVING totalRequests >= 5     -- 排除一两笔抖动
 ORDER BY (1.0 * errorRequests / totalRequests) DESC, totalRequests DESC
 LIMIT 5;
```

`HAVING totalRequests >= 5` 排除「只有 1 笔请求碰巧失败 = 100% 错误率」的噪声. `1.0 * errorRequests / totalRequests` 强制浮点除法 (SQLite 整数除法默认丢精度).

`render.ts` 把这些数据拼 HTML. 关键一行是 `escapeHtml`:

```ts
export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  const s = String(input);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

五个标准实体，与 OWASP cheat sheet 一致。任何来自 DB 的字符串字段 (channel.name / disabled_reason / model) 都要走一遍 escape——这些字段是 admin 接口写进去的，不能假设它们安全: 数字 / 时间走 toLocale 之后不需要再 escape (Number / Date toString 不含 `<>`).

把它接到 `<table>` 拼接上，大致这样 (节选 channel 健康 section 的渲染):

```ts
// src/dashboard/render.ts (节选)
import { escapeHtml as esc } from './escape.js';

export function renderChannelHealth(rows: ChannelHealthRow[]): string {
  if (rows.length === 0) {
    return `<section><h2>Channel 健康状态</h2><p>暂无 channel</p></section>`;
  }
  const trs = rows
    .map((r) => {
      const err = r.totalRequests > 0
        ? ((r.errorRequests / r.totalRequests) * 100).toFixed(1) + '%'
        : '-';
      const lat = r.avgUpstreamLatencyMs != null
        ? r.avgUpstreamLatencyMs.toFixed(0) + 'ms'
        : '-';
      const statusBadge = r.status === 'active'
        ? `<span class="ok">${esc(r.status)}</span>`
        : `<span class="bad">${esc(r.status)}</span>`;
      return `<tr>
        <td>${r.channelId}</td>
        <td>${esc(r.name)}</td>
        <td>${statusBadge}</td>
        <td>${esc(r.disabledReason ?? '-')}</td>
        <td style="text-align:right">${r.totalRequests}</td>
        <td style="text-align:right">${err}</td>
        <td style="text-align:right">${lat}</td>
      </tr>`;
    })
    .join('');
  return `<section>
    <h2>Channel 健康状态</h2>
    <table>
      <thead><tr>
        <th>id</th><th>name</th><th>status</th><th>disabled_reason</th>
        <th>req</th><th>err%</th><th>p_avg</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </section>`;
}
```

`esc(r.name)` 与 `esc(r.disabledReason ?? '-')` 是必须走 escape 的两处——name 是 admin 输入, disabledReason 是 classifier 拼装的错误关键字. `r.channelId / r.totalRequests / r.avgUpstreamLatencyMs` 都是数字，直接拼字符串安全. `statusBadge` 里的 `esc(r.status)` 看似多余 (status 是 enum), 但留着这一层是「safe by default」的纪律——一旦后续把 status 改成自由文本，这里不会留下 XSS 漏洞。

最外层 `renderDashboard()` 把 5 个 section 的 HTML 字符串拼起来，加上 `<meta http-equiv="refresh" content="30">` 和最小 CSS, 返回 200 + Content-Type: text/html. queries.ts → 普通对象数组 → render.ts → HTML 字符串，链路只有三步，没有任何 build / hydrate / bundle 步骤。

不用第三方 `html-escaper` 是因为这一段代码本身简单到不值得引依赖，多一个依赖多一次 npm audit 担心。

`routes.ts` 鉴权特别处理:

```ts
app.use('*', async (c, next) => {
  const expected = process.env.ADMIN_TOKEN ?? '';
  const given = c.req.query('token') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (given !== expected) {
    return c.text('forbidden: pass ?token=<ADMIN_TOKEN> or Authorization header', 403);
  }
  await next();
});
```

浏览器场景不方便加 Authorization header (没法手动改), 改成 `?token=<ADMIN_TOKEN>` query string. 第一次访问需要带，浏览器记住 URL 后刷新自动复用。这是教学场景的简化，生产环境应该改成 cookie + 后台登录 (Ch12 上线整合时处理).

挂载顺序也有讲究:

```ts
// dashboard 必须挂在 /admin 之前 (Hono 按注册顺序匹配前缀)
app.route('/admin/dashboard', createDashboardRouter());
app.route('/admin', createAdminRouter());
```

Hono 按前缀匹配，注册顺序敏感。如果先挂 `/admin` (它的 middleware 是 Bearer header 校验), 再挂 `/admin/dashboard`, `/admin/dashboard?token=xxx` 会先进 `/admin` 的 middleware, 在「token in query string」之前就被 401 拦截了。

这种顺序敏感的 bug 一旦埋下来后续很难发现。测试时如果两条路径都用同一种鉴权方式，单测都能跑过，跑端到端时才发现「为什么浏览器进不了看板」. 工程上的防御方法是写一行注释把意图固定下来 (本章 index.ts 已经写了), 或者把两个 router 在同一个 app 里平铺挂载，而不是用 `app.route(prefix, ...)` 嵌套。

## 9.7 一次故障转移在看板上长什么样

把这一切串起来看一次具体的故障转移. mock 上游配 3 个 channel (沿用 v0.8 的 seed): mock-primary (合法 key) / mock-bad-key (key=`will-fail-401`) / mock-network-unreachable (端口不存在).

跑 5 笔非流式 + 2 笔流式请求，部分命中 ch2 触发故障转移。看 stdout 日志 (节选，同一 trace_id):

```json
{"level":"info","trace_id":"trace-non-...-1","user_id":1,"key_id":1,"record_id":8,"first_channel_id":2,"msg":"billing_pre_consumed"}
{"level":"warn","trace_id":"trace-non-...-1","attempt":0,"channel_id":2,"channel_name":"mock-bad-key","status":401,"class":"disable","reason":"upstream_401","upstream_latency_ms":15,"error_code":"upstream_disable","msg":"non_stream_upstream_failed"}
{"level":"info","trace_id":"trace-non-...-1","record_id":8,"channel_id":1,"channel_name":"mock-primary","prompt_tokens":4,"completion_tokens":17,"final_cost_micro_cny":72,"attempted_channels":[2,1],"upstream_latency_ms":2515,"msg":"billing_settled"}
{"level":"info","trace_id":"trace-non-...-1","status":200,"total_latency_ms":2535,"msg":"request_completed"}
```

4 条日志，同一 trace_id. 第二条记录了「ch2 被分类成 disable, reason upstream_401」，第三条记录了「最终命中 ch1, 实结 72 微元」，第四条统一尾部. attempted_channels=[2,1] 完整体现了「先试 ch2 失败，再试 ch1 成功」的轨迹。

DB 反查:

```sql
SELECT id, trace_id, channel_id, prompt_tokens, completion_tokens, final_cost,
       upstream_latency_ms, attempted_channels, status
  FROM usage_records
 WHERE trace_id = 'trace-non-...-1';
```

```
id  trace_id      channel_id  prompt_tokens  completion_tokens  final_cost  upstream_latency_ms  attempted_channels  status
8   trace-non-... 1           4              17                 72          2515                 [2,1]               finalized
```

一行 SQL 还原了整次请求的全貌。不需要翻日志切割，不需要按时间窗扫几万行。

`attempted_channels` 是个 JSON 字段，有时候会被忽视它的价值。单看 `channel_id=1, status=finalized` 只能知道「最后命中了 ch1」，但看不到「之前还试过别的 channel」. 加上 `attempted_channels=[2,1]` 就能立刻分辨两种场景: 直接命中 ch1 (`[1]`) vs 试过 ch2 后才到 ch1 (`[2,1]`). 这两种场景对客户端是无差别的 (都返回 200), 但对运营完全不同——后者意味着 ch2 有问题，需要关注: 前者意味着一切正常: 看板的「Channel 健康状态」一栏的「错误率」字段就是从这个数组里反推出来的。一次请求 `attempted_channels=[2,1]` 中, ch2 贡献了 1 次「尝试但失败」, ch1 贡献了 1 次「命中」.

看板上这次请求会影响几个 section:

- **今日 QPS · 当前分钟**: count + 1
- **今日花费 · 按用户**: user:1 totalCostMicro += 72
- **Top 10 Key 用量**: key:1 totalRequests += 1, totalCostMicro += 72, totalTokens += 21
- **Channel 健康状态**: ch1 totalRequests += 1, avgUpstreamLatencyMs 加权平均; ch2 status=disabled (来自 admin/channels), disabledReason=upstream_401
- **错误率 Top 5 模型**: mock-gpt-4o-mini errorRequests 不变 (这次最终 finalized 了)

浏览器打开 `http://localhost:3000/admin/dashboard?token=ADMIN_TOKEN`, 这些数字立即可见, 30 秒后自动刷新拿到最新值。

把这个流程跟「v0.8 之前的事故响应」对比一下. v0.8 时代。产品方说「客户 X 的对话异常」，运维登服务器 grep, 翻 30 分钟翻不到. v0.9 时代。产品方说「客户 X 的对话异常, X-Request-Id 是 abc-123」 (客户 SDK 已经从响应头存了下来), 运维 `grep abc-123 /var/log/gateway.log` 或者 `curl /admin/usage?traceId=abc-123` 30 秒拿到全链路。同样的事故，响应时间从 30 分钟降到 30 秒，这就是结构化日志 + trace_id 全链路 + DB 反查三件事叠加的价值。

更进一步，看板让运营不再依赖运维. 「今天哪个 Key 用得最多」「mock-bad-key 为什么今天错误率 80%」「上周开始 gpt-4o-mini 错误率有没有上涨」这些问题，在 v0.8 之前要么靠 SQL 临时跑，要么靠运维写一份周报. v0.9 之后运营自己打开看板就有答案——这是「自服务」的工程价值，比节省的人力本身更值。

## 9.8 大规模日志的工程选择

看板这一层在 SQLite + usage_records 表上能撑到什么规模。实测百万行级别的聚合 (`SUM` / `COUNT` / `GROUP BY model`) 在有索引的情况下大约几十毫秒到几百毫秒。教学场景 + 中小规模上线完全够用。

折算一下日请求量。一天 100 万笔请求，一行 usage_records 200 字节，一天 200MB, 一年 70GB. SQLite 单文件 70GB 仍然能跑 (理论上限 281TB), 但聚合查询的「全表扫」会从几十毫秒退化到几秒。这时通常的做法是按月归档——上月的数据移到 `usage_records_archived_2024_04`, 当月表始终保持百万行级别，看板只跑当月表，历史查询走 UNION ALL.

真要扛百万级 QPS, 业内有两条成熟路径。

**Helicone 的 ClickHouse 路径**. Helicone 是 TS 阵营的开源 LLM 可观测平台，商业 SaaS 形态，核心能力是「网关代理 + 全链路日志 + 用量看板」. 它的核心日志表跑在 ClickHouse 上，单条 request 把 prompt + completion 全文落库，走列式压缩 + 倒排索引。聚合查询毫秒级，支持几十亿行的全文搜索。代价是工程栈复杂——需要单独运维 ClickHouse 集群，数据同步链路要专门设计。

**one-api 的 MySQL/PostgreSQL 路径**. `model/log.go::Log` 是单表 + 索引，与本书 usage_records 思路一致。它的扩展方式是分库分表 / 按月归档，不引入新栈。缺点是聚合查询在亿级单表上仍然较慢，看板加载有可见延迟。

本书选 SQLite + usage_records 是因为教学优先。读者 npm install 完即可跑，不需要部署额外服务。真到上线那一步 (Ch12), 应该把日志聚合这条链路与计费链路解耦——usage_records 仍然装账单，日志单独走 Pino → Loki / Datadog / ClickHouse, 看板按需切换数据源。

「日志与账单分两路」是中后期常见的演进。账单数据是结构化的财务记录，必须强一致 + 长期保留，走 PostgreSQL / MySQL 这类事务型 DB. 日志数据是高吞吐的运维事件流，允许最终一致 + 滚动过期，走 Loki / ClickHouse / OpenSearch 这类专门的日志栈。看板的「今日花费」这种问题查账单 DB, 「最近 5 分钟错误率」这种问题查日志栈。两路数据源由看板的 SSR 层各取所需，拼到同一个页面。这条演进 v1.0 也不做 (Ch12 是 docker-compose 整合，仍然用 SQLite 单表), 留给 v2.0 多区域部署时一起处理。

## 9.9 v0.9 之后还差什么

v0.9 完成的能力清单:

- pino 单例根 logger + JSON / pretty 双模式 + 字段字典约束;
- trace_id middleware 排在最外层，客户端 X-Request-Id 头可复用，响应回写;
- child logger 在请求级 bind trace_id / user_id / key_id, 后续日志全自动带;
- usage_records 加 channel_id / upstream_latency_ms / attempted_channels 三列, DB 直接反查;
- `/admin/dashboard` SSR HTML 看板, 5 section + 全局摘要, 30s 自动刷新;
- 看板 query string token 鉴权，浏览器直开;
- recordObservability 与 postConsume 解耦，两个函数职责清晰;
- 三段常用反查 SQL recipe (按用户找高消费 / 找触发故障转移的请求 / 找慢上游).

但 v0.9 之后，每一分钱的去向和每一次请求的轨迹都可观测了——同时也带来一个让人不愉快的事实: 对照同一笔 `gpt-4o-mini` 请求，看板上的实际成本是「prompt 4 token × 单价 + completion 17 token × 单价」，折算下来比官方价仅有微小的渠道倍率差异: 但市面上对外销售的中转站给开发者卖的价格，比我们这套自建网关的实际成本明显低 30%-50%.

这背后的可能性有两种:

- **合规的降本机制**: prompt caching 透传 / batch API 异步通道 / 渠道倍率与套利 / 成本路由 fallback / 企业渠道价差。这五件事每一件都能稳定降本 10%-30%, 叠加起来达到对外中转站的卖价水平。
- **不合规的灰色玩法**: 拼车号池 / 退款套利 / 偷偷降级模型。这些手法短期能压价，但都是踩雷。

v0.9 之后看板能算清成本，但不能解释「为什么对外比自建便宜」. v0.10 把这件事拆透——5 种合法降本机制每一种给一份可量化的代码。同时揭示 3 种灰色玩法的原理但不提供实现，并基于模型指纹审计落地一个「上游是否偷换模型」的检测器做防御侧。

这是本书在对外卖 token 场景下的核心护城河章节。企业基建场景的读者可以挑读「成本路由 fallback」这一节，其余四种合法机制是对外创业必读。

## 配套代码

完整可运行的 v0.9 代码在 `examples/09-where-did-this-request-go/`. 目录结构:

```
src/
  index.ts                          # (new) 主路径全面替换 console.log / 自由 pino 为 ctx.logger
  log/                              # (new) 本章核心
    logger.ts                       # 全 repo 共享的 pino 根实例 + 字段字典 + child logger 工厂
    middleware.ts                   # trace_id 生成 (UUID 或 X-Request-Id) + child logger 注入 ctx
  dashboard/                        # (new) 本章核心
    queries.ts                      # 全部聚合 SQL (今日 QPS / 花费 / Top Key / Channel 健康 / 错误率)
    render.ts                       # 纯字符串 SSR HTML, 含 30s meta refresh + escapeHtml XSS 防御
    routes.ts                       # GET /admin/dashboard (HTML) + /admin/dashboard/data (JSON)
  billing/
    calculator.ts                   # (new) 新增 recordObservability() 写回 channel_id / latency / attempted
  channels/
    health-checker.ts               # (new) 改用 createChildLogger, 不再 import pino
  scripts/
    mock-upstream.ts                # (new) 改用 createChildLogger
  (其余沿用 v0.8)
drizzle/
  0005_observability.sql            # (new) usage_records 加 channel_id / upstream_latency_ms / attempted_channels
```

启动:

```bash
cd examples/09-where-did-this-request-go
npm install
npm run migrate    # 0001/0002/0003/0004/0005, 共 5 份
npm run mock       # terminal 1: 监听 :4010
npm run start      # terminal 2: 监听 :3000
```

跑几次请求后浏览器打开 `http://localhost:3000/admin/dashboard?token=$ADMIN_TOKEN` 看 5 大 section + 全局摘要。任意一次请求的 `X-Request-Id` 响应头都能用于 `grep` stdout 反查全链路，或者走 `GET /admin/usage?traceId=<id>` 拿到 DB 里的完整账单。

## 下一章预告

v0.9 之后，每一分钱的去向和每一次请求的轨迹都可观测: 看板能告诉运营「今天哪个用户花得最多，哪个 channel 错误率最高」. 但当对比同样的 `gpt-4o-mini` 请求时，一件让人不愉快的事实暴露出来。自建网关的实际成本明显高于市面对外销售的中转站价格。

这背后是合规的成本优化，还是不合规的灰色操作: 第 10 章拆透中转站「比官方便宜」背后的真实降本机制，给出 5 种合法降本路径的可量化代码 (Prompt caching 透传 / Batch API 异步通道 / 渠道倍率与套利 / 成本路由 fallback / 企业渠道价差); 同时揭示 3 种灰色玩法的原理但不提供实现，并落一个 5 探针的指纹检测 CLI 做防御侧，让读者能识别上游是不是在偷换模型。

这是本书在对外卖 token 场景下的核心护城河章节。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
