# 第 8 章 v0.8 配套代码

v0.7 把流式响应跑通了, 但全网关仍然只能挂一把上游 Key. 这把 Key 一被风控 / 限速 / 维护, 网关就跟着挂. v0.8 引入贯穿全书的第四个核心领域对象 `Channel`(渠道), 把「一个 model 背后挂多个 channel + 故障转移」做成网关的内置能力.

## 目录结构

```
src/
  index.ts                          # ★ 主路径加 attemptWithFailover 循环 (流式 / 非流式)
  channels/                         # ★ 本章核心
    classifier.ts                   # 错误分类: transparent / retryable / disable / throttle
    registry.ts                     # 内存索引 ChannelRegistry, group2model2channels 三层 Map
    weighted-picker.ts              # priority 分层 + 同层 weight 随机
    router.ts                       # 高层包装: pickChannelForModel + buildAdaptorForChannel
    store.ts                        # channels + abilities 双表 CRUD, 全部包在事务里
    health-checker.ts               # 后台 worker, 每 60s 扫 disabled 探活恢复
    seed.ts                         # 默认 3 个 channel (含故意填错 key 的演示渠道)
    index.ts                        # barrel 出口
  streaming/
    sse-connect.ts                  # ★ 把流式 fetch + 状态判定抽出来, 让主路径能在「首字节前」换 channel
    sse-proxy.ts                    # ★ 改成接受「已连接的 Response」做边读边发
    (其余沿用 v0.7)
  scripts/
    mock-upstream.ts                # ★ 增加 Bearer 头校验 (api_key='mock' 才放行, 否则返 401) + 非流式 probe 分支
    failover-test.ts                # ★ 本章新增: 端到端验证故障转移
    stream-test.ts                  # 沿用 v0.7
  admin/routes.ts                   # ★ 新增 /admin/channels CRUD + /admin/channels/probe-now
  db/schema.ts                      # ★ 新增 channels / abilities 两张表
  (其余沿用 v0.7)
drizzle/
  0001_init.sql                     # 沿用
  0002_billing.sql                  # 沿用
  0003_quota.sql                    # 沿用
  0004_channels.sql                 # ★ 本章新增: channels + abilities (反范式索引表)
```

## 依赖

- Node.js 20+
- npm

## 启动 + 迁移

```bash
cd examples/08-the-key-just-got-banned
cp .env.example .env  # 至少改 ADMIN_TOKEN

npm install
npm run migrate    # 0001/0002/0003/0004, 共 4 份
npm run start      # 监听 :3000

# 另开 terminal 起 mock 上游
npm run mock       # 监听 :4010
```

首次 `npm run start` 时, 会自动把 3 个演示 channel 灌进库:

| id | name | api_key | base_url | 预期行为 |
|----|------|---------|----------|---------|
| 1 | mock-primary | `mock` | http://localhost:4010 | 正常 200 |
| 2 | mock-bad-key | `will-fail-401` | http://localhost:4010 | mock 上游会返 401, 触发自动禁用 |
| 3 | mock-network-unreachable | `mock` | http://localhost:14999 | 端口不存在, fetch ECONNREFUSED, retryable |

mock-primary 与 mock-bad-key 同 `priority=100, weight=5`, 加权随机时各占 50%. mock-network-unreachable `priority=50`, 只在前两个都失效后才会被选到.

## 准备一把 Key

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -sS -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -sS -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
GW_KEY=$(curl -sS -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"failover-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
echo $GW_KEY
```

## curl 看自动跳过坏 channel

跑 6 次非流式请求, 流量在 ch1 / ch2 之间 50/50 分摊, 命中 ch2 的请求会因 401 触发故障转移, 客户端看到的全部是 200.

```bash
for i in 1 2 3 4 5 6; do
  curl -sS -X POST $BASE/v1/chat/completions \
    -H "Authorization: Bearer $GW_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":16}' \
    -w "\n#$i HTTP %{http_code}\n" -o /dev/null
done
```

网关日志里能看到至少一次 `non_stream_upstream_failed` 带 `class: disable`, 紧跟着同一 `trace_id` 的成功落到另一个 channel.

## 看 channel status 变化

```bash
curl -sS $BASE/admin/channels -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -m json.tool
```

预期看到 `mock-bad-key` 的 status 是 `disabled` (运行几次请求之后).

调 probe-now 手动触发健康检查:

```bash
curl -sS -X POST $BASE/admin/channels/probe-now \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"scanned":1,"recovered":[],"stillDisabled":[2]}
```

因为 ch2 的 `apiKey` 仍然是 `will-fail-401`, 探活也是 401, 仍然 disabled. 修复 key 后再探活:

```bash
curl -sS -X PATCH $BASE/admin/channels/2 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"mock"}'

# 等下一次 health-checker tick (60s) 或手动 probe-now
curl -sS -X POST $BASE/admin/channels/probe-now \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# {"scanned":1,"recovered":[2],"stillDisabled":[]}
```

ch2 的 status 从 `disabled` -> `probing` (中间过渡, 一个 tick 内) -> `active` (探针通过).

`/admin/channels/:id/enable` / `/admin/channels/:id/disable` 是运营拉闸的快捷接口.

## 看流式首字节前重试

```bash
curl -N -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock-gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":16}'
```

如果这次请求被 picker 分到 ch2, 网关在 fetch 上游拿到 401 (首字节前) 会换到 ch1, 客户端只看到 ch1 的完整 SSE 输出. 网关日志:

```
WARN stream_upstream_failed_pre_byte   trace_id=...  channel_id=2  class=disable
INFO stream_upstream_connected         trace_id=...  attempt=1     channel_id=1  attempted=[2,1]
```

## 一键端到端验证脚本

`failover-test.ts` 把上面步骤封装成一个脚本.

```bash
GW_KEY=sk-gw-... BASE_URL=$BASE ADMIN_TOKEN=$ADMIN_TOKEN \
  npx tsx src/scripts/failover-test.ts
```

## 相对 v0.7 的核心变化

| 维度 | v0.7 | v0.8 |
|------|------|------|
| 上游路由 | model -> 静态 adaptor 单例 (启动时 new) | model -> ChannelRegistry.lookup -> weighted-picker -> 即时构造 adaptor |
| Key 故障处理 | 一把 Key 挂了, 整条线路死, 运维手动重启 | 错误分类器 + 自动禁用 + 后台探活恢复 |
| 错误分类 | 4xx 透传 / 5xx refund, 不区分 disable / throttle | 4 类: transparent / retryable / disable / throttle, 各走不同路径 |
| 流式上游故障 | 没拿到响应就直接 502 | 首字节前可重试换 channel (tryConnectStream + streamFromConnected 两段) |
| 选 channel 性能 | model -> O(1) Map 查 | 同上, abilities 反范式索引让 (group, model) 一次定位所有可用 channel |
| 健康检查 | 无 | 后台 worker 每 60s 扫一遍 disabled, 探活恢复 |
| admin API | orgs / users / keys / prices / usage | 上述 + channels CRUD + probe-now |

## 仍然故意保留的缺陷 (留给后续章节)

- 日志结构化程度不够, 按 trace_id / channel_id 反查全链路仍然靠 grep (Ch9)
- 渠道倍率 (channels.channel_multiplier) 没接进计费快照, 当前 multiplier_snapshot 还是 user × model 两路, Ch10 接成本优化时补上
- Channel API Key 明文存 (生产应加密, Ch12 上线整合时处理)
- /v1/messages 这条 Anthropic 原生入站路径仍然挂在固定的 `ANTHROPIC_API_KEY` 环境变量上, 没接渠道池

## 与 one-api 的对照

| 概念 | one-api 实现 | 本章实现 |
|------|--------------|---------|
| Channel 数据模型 | `model/channel.go` GORM 模型 | `db/schema.ts` channels 表 + Drizzle |
| 选渠道核心 | `model/ability.go::GetRandomSatisfiedChannel` | `channels/registry.ts::lookup` + `channels/weighted-picker.ts` |
| 内存缓存 | `model/cache.go::CacheGetRandomSatisfiedChannel` | `channels/registry.ts` (启动时 rebuild + admin CRUD 后 invalidate 重建) |
| 错误分类 | `monitor/manage.go::ShouldDisableChannel` (status code + 关键字字典) | `channels/classifier.ts::classifyError` |
| 自动禁用 + 通知 | `monitor/channel.go::DisableChannel` (含发邮件) | `channels/store.ts::markChannelDisabled` (DB + 日志, 通知留给 Ch9) |
| 故障转移重试 | `controller/relay.go` 顶层 retry 循环 | `index.ts` 主路径 `for (attempt < MAX) {}` |
| 健康检查 | `controller/channel-test.go::testChannel` (运营手动触发) | `channels/health-checker.ts` (后台 worker 自动 + admin 手动) |
