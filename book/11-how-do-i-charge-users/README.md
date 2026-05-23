---
title: 第 11 章 钱包与支付
feishu_url: "https://www.feishu.cn/wiki/CXotw148biGHtvka8hvc9fWrn0f"
last_synced: "2026-05-16T18:29:22"
---

## 11.1 把网关推到对外销售前差的一道关卡

v0.10 之后，自建网关已经具备了一切「能赚钱」需要的技术能力——多上游路由、协议适配、Key 鉴权、按用户计费、限流、流式、渠道池、可观测性、成本路由。五件合法降本机制叠起来能把对外报价压到官方的 25%-40%, 与市面上正规中转站持平。

但开门做生意还差一件事。用户怎么把钱打进来。

到目前为止 v0.10 的「余额」字段是 admin 手动调出来的:

```bash
curl -X POST $BASE/admin/users/1/balance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"setCny": 100}'
```

这条路径只对得起「公司内部 LLM 平台」场景——管理员已经知道每个团队该有多少额度，直接调数。对外卖 token 完全走不通。第三方开发者付完款，没有任何路径让钱自动落到他的网关账户里。客户付了 ¥100 给你，你需要手动登服务器调一次 admin 接口，这种流程在月活几十就崩了。

第 11 章把这条变现链路补上。三件事:

1. **新增三张表**: `wallets` (账户余额) / `recharges` (充值流水) / `refunds` (退款流水).
2. **抽象 `PaymentAdaptor` 接口**, 与 Ch2 的 `ProviderAdaptor` 形成对称设计，把 Stripe / 支付宝 / 微信支付三家平台的差异收敛到 4 个方法里。
3. **跑通三道核心难题**: 充值幂等、退款对账、余额并发扣减。

正文不接任何真实支付 SDK. 一来 Stripe / 支付宝 / 微信支付的接入是高度地区化 + SDK 频繁迭代 + 合规问题，写到正文很快过期。二来真正的工程难点在「抽象层」与「三道难题」，不在 SDK 调用。我们在 `examples/11/scripts/mock-payment-platform.ts` 里起一个本地 HTTP server 模拟支付平台异步回调，端到端跑通整条链路。真实接入要点放附录 A.

按 v3 draft 的 Ch11 合同，这一章对外创业场景必读，企业基建场景可以跳过。

为什么把支付独立成一章而不是塞进 v0.5 计费里。两件事的领域不一样。计费回答的问题是「这次请求该收用户多少钱」(token 计数 + 价格表 + 倍率 + 两阶段); 支付回答的问题是「这笔钱怎么从用户银行卡到网关账户」(订单创建 + 异步回调 + 幂等 + 退款 + 对账). 计费是 LLM 网关特有的 (token 单位、流式增量), 支付是所有有充值业务的产品都共享的 (电商、SaaS 订阅、游戏点数). 把两者强行揉一章会让两边都讲不透。

实际工程项目里也常常是两个独立团队负责。计费团队 owns prices / usage_records / multiplier, 支付团队 owns wallets / recharges / refunds + 平台对接。边界清晰才能让两边并行迭代。

## 11.2 为什么余额要从 users 表搬到 wallets 表

v0.5 引入计费时，余额字段直接挂在 `users.balance_micro`. 那个版本它是对的——计费 + 鉴权 + 用户身份是同一个领域对象，一张表搞完最简单. v0.10 之前的所有章节都没动过这个设计。

v0.11 必须把它拆开。三个理由:

**理由一。金融维度与身份维度分离**. `users` 是身份维度的对象，字段表达的是「这个人是谁」(org / email / 倍率); 余额是金融维度的对象，表达的是「这个钱包还有多少钱」. 一旦支持「同一 user 多钱包」(企业子账号、跨币种、按业务线分账), 就必须拆。

**理由二。写锁竞争的隔离**. preConsume 阶段的扣减是网关全部写入路径里**最频繁**的——每次请求一次。如果它和「改用户邮箱」「改用户倍率」共享 users 表, SQLite 的写锁会把这些低频管理操作也阻塞: 钱包独立成表后，钱包的高频写入与 users 的低频写入互不影响。

**理由三。权限隔离**. 财务团队需要读 wallet 字段做对账，不需要看用户邮箱。客服需要看用户档案，不需要看实时余额。拆成两张表后，数据库层的读权限可以分别配置。

新表结构:

```sql
CREATE TABLE wallets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL UNIQUE,    -- 一个 user 一个 wallet
  balance_micro   INTEGER NOT NULL DEFAULT 0, -- 可用余额 (微元)
  frozen_micro    INTEGER NOT NULL DEFAULT 0, -- 冻结余额 (本章不写, 留给提现 / 退款待回退)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

`user_id UNIQUE` 是强约束，保证 1:1 关系. v0.11 不打开「一 user 多钱包」，留作扩展点。

`balance_micro` 仍然用整数微元 (1 元 = 1_000_000 微元), 不用 REAL/float. SQLite 的 IEEE 754 在累加大量小额时会出现 `0.1 + 0.2 != 0.3` 这种精度误差，月账单累计能放大到几分钱差异: 整数 + 微元单位是金融字段的标准选择。

`users.balance_micro` 不动，兼容 v0.10 之前的代码路径 (cli/issue-key、admin 老接口). v1.0 整合时彻底废弃。

迁移 (`drizzle/0007_payment.sql`) 同时建另两张表:

```sql
CREATE TABLE recharges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id       INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,           -- 冗余, 看板按用户聚合不需要 join
  out_trade_no    TEXT    NOT NULL,           -- (new) 充值幂等的锚点, UNIQUE
  provider        TEXT    NOT NULL,           -- mock / stripe / alipay / wechat ...
  amount_micro    INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  raw_payload     TEXT,                       -- 平台回调原文, 审计 + 对账
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE UNIQUE INDEX recharges_out_trade_no_idx ON recharges (out_trade_no);

CREATE TABLE refunds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recharge_id     INTEGER NOT NULL,
  refund_no       TEXT    NOT NULL,           -- (new) 退款幂等的锚点, UNIQUE
  amount_micro    INTEGER NOT NULL,
  reason          TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',
  raw_payload     TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE UNIQUE INDEX refunds_refund_no_idx ON refunds (refund_no);
```

`out_trade_no` / `refund_no` 是网关侧生成的全局唯一商户单号。它们的 UNIQUE 索引就是「充值 / 退款幂等」三道难题里前两道的核心实现——后面 11.5 节会详讲。

设计参考: new-api 的 `model/topup.go::TopUp` 结构里有 `TradeNo / Status / PaymentProvider` 三个字段，与 `recharges` 表一一对应; one-api 的 `model/log.go::RecordTopupLog` 是单纯的流水日志，不带状态机，等价于「只有 succeeded 状态的简化版 recharges 表」. 我们做完整状态机是因为对外卖 token 必须能区分 pending / succeeded / failed / refunded 四态，不然客服根本无法回答「我充的钱怎么没到账」.

## 11.3 PaymentAdaptor: 与 ProviderAdaptor 对称的抽象

回看 Ch2 的 `ProviderAdaptor`:

```ts
interface ProviderAdaptor {
  name: string;
  buildRequest(ir: IRChatRequest): { headers; body };
  parseResponse(resp, raw): IRChatResponse;
  // ... 流式相关方法
}
```

它把 OpenAI / DeepSeek / Anthropic 三家上游 LLM 的协议差异 (字段位置、流式事件结构: 收敛到 5 个方法里。网关业务代码只看接口，不依赖任何上游 SDK.

`PaymentAdaptor` 是同样的设计，只是抽象的对象从「上游 LLM」换成「上游支付平台」:

```ts
interface PaymentAdaptor {
  name: string;
  createOrder(input: CreateOrderInput): Promise<CreateOrderOutput>;
  verifyCallback(payload: string, headers: Record<string, string>): Promise<VerifiedCallback>;
  refund(input: RefundInput): Promise<RefundOutput>;
  queryStatus(outTradeNo: string): Promise<QueryStatusOutput>;
}
```

四个方法对应支付平台的四个核心动作:

- `createOrder`: 在平台侧创建一笔待支付订单，返回支付凭据 (跳转 URL / 二维码 / clientSecret).
- `verifyCallback`: 平台异步通知到达后做验签 + 解析，返回标准化的 `{outTradeNo, status, amountMicro}`.
- `refund`: 异步发起退款，返回「平台是否受理」(真实退款到账时间在回调里).
- `queryStatus`: 同步查询订单状态，容灾用 (回调丢失时反查).

三家典型平台在抽象层的差异列对照表:

| 维度 | Stripe | 支付宝 | 微信支付 V3 |
|------|--------|--------|------------|
| 下单方式 | PaymentIntent API | alipay.trade.precreate | /v3/pay/transactions/native |
| 幂等键 | Idempotency-Key (HTTP header) | out_trade_no (商户单号) | out_trade_no (商户单号) |
| 回调形态 | webhook + 同步 redirect | 服务器异步通知 | 服务器异步通知 |
| 回调验签材料位置 | Stripe-Signature header | payload 字段 sign | Wechatpay-Signature header |
| 验签算法 | HMAC-SHA256 | RSA2 (商户公钥验) | AEAD-AES-256-GCM |
| 退款时机 | 同步返回 + webhook 二次确认 | 异步通知 | 同步 + 异步通知 |
| 对账文件 | Reports API (CSV/JSON) | 对账单查询接口 (CSV) | 交易账单 / 资金账单 (CSV) |

差异最明显的是「幂等键的位置」. Stripe 把幂等键放 HTTP header (`Idempotency-Key: <uuid>`), 平台侧用它在 24 小时内做请求去重 ([Stripe docs](https://stripe.com/docs/api/idempotent_requests)); 支付宝 / 微信支付把商户订单号 `out_trade_no` 当幂等键，同一个 out_trade_no 重复下单会被拒 ([支付宝异步通知文档](https://opendocs.alipay.com/open/270/105902), [微信支付 V3 通知文档](https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_0.shtml)).

从我们网关的视角看，这两件事其实是一回事——「这一笔业务请求，同 ID 不能重复创建订单」. 我们让 `createOrder` 入参里带 `outTradeNo`, 由网关侧生成全局唯一。调 Stripe 时把它当 `Idempotency-Key` 放 header, 调支付宝时把它当 `out_trade_no` 放 body, 业务层不感知差异。

`verifyCallback` 的接口设计同时收两个参数 `payload` (raw body) 与 `headers`. Stripe / 微信支付的验签材料在 header, 支付宝在 payload 字段: 让接口同时收两者，实现方按需选用。这是「抽象层最大公约数」的常见做法——接口比所有实现都「胖一点」，信息冗余优于信息缺失。

`refund` 几乎所有平台都是「异步」语义: 同步返回的只是「平台受理成功」，真正退款到账要等回调里再确认。所以我们在 `refund()` 之后**不**立即扣 wallet 余额，而是写一行 `refunds` (status=pending), 等回调进 `verifyCallback` 后再走 `handleRefundCallback` 真正回退。

`queryStatus` 是容灾接口: 真实运营经常碰到「平台回调丢了」的情况——网络抖动、网关重启、URL 配错，回调没收到，平台默认重试 3-5 次后放弃。这时只能我们主动反查. 11.6 节的 reconciler 用这个方法做 T+1 对账。

注册表 `payment/registry.ts` 与 `channels/registry.ts` 同构。启动时挂上需要的 adapter, 业务代码按 name 取。本章 v0.11 只挂 mock; 真实接入加 stripe / alipay / wechat 时，在 boot 阶段 register() 即可，不动其他代码。

抽象层有一件事值得多说一句——**为什么不让 createOrder 直接写 recharges 表**. 看似多此一举: adapter 反正知道 outTradeNo 和 amount, 顺手 INSERT 一行不就完了。实际上必须分开。写库是 wallet/service 的责任 (只有它知道完整的金融状态机，知道哪些字段要冗余、哪些不能动); adapter 只负责跟外部平台说话。这两件事混在一起就会出现「Stripe adapter 调用了一些它不该知道的内部表结构」，以后想换 schema 就会牵一发动全身。接口的责任分离是金融模块特别需要守的纪律。

类似地, `verifyCallback` 也只做两件事。验签 + 解析出标准化字段: 它**不**写库，不更新 wallet, 不发邮件。解析完就把 `VerifiedCallback` 对象丢给上层，上层 (`wallet/service.handleRechargeCallback`) 根据状态机决定是否入账。这个分层让接口层稳定 (`PaymentAdaptor` 的 4 个方法在所有平台上语义一致), 业务层灵活 (改状态机不用动 adapter).

## 11.4 mock 支付平台。不接 SDK 也能完整跑通链路

为了不接真实 SDK 还能完整演示链路，我们写一个本地 HTTP server 模拟支付平台。协议是 mock 自定义的，但流程与真实平台 1:1 对齐:

1. **下单**: 网关调 `POST $MOCK_PAY/api/orders`, mock 返回 `redirect_url` (假装是支付收银台).
2. **「用户付款」**: mock 默认 3 秒后自动 POST 一份 payload 到网关的回调 URL, 模拟「用户在收银台点了支付按钮」.
3. **回调**: 网关的 `/payment/notify/mock` 收到 payload, 走 verifyCallback → handleRechargeCallback, 入账。
4. **退款**: 网关调 `POST $MOCK_PAY/api/refunds`, mock 同步返回「受理成功」，然后 2 秒后异步回调 `kind=refund`.

mock 支持手动触发回调 (`POST /api/orders/:no/pay`), 模拟「平台 30 秒后没收到 200 重发」的真实行为: 这条路径用来验证幂等。

签名算法用 HMAC-SHA256, 字段拼接 `${out_trade_no}|${status}|${amount_micro}|${kind}`, secret 通过环境变量 `MOCK_PAY_SECRET` 注入两端共享:

```ts
// src/payment/mock.ts (节选)
export function computeMockSignature(
  fields: { outTradeNo: string; status: string; amountMicro: number; kind: string },
  secret: string,
): string {
  const joined = `${fields.outTradeNo}|${fields.status}|${fields.amountMicro}|${fields.kind}`;
  return createHmac('sha256', secret).update(joined).digest('hex');
}
```

验签时用 `timingSafeEqual` 防时序攻击，长度不一致直接返 false:

```ts
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
```

真实平台的验签算法不一样 (Stripe = HMAC-SHA256 但 secret 由平台分发，支付宝 = RSA2 用支付宝公钥，微信 V3 = AEAD-AES-256-GCM 解密 ciphertext 还原 payload), 但「长度先校验，后用 constant-time 比较」是所有 adapter 都必须遵守的纪律。用 `===` 比较签名等于把 secret 拱手让给时序攻击者。

`verifyCallback` 验签失败时抛 `CallbackVerificationError`, 网关层在 `payment-routes.ts` 捕获后返 400 给平台:

```ts
// src/admin/payment-routes.ts (节选)
let verified;
try {
  verified = await adaptor.verifyCallback(rawBody, headers);
} catch (err) {
  if (err instanceof CallbackVerificationError) {
    logger.warn(
      { provider, reason: err.reason, body_preview: rawBody.slice(0, 200) },
      'callback_verify_failed',
    );
    return c.text('fail', 400);
  }
  // ... 其他异常
}
```

返 400 不返 200 是关键: 平台收到非 2xx 后会按重试策略重发。如果验签失败还回 200, 平台不会再发，这一笔就永远丢了。

mock 平台跑在 5010 端口，与主网关 (3000) / mock LLM 上游 (4010) 错开。三个进程一起开能完整复现整条链路，不需要外网，不需要任何 SDK.

## 11.5 充值幂等: 唯一索引 + 状态机

充值幂等是支付链路里最核心的不变量。它的本质是: **同一笔订单，不管支付平台回调多少次，都只能入账一次**.

支付平台的回调机制几乎都有重试. Stripe 的 webhook 默认按指数回退重试 3 天 ([Stripe webhook docs](https://stripe.com/docs/webhooks#retry-logic)); 支付宝 / 微信支付都是「8 次，间隔从 4 分钟到 24 小时」. 重试触发条件很宽——网关侧返 5xx、超时、返 200 但 body 不对——任何一种都会让平台再发一次。

如果业务层每次回调都直接 `wallet.balance += amount`, 一个用户充 ¥100 可能被入账好几次，网关侧账目崩盘。这是新手做支付最容易踩的坑。

正确做法用两件事保证幂等:

1. **DB 唯一索引**: `recharges.out_trade_no UNIQUE`. 同 out_trade_no 重复 INSERT 撞约束，业务层捕获后做状态机判断。
2. **状态机**: 每个 recharges 行有 status 字段 (pending / succeeded / failed / refunded). 每次回调进来先查现状，按状态决定行为。

状态转移表:

| 当前 status | 回调 status | 动作 |
|------------|------------|------|
| pending | succeeded | 入账 (wallet.balance += amount) + 改 status=succeeded |
| pending | failed | 改 status=failed, 不入账 |
| succeeded | succeeded | 幂等返回 ok, 不重复入账 ((new) 重复回调走这里) |
| succeeded | failed | 忽略 (已成功的订单不能被失败回调改成失败) |
| failed | succeeded | 入账 + 改状态 (跨平台重新发起的成功支付) |
| failed | failed | 忽略 |
| refunded | * | 忽略 (已退款的订单不再接收任何回调) |

实现在 `wallet/service.ts::handleRechargeCallback`:

```ts
// src/wallet/service.ts (节选)
export function handleRechargeCallback(
  input: HandleRechargeCallbackInput,
): HandleRechargeCallbackOutput {
  const db = getDb();
  const rows = db
    .select()
    .from(recharges)
    .where(eq(recharges.outTradeNo, input.outTradeNo))
    .all();
  if (rows.length === 0) {
    // 平台回调了一个我们没创建过的订单 -- 异常情况, 记日志但不入账
    return { status: 'failed', credited: false, notice: '...' };
  }
  const recharge = rows[0]!;

  // 金额校验: 平台回调里的金额必须与下单时一致, 否则可能是篡改
  if (recharge.amountMicro !== input.amountMicro) { /* ... */ }

  // 已退款 / 已 succeeded: 幂等, 重复回调直接返 ok
  if (recharge.status === 'refunded') { /* ignore */ }
  if (recharge.status === 'succeeded') {
    return { status: 'succeeded', credited: false, notice: 'already succeeded, idempotent ok' };
  }

  // 状态需要变化的情况:
  if (input.status === 'failed') {
    db.update(recharges).set({ status: 'failed', ... }).run();
    return { status: 'failed', credited: false, notice: 'marked failed' };
  }

  // input.status === 'succeeded' && recharge.status in (pending, failed) -> 入账
  const credited = creditBalance({ walletId: recharge.walletId, amountMicro: input.amountMicro });
  db.update(recharges).set({ status: 'succeeded', ... }).run();
  return { status: 'succeeded', credited: true, balanceAfter: credited.balanceAfter, notice: 'credited' };
}
```

每个分支的语义都明确写出来，没有「默认行为」「兜底逻辑」. 涉及钱的代码不能依赖 fallback——任何意外都应当被显式分支处理 + 落日志 + 返回明确结果。

`credited` 字段是给上层 (HTTP handler) 看的. true 表示本次回调里真正动了余额，写一条 `recharge_callback_processed credited=true` 的日志; false 表示重复 / 已终态，写 `credited=false notice="already succeeded, idempotent ok"`. 看板按这两条聚合就能知道「最近 24 小时收到多少笔重复回调」，数字异常高通常意味着平台侧某个 webhook 配置出错。

金额校验那一行 (`recharge.amountMicro !== input.amountMicro`) 是另一道防御。真实场景下平台回调的金额理论上必须等于下单金额，中间可能有 BGP 劫持、回放攻击或更常见的——网关侧 bug 把订单金额存错. **金额对不上是 bug 或攻击，不会靠重试自愈**. 所以这里返 200 让平台停止重发，同时写一条 warning 日志 + 保存完整 raw_payload, 由人工对照原下单金额复核。这是「止血优先于追责」的设计选择——继续返 5xx 让平台一直重试不解决任何问题，还会让排查时被刷屏的日志淹没。

跑一次实测 (`payment-flow-test`):

```
[..] wallet after recharge callback {"balanceCny":10}    # 第 1 次回调入账
[..] triggering duplicate callback...                     # mock 平台手动触发第 2 次
[..] wallet after duplicate callback {"balanceCny":10}    # (new) 余额不变
```

第 2 次回调进入 `handleRechargeCallback` 时，状态已经是 succeeded, 直接返 `notice="already succeeded, idempotent ok"`, wallet.balance 不变。主网关日志:

```
recharge_callback_processed status=succeeded credited=false notice="already succeeded, idempotent ok"
```

UNIQUE 索引 + 状态机这两件事缺一不可。只有 UNIQUE 没状态机，第二次回调撞约束抛错，但平台收到 5xx 还会重发，死循环。只有状态机没 UNIQUE, 高并发下两个回调同时 INSERT 都成功，入账两次。

为什么必须用 DB 唯一索引而不是「应用层加锁」? 看 new-api 的实现，它在 `controller/topup.go::EpayNotify` 里用 `LockOrder(tradeNo) / UnlockOrder(tradeNo)` 一对函数 (基于 sync.Map + sync.Mutex 实现的进程内锁。串行化同 tradeNo 的回调: 这种实现单进程下没问题，但中转站一旦扩容到多实例 (k8s 多副本), 进程内锁就完全失效——两个实例同时收到平台重发的回调，内存锁互不知情，双双 INSERT 入账两次. DB 唯一索引是「跨进程、跨重启都成立」的保证，这是它唯一不可替代的优势. Redis 分布式锁也行，但多引入一个组件。既然已经在 SQLite 上了，用唯一索引最朴素也最可靠。

另一个常被问的问题: 既然 INSERT 撞约束了，为什么不把 INSERT 当幂等入口，直接在 INSERT 前判断「是否已存在」? 也就是 `SELECT ... WHERE out_trade_no = ?`, 没找到就 INSERT, 找到就更新 status. 这种写法在低并发下能跑，但在「平台重发回调每 30 秒一次」+「同时还有 admin 在主动查订单」的场景里会出现 TOCTOU (time-of-check-to-time-of-use) 漏洞: SELECT 完到 INSERT 之间另一个线程已经 INSERT, 第一个线程再 INSERT 撞约束: 与其拐弯抹角，不如直接 INSERT + 捕获约束异常，既快又准。

实际生产中还有一类「特别恶心」的回调: 同一笔订单，平台 A 已经回调成功，用户又通过平台 B 重新付了一次，平台 B 也来回调: 我们的 out_trade_no 是网关侧生成的，同一笔订单在两个平台上的 out_trade_no 不同，这种重复支付没法靠 UNIQUE 防，必须靠「订单号 → 业务订单」上一层映射. v0.11 教学版不处理这个场景 (中转站充值通常是一次性创建一个 out_trade_no 跟一家平台绑定，用户切换平台时取消原订单), 真实电商会复杂很多。

## 11.6 退款对账: T+1 平账机制

充值幂等保证「钱不会多算」，但退款链路比充值复杂——它涉及「网关侧 + 平台侧 + 银行侧」三方时差，任何一方延迟或失败都会留下「单边账」.

退款的标准流程:

1. admin 决定退款 (客户取消订单 / 服务不满意 / 重复支付);
2. 网关调 `adaptor.refund()`. 大多数平台同步返回「受理成功」，真正退款到账要等回调或 T+1 对账;
3. 网关写一行 `refunds` (status=pending);
4. 等平台异步回调到 `/payment/notify/:provider`, payload.kind=refund;
5. 网关进 `handleRefundCallback`, 真正回退余额。

回调能正常走完时，一切都顺。但回调丢了怎么办。平台已退款，网关侧 refunds 还停在 pending, 用户的 wallet 余额没回滚——等于钱已经被支付平台退给银行，但用户在中转站还能继续消费同等额度。这是单边账。不修就是真金白银的亏损。

T+1 对账的工程做法:

1. 每天凌晨拉一次平台的对账文件 (Stripe Reports API、支付宝下载对账单接口、微信资金账单接口). 文件里是平台侧最终一致的视图。
2. 与网关侧 `recharges + refunds` 表 diff. 四种 diff 维度:
   - **网关有，平台没**: 我方丢单 (回调到了但没存好). 极少，紧急人工。
   - **平台有，网关没**: 平台单边账 (回调没送到 / 验签失败). 比较常见。
   - **双边都有但状态不一致**: 回调丢失。跟上一个同处理。
   - **金额不一致**: 罕见，几乎一定是上游 bug 或人工篡改，直接告警，不自动修。
3. 第二三种自动平账。调 `adaptor.queryStatus()` 二次确认 → 走与正常回调同一份 `handleRechargeCallback / handleRefundCallback`, 凭幂等保证不会二次入账。

正文 `payment/reconciler.ts` 给一个骨架，不实现具体平台的对账文件下载 (各家格式差异极大，留作扩展):

```ts
// src/payment/reconciler.ts (节选)
export async function reconcileRecharges(opts: ReconcileOptions): Promise<ReconciliationDiff> {
  const adaptor = getPaymentAdaptor(opts.provider);
  const db = getDb();
  const rows = db.select().from(recharges)
    .where(and(
      eq(recharges.provider, opts.provider),
      gte(recharges.createdAt, opts.fromMs),
      lte(recharges.createdAt, opts.toMs),
    )).all();

  const diff: ReconciliationDiff = {
    matched: 0, gatewayOnly: [], pendingButPlatformSucceeded: [], statusMismatch: [],
  };

  for (const r of rows) {
    const q = await adaptor.queryStatus(r.outTradeNo);
    if (q.status === 'unknown') {
      diff.gatewayOnly.push({ outTradeNo: r.outTradeNo, gatewayStatus: r.status });
      continue;
    }
    if (r.status === q.status) { diff.matched += 1; continue; }
    if (r.status === 'pending' && q.status === 'succeeded') {
      diff.pendingButPlatformSucceeded.push({ ... });
      continue;
    }
    diff.statusMismatch.push({ ... });
  }
  return diff;
}
```

这个骨架的简化点是「跳过对账文件下载，直接用 queryStatus 逐条二次确认」. 真实生产用「对账文件做全量 diff + 个别异常订单 queryStatus 二次确认」，这是因为 queryStatus 通常有限流 (Stripe 100 QPS、支付宝单商户每秒 10 次), 如果用它扫所有订单很容易触发，而对账文件是一次下载、本地处理，不限流。

`autoFixPendingFromReconciliation` 把 diff 出的 `pendingButPlatformSucceeded` 自动补单——调 handleRechargeCallback, 凭幂等保证不重复入账。真实运营 99% 的场景靠这条路径自愈, 1% 是 statusMismatch 走人工复核。

退款回调的处理逻辑 (`handleRefundCallback`) 与充值同构，状态转移表对照 §11.5 长这样:

| refund.status | 回调 status | 动作 |
|--------------|------------|------|
| pending | succeeded | **真退款** (wallet 余额 -= refund.amountMicro, 允许扣穿) + 翻 refund.status=succeeded + 翻 recharges.status=refunded |
| pending | failed | 改 refund.status=failed, recharges.status 保持 succeeded, 不动 wallet |
| succeeded | * (任意) | 忽略 (幂等返 200, 防止平台无限重发) |
| failed | * (任意) | 忽略 |
| refund_no 找不到 | * | 落 warning 日志 + raw_payload, 返 200 不抛错 (避免平台死循环重试) |

只比 recharge 多了一个「真退款」分支需要动 wallet, 其它分支语义都对称。找不到 refund_no 时不抛错的理由跟 §11.5 金额校验失败一致。这种异常 100% 是 bug 或攻击，不会靠重试自愈。

「真退款」分支多一件事——余额回退**允许扣穿**:

```ts
// src/wallet/service.ts (节选, handleRefundCallback)
// input.status === 'succeeded' -> 真正退款
// 1. 余额回退 (允许扣穿). 不用 deductBalance (它带 >= 检查), 直接单 SQL.
const updated = db.update(wallets)
  .set({
    balanceMicro: sql`${wallets.balanceMicro} - ${input.amountMicro}`,
    updatedAt: now,
  })
  .where(eq(wallets.id, recharge.walletId))
  .returning({ balance: wallets.balanceMicro })
  .all();
```

为什么允许扣穿。假设用户充 ¥100, 已经花了 ¥80, 现在申请退款。平台已经把 ¥100 退回到用户的银行卡，网关侧必须把这 ¥100 从 wallet 里减掉，不然用户白嫖了 ¥80. 如果余额不足导致退款执行不了，用户手里实际拿到 ¥100, wallet 里还显示有 ¥20, 后续他可以再消费 ¥20——双扣。

业务策略上有两种处理:

- **a. 强制扣穿** (本章选这个): 允许 wallet.balance 变成负数，后续充值时优先抵扣这部分。简单，适合「容忍坏账率低 + 用户回流概率高」的场景。
- **b. 冻结策略**: 把 frozen_micro 标上，等用户后续充值时自动抵扣。复杂，适合「教育产品」(家长退款时学生还在用) 这种场景。

教学版选 a. 真实运营按你的客户群体决定. `wallets.frozen_micro` 字段已经预留，切换到 b 只需要改一行业务逻辑。

跑实测看扣穿效果:

```
[..] wallet after chat {"balanceMicro":9999995,"balanceCny":9.999995}   # 充 ¥10, 花了 5 微元
[..] initiating refund...
[..] waiting 3s for refund callback...
[..] wallet after refund {"balanceMicro":-5,"balanceCny":-0.000005}     # (new) 扣到 -5 微元
```

退款金额 10000000 微元，钱包当时余额 9999995 微元，强制扣完变成 -5 微元 (= 用户已消费的 5 微元). 这个负数代表「用户欠中转站 5 微元」，下次他再充钱时会先扣掉这 5 微元再入账。

对账还有一个常见盲点是「用户拿到平台对账单，跟客服吵起来」. 用户的视角是「平台说我充了 ¥100」，网关侧可能因为各种原因 (回调丢失 / 验签失败 / 网关重启。状态停在 pending. 客服打开 admin 看到 pending, 一头雾水. T+1 reconciler 跑完后，这种 pending 应该自动被 queryStatus 修成 succeeded. 但 reconciler 跑的频率决定了「客服能多快回复用户」——一天一次的话，用户在零点之后充值要等到第二天才有结果: 高客户量的中转站会把它压到 5-10 分钟一次 (针对 pending 超过 N 分钟的订单), 在自动化与平台 API 限流间找平衡。

reconciler 的另一个工程坑是「对账时间窗的边界处理」. 平台对账单通常是「截至前一天 24:00」的快照，但「前一天 23:59:50 创建、23:59:55 回调」的订单可能在你这一天的对账窗口里，也可能在下一天的对账窗口里，取决于平台的 cut-off 时刻。严格的做法是。每次对账拉两天的数据 (前一天 + 当天), 用 outTradeNo 做去重，不在某一段窗口里的订单不处理。教学版骨架用 `[fromMs, toMs]` 闭区间，真实运营要把这个窗口拉宽 + 接受少量重复处理 (反正幂等保证安全).

## 11.7 余额并发扣减。单 SQL 乐观锁

第三道核心难题是余额并发扣减，这一道在 v0.5 计费模块里其实已经处理过——但只在单表 (users) 内. v0.11 把余额搬到 wallets 表后必须重做。

并发扣减的反例是「先 SELECT 后 UPDATE」:

```ts
// 反面教材
const wallet = db.select().from(wallets).where(eq(wallets.id, walletId)).all();
if (wallet[0].balanceMicro >= cost) {
  db.update(wallets)
    .set({ balanceMicro: wallet[0].balanceMicro - cost })
    .where(eq(wallets.id, walletId))
    .run();
}
```

两个并发请求都 SELECT 到 100, 都判断 100 >= 80 通过，都 UPDATE balance = 100 - 80 = 20. 结果两笔都成功，但 wallet 实际只有 100 元，多扣了 80 元变成 -60. 这是经典的丢失更新。

正确做法是单条 UPDATE 配合 WHERE 条件，让 SQLite 把「检查 + 扣减」当原子操作:

```ts
// src/wallet/service.ts (节选, deductBalance)
const updated = db
  .update(wallets)
  .set({
    balanceMicro: sql`${wallets.balanceMicro} - ${input.amountMicro}`,
    updatedAt: now,
  })
  .where(
    and(
      eq(wallets.id, input.walletId),
      sql`${wallets.balanceMicro} >= ${input.amountMicro}`,
    ),
  )
  .returning({ balance: wallets.balanceMicro })
  .all();

if (updated.length === 0) {
  // 区分两种失败原因: wallet 不存在 vs 余额不足
  const cur = db.select({ b: wallets.balanceMicro }).from(wallets)
    .where(eq(wallets.id, input.walletId)).all();
  const have = cur.length > 0 ? cur[0]!.b : 0;
  throw new InsufficientWalletBalanceError(input.walletId, input.amountMicro, have);
}
```

`UPDATE WHERE balance_micro >= cost RETURNING balance_micro` 一条 SQL 完成「检查并扣减」，单语句在 SQLite 层面是原子的，两个并发请求不会同时扣穿. RETURNING 0 行意味着两种情况之一:

- wallet 不存在 (id 错了);
- balance 不够 (并发请求先扣到了，或本就不够).

抛 `InsufficientWalletBalanceError` 到上层, billing/calculator.ts 把它转成 `InsufficientBalanceError` (老符号兼容), 主路径返 402 给客户端: 客户端拿到 402 + `available_micro_cny` 字段就知道余额不够，提示用户充值。

为什么不用「先扣到 0, 看 RETURNING 是不是负数」这种实现。一行 UPDATE 是原子的，但负数已经发生过。后续可能其他逻辑把负数当 0 处理，或者下一笔请求又判断「100 - 80 = 20 还能扣」，实际余额是 -60 → -140. 守住 `>= cost` 这条不变量是金融字段的最低要求，退一步都不行。

跑并发压测验证 (`wallet-concurrency-test`):

```
{"stage":"setup","userId":3,"initial_balance_micro":105,"pre_reserve_per_request_micro":35}
{"stage":"result","concurrent":50,"initial_budget_micro":105,"actual_200":10,"actual_402":40}
{"stage":"final_wallet","balance_micro":55}
{"stage":"pass","verdict":"wallet optimistic lock prevented overspend"}
```

50 并发，初始余额 105 微元 (只够 3 笔预扣同时占着), 结果 10 笔成功 + 40 笔被乐观锁拒掉，最终余额 55 微元 (没扣穿). 「成功 10 笔」是动态的——每笔成功后 postConsume 退回大约 30 微元，释放出去的 budget 被下一笔抢走，所以最终能跑完 ≈ 10 笔。但「balance_micro >= 0」严格成立，这是乐观锁的核心承诺。

退款回退的「允许扣穿」(11.6 节那个 SQL) 是这条规则的唯一例外。它去掉了 `>= cost` 条件，因为退款必须执行——平台已经退款了, wallet 必须减掉，即使变负。这个例外集中在 `handleRefundCallback` 一处，不在其他地方放任何「绕过 >= 检查」的代码，保持金额扣减的单点真相。

`postConsume` 的 delta 回退也有类似处理。实结金额比预扣金额小时 (delta > 0), 退回钱包用 `creditBalance`; 实结比预扣大时 (delta < 0), 先尝试乐观锁 `deductBalance`, 失败就走「强制扣穿」单 SQL. 后者的场景是「上游报的实际 token 数比 max_tokens 估算大很多」，极少发生但要兜住:

```ts
// src/billing/calculator.ts (节选, applyWalletDelta)
function applyWalletDelta(userId: number, delta: number): void {
  if (delta === 0) return;
  const wallet = getWalletByUserId(userId);
  if (!wallet) return;
  if (delta > 0) {
    creditBalance({ walletId: wallet.id, amountMicro: delta });
    return;
  }
  // delta < 0: 先尝试乐观锁 deduct, 失败就走「强制扣穿」单 SQL.
  const need = -delta;
  try {
    deductBalance({ walletId: wallet.id, amountMicro: need });
  } catch (err) {
    if (err instanceof InsufficientWalletBalanceError) {
      // 强制扣穿 (允许变负): UPDATE wallets SET balance = balance - need, 不带 >= 检查
      db.update(wallets)
        .set({ balanceMicro: sql`${wallets.balanceMicro} - ${need}`, updatedAt: now })
        .where(eq(wallets.id, wallet.id))
        .run();
    } else { throw err; }
  }
}
```

这是金融字段的标准模式。默认严格 (乐观锁 + `>= cost`), 例外显式 (扣穿场景列清楚). 全网关只有 3 处允许扣穿——退款回退、postConsume 实结大于预扣、admin 强制设余额。其他路径一律走 `deductBalance`.

乐观锁 vs 悲观锁这件事在金融模块经常被讨论。悲观锁 (`SELECT ... FOR UPDATE` 配合事务。也能解决并发，但有两个代价。一是 SELECT FOR UPDATE 在 SQLite 上不存在 (要靠 BEGIN IMMEDIATE 拿写锁), 跨数据库不通用。二是事务期间持有锁会阻塞其他并发请求，高并发下吞吐降一个数量级。乐观锁的语义是「不锁，出冲突时重试 (或返业务错)」，适合「写冲突低 + 单条更新」的场景，我们的余额扣减完全契合。

这里有一层存储引擎相关的细节: SQLite 的「全库写锁」特性，让本章实现的乐观锁实际上是「严格串行 + 单 SQL 原子」. 换到 Postgres / MySQL 这种行级锁的引擎，行为会略不同——并发的 UPDATE 会真正并行执行，但对同一行仍然串行。改换数据库时这层乐观锁不需要重写，这是 Drizzle ORM 的好处之一。

业内偶尔会看到「事件溯源 (event sourcing) + 物化视图」的方案——所有金额变动写一行不可变 event, balance 是 event 累加结果: 这种方案的优点是审计完美 (所有变动可追溯), 缺点是查询余额每次要累加 (或维护物化视图自动累加). 中转站的「读余额」频率远高于「改余额」(preConsume 每次请求都要先校验), 累加方案在性能上吃亏。我们选「单一可变字段 + 流水表佐证」的传统方案，流水表 (`recharges + refunds + usage_records`) 同样能完整审计，余额查询是 O(1).

## 11.8 主路径接入。把扣减从 users 改到 wallets

新表 + 新接口 + 新逻辑都到位了，最后一步是把主路径 `index.ts` 的 preConsume / postConsume / refundReservation 全部改读 wallet.balance.

之前 v0.10 的 preConsume:

```ts
// v0.10
const updated = db.update(users)
  .set({ balanceMicro: sql`${users.balanceMicro} - ${preReservedCost}` })
  .where(sql`${users.id} = ${input.userId} AND ${users.balanceMicro} >= ${preReservedCost}`)
  .returning({ balance: users.balanceMicro })
  .all();
if (updated.length === 0) throw new InsufficientBalanceError(...);
```

v0.11 改成调用 wallet/service:

```ts
// v0.11 (src/billing/calculator.ts)
const wallet = getWalletByUserId(input.userId);
if (!wallet) throw new WalletMissingError(input.userId);
try {
  deductBalance({ walletId: wallet.id, amountMicro: preReservedCost });
} catch (err) {
  if (err instanceof InsufficientWalletBalanceError) {
    throw new InsufficientBalanceError(err.required, err.available);
  }
  if (err instanceof WalletNotFoundError) throw new WalletMissingError(input.userId);
  throw err;
}
```

`InsufficientBalanceError` 这个老符号保留，主路径的 catch 不变，客户端看到的 402 响应也不变。兼容性这件事在金融字段尤其重要——上游应用可能在做错误码匹配，改类名等于强制所有人升级。

新增的 `WalletMissingError` 处理场景是「v0.10 之前建的 user 没 wallet」. 主路径 catch 后返 409 + 提示「跑 admin/wallets/seed」:

```ts
// src/index.ts (节选)
if (err instanceof WalletMissingError) {
  reqLogger.error({ user_id: err.userId, error_code: 'wallet_missing' }, 'wallet_missing_for_user');
  return c.json({
    error: {
      type: 'wallet_missing',
      message: 'wallet not initialized for this user. run admin/wallets/seed to create one.',
      user_id: err.userId,
    },
  }, 409);
}
```

新建 user 时自动 ensureWallet, 不需要手动跑:

```ts
// src/admin/routes.ts (节选, /admin/users 路由)
const rows = db.insert(users).values({...}).returning().all();
// v0.11: 同时建一个钱包, 把 balanceCny 注入.
const wallet = ensureWallet({ userId: rows[0]!.id, initialBalanceMicro: balanceMicro });
return c.json({ ...rows[0], walletId: wallet.id, walletBalanceMicro: wallet.balanceMicro }, 201);
```

老 user 用 `cli/seed-wallet.ts` 一次性补:

```bash
npx tsx src/cli/seed-wallet.ts --all
# 给所有 user 都建 wallet, 从 users.balance_micro 复制初始余额
```

`ensureWallet` 是幂等的 (用 `wallets.user_id UNIQUE` 索引 + INSERT 撞约束捕获), 已有 wallet 不会被覆盖。跑两次三次都安全。

主路径的 `refundReservation` 也改写:

```ts
// v0.11 (src/billing/calculator.ts)
export function refundReservation(recordId: number, errorMessage?: string): void {
  // ... 取 record ...
  // v0.11: 退回钱包余额 (走 creditBalance, 允许 wallet 已被并发扣到 0 也能 +)
  applyWalletDelta(row.userId, row.preReservedCost);
  db.update(usageRecords).set({ status: 'refunded', ... }).run();
}
```

postConsume 的多退少补走同一个 `applyWalletDelta`. 至此主路径的所有金额变动都收口到 wallet/service.ts 的三个函数:

- `deductBalance`: 严格扣减 (preConsume + postConsume 少扣);
- `creditBalance`: 退回 (postConsume 多扣 + refundReservation);
- `applyWalletDelta`: 上面两者的封装，处理「扣不动时强制扣穿」.

任何后续新功能 (例如积分系统、信用卡预授权), 只要走这三个函数就守住了金额一致性。

主路径接入还有一个细节值得说: TPM 限流 / 月度配额这些字段沿用 v0.6, 不动。它们与 wallet.balance 是两件互补的事——wallet.balance 控制「这个用户还能不能花钱」(财务), TPM / monthly_quota 控制「这个 Key 在单位时间内能用多少」(技术配额). 一个客户充了 ¥1000 但月度配额是 ¥100, 仍然只能用 ¥100. 反过来一个企业 Key 配额无上限但 wallet.balance = 0, 调一笔就 402. 两者都通过才能走到 preConsume 之后的实际请求。

先 wallet 校验后限流校验，还是反过来。主路径选「先限流校验后 wallet 扣减」 (rateLimitMiddleware 在 preConsume 之前). 理由是限流校验完全在内存，几微秒级; wallet 扣减要写 SQLite, 几十微秒级。一个被限流挡住的请求不应该走到更慢的 wallet 路径——这是性能层面的优化。顺序不能换。

## 11.9 端到端跑一遍

把所有件事拼起来，跑一次 `payment-flow-test`:

```bash
# terminal 1
npm run mock           # mock LLM 上游, :4010
# terminal 2
npm run mock-pay       # mock 支付平台, :5010
# terminal 3
npm run start          # 主网关, :3000

# terminal 4
npm run payment-flow-test
```

输出 (节选):

```
[..] === payment-flow-test start ===
[..] user created {"userId":1,"walletId":1,"initialBalance":0}
[..] recharge order created {"rechargeId":1,"outTradeNo":"USR1NOhn1u...","redirect":"http://localhost:5010/checkout?out_trade_no=..."}
[..] waiting 4s for async callback...
[..] wallet after recharge callback {"balanceCny":10}
[..] triggering duplicate callback...
[..] wallet after duplicate callback {"balanceCny":10}      # (new) 幂等
[..] calling chat completion...
[..] wallet after chat {"balanceMicro":9999995}              # (new) 从 wallet 扣
[..] initiating refund...
[..] waiting 3s for refund callback...
[..] wallet after refund {"balanceMicro":-5}                 # (new) 允许扣穿
[..] === payment-flow-test PASSED ===
```

七步验证全部通过:

1. 建 user 时自动建 wallet (initialBalance=0);
2. 创建充值订单 → 写 recharges (status=pending);
3. mock 平台 3 秒后异步回调 → 网关入账, balance = 10 元;
4. (new) 手动重复回调 → balance 不变 (幂等);
5. 调 chat completion → 从 wallet 扣 5 微元;
6. admin 发起退款 → 写 refunds (status=pending) + 调 mock.refund();
7. mock 平台 2 秒后异步回调 → wallet 扣穿到 -5 微元。

`wallet-concurrency-test` 验证乐观锁:

```
{"stage":"result","concurrent":50,"initial_budget_micro":105,"actual_200":10,"actual_402":40}
{"stage":"final_wallet","balance_micro":55}
{"stage":"pass","verdict":"wallet optimistic lock prevented overspend"}
```

50 并发只灌 105 微元 (3 笔预扣的余地), 10 笔成功, 40 笔被锁拒掉，最终余额 55 微元 (>= 0).

整个 v0.11 增量代码约 1300 行 (TS), 其中:

- `wallet/service.ts` ≈ 380 行 (核心逻辑);
- `payment/types.ts + mock.ts + registry.ts + reconciler.ts` ≈ 480 行 (PaymentAdaptor 抽象 + mock 实现 + 对账骨架);
- `admin/payment-routes.ts + admin/routes.ts 增量` ≈ 280 行 (回调接收 + 钱包/充值/退款 admin endpoint);
- `scripts/mock-payment-platform.ts + payment-flow-test.ts + wallet-concurrency-test.ts` ≈ 600 行 (mock 平台 + e2e 测试 + 并发测试);
- `drizzle/0007_payment.sql + db/schema.ts 增量` ≈ 130 行 (三张表 + 索引 + Drizzle 类型);

不接 SDK 但完整跑通链路，这是 v0.11 设计上的核心权衡——抽象层和工程难题在正文里讲透，平台特定的 SDK 升级 / 合规 / 地区差异留作附录，是「教材有教学价值，附录有实操价值」两件事的拆分。

## 11.10 v0.11 之后还差什么

v0.11 完成的能力清单:

- 三张表 (`wallets / recharges / refunds`) + 唯一索引 + 状态机;
- `PaymentAdaptor` 抽象 (4 方法) + 与 `ProviderAdaptor` 对称设计;
- mock 支付平台 (HMAC-SHA256 验签 + 异步回调 + 手动触发);
- 充值幂等 (DB UNIQUE + 状态机 + 重复回调测试通过);
- 退款链路 (admin 触发 → adapter.refund → 异步回调 → 余额回退，允许扣穿);
- 余额并发扣减 (单 SQL 乐观锁 + 50 并发压测无超扣);
- 主路径 preConsume / postConsume / refundReservation 全部接入 wallet;
- 自动 ensureWallet (admin/users 路由) + 老数据补单 CLI (cli/seed-wallet);
- 对账骨架 (reconciler.ts 用 queryStatus 二次确认) + 自动平账函数;

v0.11 之前每章产出一个独立 example, 11 份共用同一份 schema 吗。环境变量怎么管。同事现在想用，能否一条 `docker compose up` 起整套。流式 + 限流 + 计费 + 渠道切换 + 看板，端到端跑通需要什么? v1.0 的任务是把 11 座孤岛缝合成一个可部署的系统——单一 monorepo + 合并的 migration + Dockerfile + 健康检查 + e2e 压测 + 三种部署目标 (Node / Bun / Cloudflare Workers) 的对照，是「最小原型」承诺的兑现处。

## 配套代码

完整可运行的 v0.11 代码在 `examples/11-how-do-i-charge-users/`. 目录结构:

```
src/
  payment/                              # (new) 本章核心新增
    types.ts                            # PaymentAdaptor 接口 + 4 方法 + DTO
    mock.ts                             # MockPaymentAdaptor (HMAC-SHA256)
    registry.ts                         # 注册表
    reconciler.ts                       # T+1 对账骨架
  wallet/                               # (new) 本章核心新增
    service.ts                          # ensureWallet / deductBalance (乐观锁) /
                                        # creditBalance / handleRechargeCallback /
                                        # handleRefundCallback
  admin/
    routes.ts                           # (new) 加 /admin/wallets, /admin/recharges, /admin/refunds
    payment-routes.ts                   # (new) /payment/notify/:provider 收回调
  billing/
    calculator.ts                       # (new) preConsume/postConsume 改读 wallet.balance
  cli/
    seed-wallet.ts                      # (new) 给老 user 补建 wallet
  scripts/
    mock-payment-platform.ts            # (new) 本地 HTTP server 模拟支付平台
    payment-flow-test.ts                # (new) e2e 充值 → 回调 → 扣费 → 退款 → 扣穿
    wallet-concurrency-test.ts          # (new) 50 并发验证乐观锁不扣穿
  (其余沿用 v0.10)
drizzle/
  0007_payment.sql                      # (new) wallets / recharges / refunds 三张表 + 索引
```

启动:

```bash
cd examples/11-how-do-i-charge-users
cp .env.example .env  # 至少改 ADMIN_TOKEN

npm install
npm run migrate    # 0001..0007, 共 7 份
npm run mock       # terminal 1: mock LLM 上游, :4010
npm run mock-pay   # terminal 2: mock 支付平台, :5010
npm run start      # terminal 3: 主网关, :3000
```

跑 e2e:

```bash
npm run payment-flow-test
```

预期 7 步全部通过，最后输出 `=== payment-flow-test PASSED ===`.

跑乐观锁压测:

```bash
npm run wallet-concurrency-test
```

预期 `wallet optimistic lock prevented overspend`.

详细的 README + admin 接口 + 重复回调 / 用户取消 / 平台主动重发等手动验证步骤见 `examples/11-how-do-i-charge-users/README.md`.

## 下一章预告

v0.11 把变现链路补齐了——钱怎么进来 (充值 + 异步回调 + 幂等), 钱怎么扣 (wallet 乐观锁 + 强制扣穿例外), 钱怎么退 (refund 异步链路 + 对账骨架). PaymentAdaptor 抽象与 Ch2 的 ProviderAdaptor 形成对称设计，真实接入 Stripe / 支付宝 / 微信支付时新加 adapter 即可，不动其他代码。

但到目前为止, 11 章每一章产出的是一个独立的 example——`examples/01/`、`examples/02/` 一直到 `examples/11/`, 每份都能独立 `npm install + npm run start`, 各有自己的 schema、各有自己的环境变量、各有自己的 mock 上游: 这种结构对教学很好 (每章互不污染), 对落地很糟 (一条 `docker compose up` 跑不起整套).

第 12 章把 11 座孤岛缝合成一个可部署的系统。单一 monorepo + 合并的 migration + 统一的环境变量 + Dockerfile + healthz + e2e 压测脚本 + 三种部署目标 (Node / Bun / Cloudflare Workers) 的对比. v0.11 到此把变现链路三件事补齐。钱怎么进 (充值幂等) / 钱怎么扣 (并发安全的余额扣减) / 钱怎么退 (退款对账 + 允许扣穿). v1.0 的任务是让这条链路在生产环境一条命令起得来。

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)
