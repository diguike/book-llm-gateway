---
title: 第 6 章 限流与配额
feishu_url: "https://www.feishu.cn/wiki/P4VwwnWf8i22J8kuHmycmgognxh"
last_synced: "2026-05-16T18:28:51"
---

## 6.1 那把 Key 在 10 分钟里打了 5 万次

v0.5 上线两周，月底拉账单，看到一行不该出现的数据:

```
key_id = 7    req = 50214    first_seen 10:42:11    last_seen 10:51:48
```

某把 Key 在 10 分钟里向网关打了 5 万次请求: 再去 `usage_records` 翻这把 Key 的归属——某个内部业务线刚上线的 RAG 服务，客户端把「上游 5xx 重试」的退避策略写漏了, retry 间隔 0 ms 的死循环跑了 600 秒。

账单上看, v0.5 的计费链路把每一笔都精确算到了，这把 Key 这 10 分钟消耗约 80 元，用户余额够付，也确实付了。但同一时间段，同一个 OpenAI 上游 Key 触发了「分钟级 TPM 上限」，上游返回 429, 网关无差别透传给所有客户端——其他十几把 Key 的正常调用全部被这场风暴拖累，看上去像「网关挂了」。

v0.5 解决的是「钱花到哪里」, v0.5 没解决的是「频率怎么控」。这两件事在工程上必须分开:

- 计费决定「值不值得放过去」，看的是余额够不够、价格表怎么算、归因到谁;
- 限流决定「来得太快放不放过去」，看的是单位时间内的请求数 / token 数，不关心价钱。

把这两条逻辑混进同一个 middleware 通常会出事故——余额边界的检查里夹杂 QPS 状态, QPS 状态又依赖外部存储 (Redis / 进程内 Map), 余额逻辑一被改，限流也跟着崩。本章把限流独立成一层，走自己的存储与状态机，在主路径上插在 auth 之后、preConsume 之前。

v0.6 要补齐的能力清单:

- 分层限流。全局 / 按 Key / 按 Model 三个维度独立配置，任一维度超限就拒;
- 双维度: QPS (每秒请求数。与 TPM (每分钟 token 数。分开建模，算法不同;
- 月度配额。给每把 Key 单独配「当月最多花多少钱」，配合 Ch5 的 402 状态码;
- 标准化的拒绝响应: 429 必带 `Retry-After`, 客户端能按头部退避;
- 抽 `RateLimiter` 接口，默认内存实现，留 Redis adapter 替换点。

为什么把这些能力压在「第 6 章」一章里。限流的工程难点不在算法本身——滑动窗口的代码 30 行能写完——而在与计费、与 ctx 注入、与失败路径释放、与跨章节复用 (TPM 在 Ch7 流式接入。的串联。如果只讲算法，读者跟着写出来的代码会在线上跑两周后，因为某条「漏释放」的边角分支把内存逐步占满，复现链路里没人看得出问题: 本章把这些边角全部点透，算法部分给到能直接 copy 的 30 行，复杂度集中在「主路径每个分支必须释放预扣」这条工程纪律上。

## 6.2 为什么必须分层

直觉上, 「限流 = 给每把 Key 设一个 QPS 上限」就够了。这在小流量阶段确实工作，但场景一拓宽就会撞上三个新问题:

**问题 1: 单 Key 限制控制不住「热门模型」的资源挤占**。同一个网关下挂着 OpenAI / DeepSeek / Anthropic 三家上游，上游各自有自己的「分钟级 TPM」配额。同一个 OpenAI 账号下, `gpt-4o` 与 `gpt-4o-mini` 共享同一份 TPM 池。如果 10 把 Key 同时挤兑 `gpt-4o`, 即使每把 Key 都没超自己的 QPS 上限，整体把上游的 `gpt-4o` TPM 吃光, `gpt-4o-mini` 一并被拖累。这种「跨 Key 的资源挤占」必须用按 Model 的限流来防御。

**问题 2: 全网关总流量没有兜底**。线上跑久了不可避免会出现「批量上线 100 把 Key」的场景 (例如内部工具批量接入)。即使每把 Key 都老老实实地遵守自己的 QPS 上限, 100 把 × 5 QPS = 500 QPS, 上游账号的整体 TPM 同样会被打爆。全局维度的限流是网关运维侧的最后一道兜底，跟单 Key 维度独立，防御对象不一样。

**问题 3: 不同 Key 的 SLA 不同**。免费试用 Key 与企业付费 Key 的限流策略肯定不一样——前者可能配 1 QPS / 1000 TPM, 后者配 100 QPS / 100K TPM。如果只有「全局限流」一层，这两类客户的流量都会挤进同一个全局桶，无法独立配置。

三个问题各自指向一个维度:

| 维度 | 防御对象 | 失效会怎样 |
|------|---------|----------|
| 按 Key | 单个客户端死循环 / 失控 | 单 Key 在分钟内打 5 万次, 拖累上游配额 |
| 按 Model | 热门模型挤占冷门模型 | gpt-4o 暴涨, gpt-4o-mini 被连带 429 |
| 全局 | 大盘异常的兜底 | 100 把 Key 同时合规调用, 但整体把账号打爆 |

本章实现三层全开，任一维度超限就拒。一次请求触发 1-3 个 check, 任一失败立刻 429, 失败时已经成功的 TPM 预扣要按维度回滚 (避免「按 Key 通过，按 Model 失败」时, Key 那笔 TPM 还占着无人释放)。

one-api 的限流层只做「按 Key」维度 (`middleware/rate-limit.go`), 用 `GlobalWebRateLimit / GlobalAPIRateLimit` 这种全局总量限流走在另一条路径上，两者没合并到一处. Portkey 用 `RateLimiterKeyTypes` (`src/globals.ts`) 把「user / virtual-key / workspace / org」做成四个 enum 值，内部分别建桶，在中间件层做并行 check——这个思路本章直接沿用，只是把四个 enum 简化成 key / model / global 三个。

**为什么不直接按 user 而是按 Key**? 一个 user 可以挂多把 Key (生产 / 测试 / CI / 第三方分发). 同一 user 下不同 Key 的限流策略大概率不同——生产 Key 5 QPS, CI Key 30 QPS (CI 跑批量任务). 按 user 限流的话，这两类流量挤在同一个桶里，测试就拖累生产: 本章把限流配在 Key 而不是 user, 是为了让运营有最细的配置粒度。想做「user 维度的总量限流」也很简单——加一个 `user:${userId}` 维度的 check, 配置在 users 表里，跟现有三维同样工作。

**为什么按 model 而不是按 (model × provider)**? 上游账号的 TPM 是按 provider 配额池算的，严格来说应该按 (model, provider) 限流。但 Ch2 的路由约定「同一 model 字面值固定路由到同一 provider」，路由表里 `gpt-4o` 只走 OpenAI, 不会同时跑 OpenAI 和 Azure. 这个简化在 Ch8 引入渠道池后会被打破——同一 model 可挂多个 channel, 那时再扩 limitKey 到 `model:${model}:channel:${channelId}` 即可，本章先按 model 这一维度做。

## 6.3 QPS 用滑动窗口

QPS 算法的核心约束是「任意 1 秒内的请求数 <= limit」。看似简单，实际上有两个候选实现，工程上有显著差异。

**固定时间窗口 (fixed window)** 把时间切成 1 秒一块的桶，每个桶维护一个计数器，桶内计数 < limit 就放过，满了就拒，下一秒桶重置。实现简单，但有「窗口边界 burst」问题: 假设 limit=5, 在 0.999 秒时打了 5 次 (恰好用完第一个桶), 1.001 秒又打了 5 次 (新桶刚开始), 实际上「0.999 - 1.001 秒」这 2 ms 内放过了 10 次，是上限的 2 倍。在 1 ms 级的攻防场景下这是真实风险。

**滑动窗口 (sliding window)** 维护每个 key 的请求时间戳队列，检查时把窗口外 (now - 1s 之前。的时间戳删掉，队列长度 < limit 就放过并把 now push 进去，否则拒。「任意 1 秒内的请求数 <= limit」严格成立，没有边界 burst.

代价是每个 key 的队列要存 limit 条时间戳，内存占用线性于 limit。在 limit < 1000 的合理范围内可忽略——QPS 上限本来就不该开得太大 (上游本身的 QPS 也是几十~几百), 滑动窗口的内存开销根本不是瓶颈。

`src/limit/sliding-window.ts` 的核心实现:

```ts
check(key: LimitKey, limit: number): QpsCheckResult {
  if (limit <= 0) return { ok: true, retryAfterMs: 0, currentCount: 0, limit: 0 };

  const now = Date.now();
  const cutoff = now - this.windowMs;  // windowMs = 1000

  let queue = this.store.get(key);
  if (!queue) {
    queue = [];
    this.store.set(key, queue);
  }

  // 把窗口外的时间戳 shift 掉
  while (queue.length > 0 && queue[0]! <= cutoff) {
    queue.shift();
  }

  if (queue.length >= limit) {
    // 拒: 等队头那条时间戳 + windowMs 到来就有新名额
    const retryAfterMs = Math.max(1, queue[0]! + this.windowMs - now);
    return { ok: false, retryAfterMs, currentCount: queue.length, limit };
  }

  queue.push(now);
  return { ok: true, retryAfterMs: 0, currentCount: queue.length + 1, limit };
}
```

算法蓝本是 one-api `common/rate-limit.go` 的 `InMemoryRateLimiter.Request`——一个时间戳数组 + 队头出窗 + 队尾入队的滑动窗口。`InMemoryRateLimiter` 用 Go 的 `sync.Mutex` 处理并发，本书在 Node.js 单线程模型下天然无需锁，实现少了 mutex 那几行，算法本身完全一致。

`retryAfterMs` 的计算是滑动窗口能给的最精确建议: 当前窗口里最早那条时间戳出窗时，就有新名额，不需要等满 1 秒。`Retry-After` HTTP 头按秒粒度返回, ms 级粒度通过 JSON body 的 `retry_after_ms` 字段额外暴露给愿意精细处理的客户端。

**为什么不直接用 Redis ZADD/ZSCORE 的滑动窗口?** 因为本章先做内存版本。Node.js 单进程内，内存 Map + 数组 shift 是 O(1) 同步操作, P99 在 < 5us; 换 Redis 之后单次 check 多一个网络 RTT (即使本地 Redis 也要 < 1ms), 性能反而退化。Redis 的价值在「多进程 / 多机共享窗口」，单机部署内存够用。`RateLimiter` 接口预留了替换点 (`src/limit/types.ts`), Redis 版只需要实现同一份接口——Portkey 的 `RedisRateLimiter` 用一段 Lua 脚本完成同等语义 (`src/shared/services/cache/utils/rateLimiter.ts`), 替换时直接参考。

**GC 策略**: cold key 长期不调用时不能让它的 deque 一直挂着。`startGc()` 每 60 秒扫一遍 store, 删除最后一条时间戳过期 60 秒以上的 key, 内存可控。GC 用 `setInterval` + `unref()`, 不阻塞 Node.js 进程退出。

**令牌桶 (token bucket) vs 滑动窗口**: 业界还有第三种主流算法——令牌桶 (Portkey 用的就是这套，见 `RATE_LIMIT_LUA`). 令牌桶按速率持续补充 token, 请求来时消耗一个 token, 没 token 就拒。它的优势是「允许 burst」(桶最大容量 = capacity, 短时间内可以集中放过 capacity 个请求), 缺点是参数有两个 (capacity + 补充速率), 配置心智成本高一倍。滑动窗口的配置只有一个数字「limit」，直观，适合做教学示例的默认算法。真要做对外卖 token 的商业网关，令牌桶能给客户更友好的 burst 体验，替换路径是同一份 RateLimiter 接口的另一份实现。

## 6.4 TPM 用预扣 + 实结

QPS 的窗口算法对「请求事件」工作得很好，因为请求是离散的 0/1 事件。TPM (token-per-minute) 的工作对象是「连续的 token 配额」，单次请求消耗的 token 数事先不知道——`max_tokens` 是上限，实际可能短得多，也可能流式响应吐着吐着比 `max_tokens` 还长 (极少，但会发生)。

如果按「请求结束后再扣 TPM」，会出三类问题:

1. 在响应到达之前, TPM 配额还在「未占用」状态, 100 个并发请求都能通过 check, 上游被打爆才发现已经超额了几倍;
2. 长尾响应 (例如 60 秒才返回的 reasoning 模型。占着 token 不结算，后续请求继续放过，总占用瞬时膨胀;
3. 客户端中途取消，已经吃掉的 token 没人记账。

这套逻辑应该非常熟悉——它和 Ch5 的两阶段计费完全同构。Ch5 的预扣是「按 max_tokens 预扣余额，上游返回后用真实 usage 多退少补」，把这套思路平移到 TPM 维度就是:

```
reserveTpm(key, reserveAmount, limit):
  estimated_input  = tiktoken 估算 (Ch5 已建好)
  reserve_amount   = estimated_input + max_tokens   // 预算上限
  if bucket.tokenCount + reserve_amount > limit:
    return 429
  bucket.tokenCount += reserve_amount

(调上游)

commitTpm(key, reserved, actual):
  // actual = 真实 (prompt + completion) tokens
  // 净占用 = actual, 多扣的部分退回, 少扣的部分继续扣
  bucket.tokenCount += (actual - reserved)

releaseTpm(key, reserved):   // 上游失败时
  // 等价于 commit(key, reserved, 0)
  bucket.tokenCount -= reserved
```

`src/limit/tpm-reservation.ts` 的桶实现选了「60 秒滚动桶」而不是滑动窗口。原因:

- TPM 的语义是「分钟级软上限」，上游本身就允许小幅 burst, 不需要严格的「任意 60 秒内 <= limit」;
- 一个桶 (timestamp + count) 的状态比一个时间戳队列简单一个数量级，实现复杂度低 50% 以上;
- 边界 burst 在 TPM 维度产生的危害远小于 QPS 维度: 即使在桶切换瞬间放过 2x token, 上游也不会立刻 429 (token 是连续配额，上游会平滑消化).

桶到期后整桶清零 + 重置 windowStart:

```ts
reserve(key, tokens, limit) {
  const now = Date.now();
  let bucket = this.store.get(key);
  if (!bucket || now - bucket.windowStartMs >= this.windowMs) {
    bucket = { windowStartMs: now, tokenCount: 0 };
    this.store.set(key, bucket);
  }
  if (bucket.tokenCount + tokens > limit) {
    const retryAfterMs = Math.max(1, bucket.windowStartMs + this.windowMs - now);
    return { ok: false, retryAfterMs, currentTokens: bucket.tokenCount, limit, reservedTokens: 0 };
  }
  bucket.tokenCount += tokens;
  return { ok: true, retryAfterMs: 0, currentTokens: bucket.tokenCount, limit, reservedTokens: tokens };
}
```

`commit` 时如果桶已经过期 (跨过 60 秒边界), 净占用 actual 直接落到新桶，不去回写老桶——老窗口的状态已经不存在了，强行回写也没意义。

**与 Ch5 余额扣减的正交性**。这两套两阶段是并行的:

- Ch5 余额: `preConsume` (UPDATE balance -= cost WHERE balance >= cost) → `postConsume` (UPDATE balance += delta) → `refundReservation` (整笔退回)
- Ch6 TPM: `reserveTpm` (bucket += tokens) → `commitTpm` (bucket += actual - reserved) → `releaseTpm` (bucket -= reserved)

两者都有自己的存储 (Ch5 走 DB 乐观锁, Ch6 走进程内存), 都有 reserve / commit / release 三段，但语义完全独立。余额管「钱够不够」(402), TPM 管「频率够不够」(429). 主路径会同时调用两套，任一失败拒掉，释放另一套已经做出的预扣。

把 TPM 桶里存的「token 数」和 Ch5 余额表里存的「微元」当作两条完全独立的轴线。用户付了钱不代表请求一定能放过去 (TPM 满); TPM 有余量也不代表请求一定能放过去 (余额不够). 两套机制叠加，才能完整描述「一次请求能不能进上游」这个判定. one-api 把这两件事混在 `model/user_cache.go` 的 `QuotaPerMin` 字段里 (按余额近似估算 TPM), 工程上是同一套金额计量的两种用法。本书把它们拆开，避免后续要做「不计费但限流」「计费但不限流」(例如 batch 通道。这类业务变种时改动牵涉过广。

## 6.4.1 三种限流算法的对照

| 算法 | 配置参数 | 严格性 | 实现复杂度 | 内存占用 | 本书选 |
|------|---------|------|-----------|---------|------|
| 固定窗口 | limit | 弱 (边界 2x burst) | 最低 | 极小 (1 个 counter) | 否 |
| 滑动窗口 | limit | 严格 | 中 (时间戳 deque) | 线性于 limit | QPS |
| 令牌桶 | capacity + refill rate | 严格 + 允许 burst | 中 (refill 计算) | 极小 (1 个 counter + lastRefill) | 否 |
| 漏桶 (leaky) | capacity + drain rate | 严格 + 流量平滑 | 高 (要后台线程) | 极小 | 否 |
| 60s 滚动桶 (本章 TPM) | limit | 软上限 (边界 burst 容忍) | 最低 | 极小 | TPM |

挑选逻辑:
- QPS 维度对严格性要求最高 (短时间 burst 直接打爆上游 1 秒 TPM), 选滑动窗口;
- TPM 维度允许小 burst (上游本身能平滑消化), 选实现最简单的 60s 滚动桶;
- 令牌桶是 Portkey 的选择，适合「想给客户 burst 容忍度」的对外卖 token 场景，本书留作后续可替换项。

## 6.5 抽 RateLimiter 接口

把上面两套实现拼起来，对外只暴露一个简单接口:

```ts
// src/limit/types.ts
export interface RateLimiter {
  checkQps(key: LimitKey, limit: number): QpsCheckResult;
  reserveTpm(key: LimitKey, tokens: number, limit: number): TpmReserveResult;
  commitTpm(key: LimitKey, reservedTokens: number, actualTokens: number): void;
  releaseTpm(key: LimitKey, reservedTokens: number): void;
  inspect(key: LimitKey): { qpsCount: number; tpmTokens: number } | null;
}
```

中间件只依赖这个接口，不依赖具体实现。`MemoryRateLimiter` 把 `SlidingWindowQpsLimiter` 与 `TpmReservationLimiter` 组合起来对外发布。Redis 版本要做的事情:

1. `checkQps` → Lua 脚本 + ZSET (ZADD 时间戳, ZREMRANGEBYSCORE 删过期, ZCARD 取长度);
2. `reserveTpm` → Lua 脚本 + INCRBY (60s EXPIRE), 或者参考 Portkey 的 token bucket 算法 (`src/shared/services/cache/utils/rateLimiter.ts`);
3. 接口契约本身不变。

为什么强调「Lua 脚本」: 限流的核心是「读-决策-写」必须原子。多个 Redis 命令分开发出去，在 check 通过到 increment 之间，另一个并发请求可以挤进来，同样的限额被 double-spent. Portkey 的 `RATE_LIMIT_LUA` (`src/shared/services/cache/utils/rateLimiter.ts:5`) 在脚本里完成「读 token + 计算 refill + 判断够不够 + 扣减」整套逻辑，一次 evalsha 完成。内存版在 Node.js 单线程下天然原子，不存在这个问题——这是单机内存方案在工程上的真实价值，不只是「省一台 Redis 服务器」.

进程内单例 (`getSharedLimiter()`) 让 admin 路由 (`/admin/keys/:id/usage-window`) 与请求中间件共享同一个 limiter 实例: 如果用「每次 new MemoryRateLimiter()」, admin 接口看到的窗口与中间件维护的窗口是两套独立内存，用户看到的「当前已用 QPS」对不上真实拦截行为。

## 6.6 中间件。三层 check + TPM 预扣注入 ctx

`src/limit/middleware.ts` 把三个维度组合起来。要点:

**位置**: 在 `requireGatewayKey` 之后，业务 handler 之前. auth 已经把 `keyId / userId / orgId` 注入 ctx, 限流 middleware 用 keyId 联查 keys 表拿到 `qps_limit / tpm_limit`. 然后做估算 + 三维 check.

```ts
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
  const auth = c.get('auth');
  const limitCtx = c.get('limit');   // 由 rateLimit middleware 注入
  // ... preConsume / 调上游 / postConsume
});
```

**三维 check 顺序**: key → model → global. 先按精细粒度拒，再按粗粒度拒。任一失败回滚已经成功的 TPM 预扣:

```ts
for (const ch of tpmChecks) {
  if (ch.limit <= 0) continue;
  const r = limiter.reserveTpm(ch.key, tpmReserveAmount, ch.limit);
  if (!r.ok) {
    // 回滚之前已经成功的 TPM 预扣
    for (const handle of tpmReservations) {
      limiter.releaseTpm(handle.limitKey, handle.reservedTokens);
    }
    return rateLimitResponse(c, { /* ... */ });
  }
  tpmReservations.push({ limitKey: ch.key, reservedTokens: r.reservedTokens });
}
```

回滚是必须的——如果不回滚, 「按 Key 通过，按 Model 失败」时, Key 那笔 TPM 预扣会一直占着，直到桶过期 60 秒。下次同一把 Key 调用时，由于 Key 桶已经被占了，即使没有真实流量也会持续 429.

**429 响应格式**:

```json
{
  "error": {
    "type": "rate_limit_exceeded",
    "message": "qps limit exceeded on dimension=key",
    "dimension": "key",
    "kind": "qps",
    "limit_key": "key:42",
    "limit": 5,
    "current": 5,
    "retry_after_ms": 412
  }
}
```

加上响应头:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1
```

`Retry-After` 必带，这是 HTTP 标准 (RFC 7231 §7.1.3). 客户端 SDK 会按这个头部退避——OpenAI 自家的 client 库读到 429 + `Retry-After: N` 时，自动 sleep N 秒重试，没这个头就会立刻死循环重试。单位是秒 (整数), 想给 ms 级建议就把它放进 JSON body 的 `retry_after_ms`.

**TPM 预扣的 handle 注入 ctx**: 中间件把 `{ limitKey, reservedTokens }[]` 数组放进 `c.var.limit.tpmReservations`, 业务 handler 在 postConsume 时调 `commitTpmReservations(handles, actualTotalTokens)`, 在 refund 时调 `releaseTpmReservations(handles)`. 没在 ctx 注入 handle 的话，业务 handler 没法定位回去，预扣会泄漏。

**body 读取**: middleware 需要拿到 `model / messages / max_tokens` 来做估算，必须读 body。Hono 的 `c.req.json()` 内部对 body 做了缓存——middleware 调一次，业务 handler 再调一次，第二次直接命中缓存，不会因为 stream 被消费而读不到。这一点踩坑过的工程师会有共鸣，实测过才敢确认。

**估算口径与 Ch5 共用**: 限流 middleware 调的 `estimatePromptTokens` 是 Ch5 已经写好的同一个函数，不要重新写一遍。这有两个好处。一是限流的「预扣 token 数」与 Ch5 的「预扣金额」基于同一份 token 估算，月度审计时 `(reservedTpm - actualTokens) / (preReservedCost - finalCost)` 这种比例分析有意义。二是 Ch7 流式接入时, `StreamingTokenCounter.ingestDelta` 用的也是同一份 `estimateCompletionTokens`, 整个网关里只有一处 tokenizer 逻辑，改算法时不会出现「Ch5 改了 Ch6 没改」的隐蔽偏差。

## 6.7 月度配额。给 Key 加 monthly_quota

QPS / TPM 防的是「分钟内的失控」，月度配额防的是「整月累积的爆表」。即使 QPS 没超，一把 Key 跑一个月也可能花掉 8000 元——业务方批了 200 元的月预算, 8000 元的账单到桌上需要解释半小时。

`keys` 表加五列:

```ts
qpsLimit              integer NOT NULL DEFAULT 0,   // v0.6 中间件用
tpmLimit              integer NOT NULL DEFAULT 0,   // v0.6 中间件用
monthlyQuotaMicro     integer NOT NULL DEFAULT 0,   // 月度配额上限 (微元)
monthlyUsedMicro      integer NOT NULL DEFAULT 0,   // 当月累计已用 (微元)
quotaResetAt          integer NOT NULL DEFAULT 0,   // 上次重置 monthly_used 的 unix ms
```

为什么 `monthly_quota` 放在 keys 表而不是 users 表。因为一个用户可能签多把 Key, 用途各异 (生产 / 测试 / CI). 每把 Key 独立配月度上限，防御边界清晰。one-api 的 `model/token.go` 同样把 `RemainQuota` 放在 Token 表 (≈ 本书的 Key), 设计动机一致。

**跨月归零**: `monthly_used` 在每个自然月初要归零。最直接的实现是定时任务 + crontab, 但教学场景下不想引入 cron 依赖。本章用「惰性归零」: 每次 `checkMonthlyQuota` 时比较 `quotaResetAt` 与「当前自然月起点」，落后则一条 SQL `CASE WHEN` 同时归零 `monthlyUsedMicro` 和更新 `quotaResetAt`:

```ts
db.update(keys)
  .set({
    monthlyUsedMicro: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN 0 ELSE ${keys.monthlyUsedMicro} END`,
    quotaResetAt: sql`CASE WHEN ${keys.quotaResetAt} < ${monthStart} THEN ${now} ELSE ${keys.quotaResetAt} END`,
  })
  .where(eq(keys.id, keyId))
  .run();
```

`CASE WHEN` 把读改回写的竞态消掉了——并发请求同时 checkMonthlyQuota 不会出现「都判断要归零，都各自 UPDATE 一次」的双写 (因为 SQL 自身是顺序执行的). 跨月那一刻只有一条 SQL 真正改了行，其他后续来的看到的 `quotaResetAt` 已经更新，不再触发归零分支。

**检查时机**: 在 `preConsume` 成功之后，调上游之前。preConsume 已经把余额扣了，这里查 `monthly_used + preReservedCost > monthly_quota` 是否成立，超过则 `refundReservation` + `releaseTpm` 后返 402:

```ts
const quota = checkMonthlyQuota(auth.keyId, reservation.preReservedCost);
if (!quota.ok) {
  refundReservation(reservation.recordId, 'monthly_quota_exceeded');
  releaseTpmReservations(limitCtx.tpmReservations);
  return c.json({
    error: {
      type: 'monthly_quota_exceeded',
      used_micro_cny: quota.used,
      limit_micro_cny: quota.limit,
      reserving_micro_cny: quota.reserving,
    },
  }, 402);
}
```

为什么用 402 而不是 429? 402 在 Ch5 是「余额不够」的语义，月度配额是「按 Key 的累积上限」，客户端的处理逻辑相同——都是「需要充值 / 提升配额，短期重试无意义」，不该和「429 等等再试」混淆。这也跟 OpenAI 自己的 `insufficient_quota` 错误一致。

**postConsume 时累加**: `commitMonthlyUsage(keyId, finalCost)` 在 postConsume 成功后一条 SQL 累加:

```ts
db.update(keys)
  .set({ monthlyUsedMicro: sql`${keys.monthlyUsedMicro} + ${finalCostMicro}` })
  .where(eq(keys.id, keyId))
  .run();
```

只有 status=finalized 的请求才累加, refunded / failed 都不累加——和 Ch5 余额扣减保持同一套语义。

**为什么累加路径要看 Ch5 的 status**? 因为 `commitMonthlyUsage` 在主路径里写在 `postConsume` 成功之后, postConsume 成功就意味着 `finalCost` 是真实消费过的金额。上游失败的 refund 分支根本不会走到这一行，自然不累加。这种「依赖上游函数的副作用顺序」的写法是 SQLite 单写串行下的工程便利，换 Postgres / 分布式环境要包一个外层事务才能保证一致性，留作后续基建升级时一起调整。

**月度配额是「软限」还是「硬限」**? 当前实现是硬限——超过就 402. 真要做对外卖 token 的商业网关，可能想给客户「软超 10%」的容忍 (避免月初月底卡点导致客户怨气). 这种业务策略放在 `checkMonthlyQuota` 内部做一次 `limit * 1.1` 的乘法就行，上游函数不用动。本章不展开，这类策略调整是一个简单 if 的事。

## 6.8 主路径接入

最终的主路径形态:

```ts
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
  const auth = c.get('auth');
  const limitCtx = c.get('limit');         // 限流 middleware 注入

  // ... zod 校验 / router.resolve ...

  // ----- preConsume: 余额预扣 -----
  let reservation;
  try {
    reservation = preConsume({ /* ... */ });
  } catch (err) {
    releaseTpmReservations(limitCtx.tpmReservations);    // 余额失败 → 释放 TPM
    if (err instanceof InsufficientBalanceError) return c.json({...}, 402);
    if (err instanceof PriceNotFoundError)    return c.json({...}, 400);
    throw err;
  }

  // ----- 月度配额检查 -----
  const quota = checkMonthlyQuota(auth.keyId, reservation.preReservedCost);
  if (!quota.ok) {
    refundReservation(reservation.recordId, 'monthly_quota_exceeded');
    releaseTpmReservations(limitCtx.tpmReservations);
    return c.json({...}, 402);
  }

  // ----- 调上游 -----
  // 网络错 → refund + releaseTpm
  // 业务错 → refund + releaseTpm
  // 成功 → postConsume + commitTpm + commitMonthlyUsage
});
```

关键约束: 任何「拒绝 / 失败」分支都必须释放 TPM 预扣，否则下次同一把 Key 的请求会被「上一次失败的预扣」拖累。代码里数一下 `releaseTpmReservations` 的位置: zod 校验失败 / stream=true / 路由失败 / preConsume 失败 / 月度配额失败 / 网络错 / 上游业务错 / postConsume 自身异常——8 个分支，每个都要释放。漏一个的话，失败的预扣会持续占用 60 秒，直到桶过期。这是新手最容易踩的坑，写完之后必须做一次 grep 自检:

```bash
grep -nE 'releaseTpmReservations|commitTpmReservations' src/index.ts | wc -l
# 期望 ≥ 8 (包含 7 个失败分支调 release + 1 个 postConsume 成功路径调 commit)
```

数出来少于 8 行就说明某个分支被忘了，跑到那条路径的请求会让 Key 的 TPM 桶卡 60 秒。

`releaseTpm` 不报错也不影响主流程——它是「整笔退回」，任意调一次都是幂等的 (除非 commit 已经发生过，这种情况下 release 会让桶值短暂偏负，内部用 `Math.max(0, ...)` 兜底).

**为什么不放在 Hono finally hook 里统一释放**? Hono 没有原生的「请求结束 hook」，可以用 `c.executionCtx.waitUntil` 在 Cloudflare Workers 上做，但 Node.js 适配器不支持。即使把 release 包成 finally 块，也得在 ctx 里挂一个 boolean 标记「这次有没有 commit 过」，复杂度跟显式调用 8 次差不多，而且 finally 隐藏了控制流，出问题时读代码的人很难定位「为什么这个预扣释放了」. 显式调用每条分支虽然啰嗦，但每条路径自洽，代码审查时直接搜 `releaseTpmReservations` 数 8 个调用点，一致就放心。

## 6.9 端到端验证: 看 429 真的出现

跑配套代码:

```bash
cd examples/06-someone-is-abusing-my-gateway
cp .env.example .env
# 改 ADMIN_TOKEN (本章演示用 test-admin-token-12345)

npm install
npm run dev
```

启动日志:

```
INFO db_migrations_applied applied=["0001_init.sql","0002_billing.sql","0003_quota.sql"]
INFO default_prices_seeded inserted=10
INFO Gateway v0.6 listening on http://localhost:3000
```

三份 migration 都应用了，默认价格灌入。建 org / user / Key, 一次配齐 QPS=2 / TPM=1000 / 月配额 10000 元:

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -s -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -s -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'

GW_KEY=$(curl -s -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"name":"throttled","qpsLimit":2,"tpmLimit":1000,"monthlyQuotaCny":10000}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
```

`monthlyQuotaCny` (元。经由 `monthlyQuotaCny × 1_000_000 = monthlyQuotaMicro` (微元。换算后写入 DB. admin API 接受元方便人输入，内部存储微元避免浮点误差. balanceCny 同理。月度配额相关字段在 §6.7 已定义为 `monthlyQuotaMicro / monthlyUsedMicro`, 都是微元单位。

跑攻击脚本, 20 个请求 / 5 并发，看 429 比例:

```bash
node --import tsx src/scripts/attack.ts \
  --base http://localhost:3000 \
  --key $GW_KEY \
  --model gpt-4o-mini \
  --total 20 --concurrency 5
```

实测输出 (示例):

```json
{
  "total": 20,
  "concurrency": 5,
  "by_status": { "429": 18, "502": 2 },
  "first_429_at_index": 2,
  "first_429_body": {
    "error": {
      "type": "rate_limit_exceeded",
      "message": "qps limit exceeded on dimension=key",
      "dimension": "key",
      "kind": "qps",
      "limit_key": "key:1",
      "limit": 2,
      "current": 2,
      "retry_after_ms": 990
    }
  },
  "first_429_retry_after": "1"
}
```

读这份结果:

- `by_status["429"]: 18`: 18 个请求被限流，占 90%;
- `502: 2`: 前 2 个请求通过限流 (QPS=2 的名额), 但上游 Key 未配置真实值，走到网络错 502 分支, refund 全额 + releaseTpm;
- `first_429_at_index: 2`: 第 3 个请求 (0-based) 开始被拒，印证滑动窗口的「最多 2 个名额」语义;
- `Retry-After: 1`: HTTP 头按秒, JSON body 的 `retry_after_ms: 990` 给毫秒精度。

实测的「first_429 时机」会因网络延迟与并发调度有 1-2 个 index 漂移，但 429 必然在前几个请求内出现——这是限流验证「真的拦住了」的核心证据。

调小并发再跑一次，看通过的请求路径:

```bash
node --import tsx src/scripts/attack.ts \
  --base http://localhost:3000 --key $GW_KEY \
  --total 2 --concurrency 1
```

```json
{ "total": 2, "by_status": { "502": 2 }, "first_429_at_index": null }
```

两个请求都通过限流 (没 429), 但上游 Key 未配置，网络错 502. 这是预期。限流只做流量整形，不替换计费 / 上游调用。这两次请求在内存里走了完整的 `reserveTpm` → 上游网络错 → `releaseTpm` 链路, TPM 桶在请求结束时退回到 0, 紧接着查 `/admin/keys/1/usage-window` 能看到 `qps.current = 1` (1 秒窗口内还有一条时间戳，等 1 秒后 GC) 和 `tpm.currentTokens = 0` (释放完毕).

切换到 TPM 限流场景，单次请求就拒:

```bash
# qps=0 (不限), tpm=50
curl -s -X POST $BASE/admin/keys/1/limits -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"qpsLimit":0,"tpmLimit":50}'

# 单次请求, prompt 估算 ~7 token + max_tokens 64 = 71, 超 50 → 429
curl -i -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":64}'
```

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
{"error":{"type":"rate_limit_exceeded","kind":"tpm","dimension":"key","limit_key":"key:1","limit":50,"current":0,"retry_after_ms":60000}}
```

TPM 维度的 `retry_after_ms` 是 60 秒——一个 token 桶的全周期，客户端最少等满当前分钟桶到期才有新额度。

月度配额场景:

```bash
curl -s -X POST $BASE/admin/keys/1/limits -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"qpsLimit":0,"tpmLimit":0,"monthlyQuotaCny":0.00001}'

curl -i -s -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

```
HTTP/1.1 402 Payment Required
{"error":{"type":"monthly_quota_exceeded","used_micro_cny":0,"limit_micro_cny":10,"reserving_micro_cny":17713}}
```

402 + 携带「当月已用 / 配额上限 / 本次想占用」三个字段，跟 Ch5 余额不足的 402 用同一类语义。

`/admin/keys/1/usage-window` 接口同时把内存窗口与 DB 月度状态拼出来:

```json
{
  "keyId": 1,
  "qps":     { "limit": 2,    "current": 0 },
  "tpm":     { "limit": 1000, "currentTokens": 0 },
  "monthly": { "limitMicroCny": 10, "usedMicroCny": 0, "limitCny": 0.00001, "usedCny": 0, "resetAt": 1715750999999 }
}
```

正常通过限流的请求，触发上游网络错时 `releaseTpm` 释放回去, `current` 跟着归零。这是验证「拒绝路径都正确释放预扣」的最直接观测点。

## 6.10 v0.6 之后还差什么

v0.6 完成的能力清单:

- 分层限流。全局 / 按 Key / 按 Model 三维独立配置，任一失败拒;
- 双维度: QPS 滑动窗口 (1s 严格上限) + TPM 60s 滚动桶 (预扣 + 实结);
- 月度配额: keys.monthly_quota_micro + 单 SQL 跨月归零 + postConsume 累加;
- 标准化 429: 必带 `Retry-After`, 含 dimension / kind / retry_after_ms 调试信息;
- RateLimiter 接口抽象，留 Redis adapter 替换点。

但 v0.6 的限流逻辑只在非流式请求上验证过。把场景拉到流式:

- 客户端发 `stream=true`, 网关在 reserveTpm 时按 `max_tokens` 预扣 (假设 1000 token);
- 上游开始一段段送 SSE event, 每秒吐 50 token, 跑 30 秒;
- 这 30 秒里, TPM 桶占着 1000 token, 但实际只发出了 1500——超出预扣 500;
- 30 秒后流结束, commitTpm 把多出的 500 写进桶 (bucket += 500), 桶值瞬间往上跳。

这套行为在「单次流式」上工作得没问题，但还有更难的边角:

- 客户端中途 Ctrl+C 取消。上游不再继续生成，实际只吃了几百 token, 但 reserveTpm 仍占着 1000——必须在反向取消的瞬间 commitTpm(预扣，已发出的实际值), 否则桶被压死;
- 流式 token 的「已发出的实际值」需要在 SSE 主循环里实时累加，这正是 Ch5 已经建好的 `StreamingTokenCounter`——Ch7 把它和 SSE 透传层、AbortController、commitTpm 都串起来;
- 流式响应的透传本身在 v0.6 之前的代码里就没接 — `stream=true` 现在直接 400 返「will be added in Ch7」.

v0.6 的限流在非流式上是闭环，在流式上等 Ch7 完成 SSE 透传后接入。这两条工作必须一起做才能让 token 配额在所有形态下都可控。

另外两件工程债务也值得点明:

**Redis adapter 没实现**. 本章只定义了接口 (`RateLimiter`), 提供了内存实现。真要部署多实例 (例如 docker-compose 起 3 个网关副本做负载均衡), 三个进程各自的内存窗口加起来才是真实流量，单实例的限流上限要除以 3 才不超额——这种「分摊配置」的工程负担最终还是要靠 Redis 共享桶解决. Ch12 上线整合章会回到这个话题。

**没有「先 check 后 commit」的 dry-run 模式**. 当前接口的 `reserveTpm` 直接消费配额。流式响应在 Ch7 接入时可能想要「先 check 不消费，流真的吐 token 时再增量 commit」，这要求接口扩出 `peekTpm(key, tokens, limit) → ok` 方法: 本章为了让接口最小化没加, Ch7 实现流式接入时再决定是否扩。

这些都是「不影响 v0.6 在单机非流式场景下闭环」的工程债，不阻塞读者跟着把代码跑通。但真要把网关部到对外环境，这些口子都得堵上。

## 配套代码

完整可运行的 v0.6 代码在 `examples/06-someone-is-abusing-my-gateway/`. 目录结构:

```
src/
  index.ts                # (new) 主路径接入 rateLimit middleware + checkMonthlyQuota
  limit/                  # (new) 本章新增
    types.ts              # RateLimiter 接口
    sliding-window.ts     # QPS 滑动窗口
    tpm-reservation.ts    # TPM 预扣 60s 滚动桶
    memory-limiter.ts     # 组合 + 进程内单例
    middleware.ts         # Hono middleware (三维 check + ctx 注入)
  billing/
    quota.ts              # (new) 月度配额: checkMonthlyQuota + commitMonthlyUsage
    (其余沿用 Ch5)
  admin/
    routes.ts             # (new) 扩展: /admin/keys/:id/limits + /admin/keys/:id/usage-window
  scripts/
    attack.ts             # (new) 滑动并发池压测脚本
  (其余沿用 Ch5)
drizzle/
  0001_init.sql
  0002_billing.sql
  0003_quota.sql          # (new) keys 加 qps_limit / tpm_limit / monthly_quota / monthly_used / quota_reset_at
```

`npm install && npm run dev` 启动，三份 migration 自动应用。跑 `npm run attack -- --base http://localhost:3000 --key sk-gw-XXX --total 20 --concurrency 5` 看 429 真的出现。

## 下一章预告

v0.6 之后，网关在非流式场景下做到了三件事。余额能算清 (Ch5), 流量能限住 (Ch6), 配额能上限 (Ch6). 但流式请求仍然走不通——`stream=true` 在 v0.6 直接返 400.

第 7 章把 SSE 流式透传补上，同时把 Ch5 的 `StreamingTokenCounter` 与 Ch6 的 `commitTpm` 在 SSE 主循环里串起来。流式响应跨越多个网络帧, token 用量在响应过程中持续累积，现有透传层既无法把流稳定地传给客户端，也无法在流式过程中实时扣 TPM 配额. Ch7 要解决: SSE 响应头规范、`data: [DONE]` 哨兵、上游断流、客户端 Ctrl+C 取消时的反向取消 (AbortController 全链路传递)、流式 token 计数器接入 billing 与限流的完整闭环。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
