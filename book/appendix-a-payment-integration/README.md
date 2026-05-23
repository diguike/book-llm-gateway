---
title: 附录 A 支付接入点设计
feishu_url: "https://www.feishu.cn/wiki/RMN1wuvWMiQzI2kFHWvcbPfWnVh"
last_synced: "2026-05-16T18:29:32"
---

## 为什么这是附录而不是正文章节

正文 Ch11 给出了 `PaymentAdaptor` 抽象 (4 个方法: `createOrder` / `verifyCallback` / `refund` / `queryStatus`, 接口定义见 `examples/11-how-do-i-charge-users/src/payment/types.ts`) 与 mock 实现, 把支付平台对接的「教学价值」部分写完了——抽象层的对称设计、充值幂等的 DB UNIQUE + 状态机、退款对账的 T+1 reconciler、余额并发扣减的乐观锁. 这些是工程师必须理解的纪律, 与具体平台无关.

但 Stripe / 支付宝 / 微信支付的 SDK 调用细节不适合放正文. 三个原因:

- **SDK 升级频繁**. Stripe Node SDK 从 v8 到 v17 大版本号涨了 9 次, 每次都有 breaking change; 微信支付 V3 还在持续推新接口 (退款 API 在 2024 年从 v2 全量切到 v3); 支付宝 SDK 在 2023 年发布 v4 重写了签名链路. 正文写死任何一家的代码, 半年内就会过时.
- **合规与地区差异**. 微信支付 / 支付宝必须申请国内商户号, 涉及营业执照 / 行业资质 / 结算账户等线下流程; Stripe 在中国大陆没有展业资质, 接入需要海外公司主体. 同一本书面向不同地区的读者, 接入路径完全不同.
- **凭证管理与密钥轮换**. 三家的密钥位置、轮换周期、灾备策略各不相同, 每家都值得一篇专门的运维文档. 正文塞不下.

附录 A 的定位是「速查清单」: 假设读者已经拿到商户号 / API Key, 想最快把 `PaymentAdaptor` 实现一个 stripe / alipay / wechat 子类, 这里给出最小必读项. 真正写代码时仍要回到官方文档, 但读完附录 A 应该知道**该读哪几页**.

每一节的「PaymentAdaptor 实现骨架」都是伪代码, 不是可运行版本. 真实接入时按 SDK 当前 API 替换, 行数会翻一倍但骨架结构不变.

## Stripe 接入要点

Stripe 是三家中文档质量最高、SDK 最稳定的, 但只面向海外业务. 适合做出海中转站或 SaaS 内部计费.

- **createOrder**: 二选一
  - `stripe.checkout.sessions.create` — 跳转 Stripe 托管收银台, 集成成本最低, 适合「不想自己写支付 UI」的场景
  - `stripe.paymentIntents.create` — 拿 `client_secret` 回前端, 用 Stripe.js 自渲染表单, 适合需要嵌入式 UI 或自定义流程的场景
  - 中转站充值通常用前者 (省事且用户在 Stripe 域内输入卡号, PCI 合规风险最低)
- **回调验签**: HTTP header `Stripe-Signature` + raw request body, 用 `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` 一行验签 + 反序列化. **必须用 raw body**, 经过 JSON parse + stringify 后字节会变, 验签必失败
- **幂等键位置**: HTTP header `Idempotency-Key: <uuid>`. 平台侧保留 24 小时去重, 同 key 重复请求返回首次结果. 把网关侧的 `outTradeNo` 直接当 idempotency key 即可
- **退款**: `stripe.refunds.create({ payment_intent: 'pi_xxx', amount, reason }, { idempotencyKey: refundNo })`. 同步返回 `refund.status`, 之后还会异步发 `charge.refunded` / `refund.updated` webhook
- **对账**: Reports API (`stripe.reporting.reportRuns.create`) 异步生成 CSV / JSON, 通过另一个 endpoint 下载. 替代方案是订阅完整的 webhook event log + 自建本地索引
- **必装 SDK**: `stripe@^17` (npm `stripe`)
- **必拿凭证**: Secret Key (`sk_live_...` / `sk_test_...`) + Webhook Signing Secret (`whsec_...`) + Publishable Key (前端用)
- **官方文档**: <https://docs.stripe.com/api>, webhook 验签 <https://docs.stripe.com/webhooks#verify-events>, idempotency <https://docs.stripe.com/api/idempotent_requests>

Stripe 的 webhook 重试策略值得专门记一下: 网关侧返非 2xx 后, Stripe 按指数回退重试, 最长持续 3 天, 总共 16-17 次. 这个时间窗远长于支付宝 / 微信 (后者最多 24 小时), 所以 Stripe 的幂等保护必须做扎实, 重复回调撞 UNIQUE 索引后走「已 succeeded 直接返 200」分支. 单条订单一周内被重发 10+ 次是常态, 不是异常.

PaymentAdaptor 实现骨架:

```ts
import Stripe from 'stripe';
import type { PaymentAdaptor, CreateOrderInput, ... } from './types.js';

export class StripeAdaptor implements PaymentAdaptor {
  readonly name = 'stripe';
  constructor(private stripe: Stripe, private webhookSecret: string) {}

  async createOrder(input: CreateOrderInput) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{ price_data: { /* 真实场景填: currency: 'usd' / product_data: { name } / unit_amount (分) */ }, quantity: 1 }],
        client_reference_id: input.outTradeNo,
        metadata: { user_id: String(input.userId), out_trade_no: input.outTradeNo },
        success_url: `${BASE}/payment/return?ok=1`,
        cancel_url: `${BASE}/payment/return?ok=0`,
      },
      { idempotencyKey: input.outTradeNo },
    );
    return { outTradeNo: input.outTradeNo, credential: { kind: 'redirect_url', url: session.url! } };
  }

  async verifyCallback(rawBody: string, headers: Record<string, string>) {
    const sig = headers['stripe-signature'];
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, sig, this.webhookSecret);
    } catch (err) {
      throw new CallbackVerificationError('stripe sig invalid', String(err));
    }
    // checkout.session.completed / payment_intent.succeeded / charge.refunded ...
    // 翻译成 VerifiedCallback { outTradeNo, status, amountMicro, rawPayload }
  }

  async refund(input: RefundInput) { /* stripe.refunds.create + idempotencyKey */ }
  async queryStatus(outTradeNo: string) { /* stripe.checkout.sessions.list({ client_reference_id }) */ }
}
```

## 支付宝（电脑网站支付 / 当面付）接入要点

支付宝面向中国大陆 / 港澳台用户, 需要营业执照 + 国内对公账户. 中转站充值常用「电脑网站支付」(PC 跳转) + 「当面付」(扫码) 两种.

- **createOrder**:
  - `alipay.trade.page.pay` — 电脑网站支付, 返回拼好签名的 form HTML 让浏览器自动 POST 到收银台
  - `alipay.trade.precreate` — 当面付, 返回二维码 URL, 用户扫码付款
  - 同一笔订单不能在两种方式间互转, 选定后用对应接口
- **异步通知**: 支付宝 POST `application/x-www-form-urlencoded` 到商户配置的 `notify_url`. 验签用 SDK 的 `alipaySdk.checkNotifySign(params)` (内部走 RSA2 + 支付宝公钥), 通过后从 `params.trade_status` 判断成功 (`TRADE_SUCCESS` / `TRADE_FINISHED`)
- **幂等键位置**: 业务字段 `out_trade_no` (商户订单号). 同 out_trade_no 不能被重复创建; 同时也是回调里的查询键, 网关侧据此 lookup `recharges` 行
- **退款**: `alipay.trade.refund` + `out_request_no` (退款流水号, 必须全局唯一). 部分场景同步返回退款结果 (余额支付直接退原账户), 部分场景异步通知 (信用卡退款受银行处理时长影响)
- **对账**: `alipay.data.dataservice.bill.downloadurl.query` 拿到对账单下载 URL, T+1 出当天账单 (CSV, gzip 压缩), 字段含交易号 / 商户单号 / 金额 / 类型
- **SDK**: `alipay-sdk@^4` (npm `alipay-sdk`, 蚂蚁官方维护)
- **必拿凭证**: APPID + 应用私钥 (商户生成, 自己保管) + **支付宝公钥**(平台为「当前 APPID」分发的公钥, 用于验签). 注意区分: 不是「支付宝平台总公钥」, 而是 APPID 维度的应用对应公钥, 错填会导致全部验签失败
- **官方文档**: <https://opendocs.alipay.com/open/270/105898> (异步通知), <https://opendocs.alipay.com/open/02ekfg> (对账下载), <https://opendocs.alipay.com/common/02kf5q> (RSA2 签名)

支付宝异步通知有两个细节容易踩: 一是通知重发条件包含「网关 8 秒内没返回 `success`」, 注意必须是字符串 `success` 不是 `ok` 也不是 200 状态码; 二是同一笔订单可能在 `WAIT_BUYER_PAY → TRADE_CLOSED` (用户超时未付) 与 `WAIT_BUYER_PAY → TRADE_SUCCESS` 两个分支上各发一次通知, 状态机要把 `TRADE_CLOSED` 也作为终态处理, 否则 pending 订单会一直挂着.

PaymentAdaptor 实现骨架:

```ts
import { AlipaySdk } from 'alipay-sdk';
import type { PaymentAdaptor, CreateOrderInput, ... } from './types.js';

export class AlipayAdaptor implements PaymentAdaptor {
  readonly name = 'alipay';
  constructor(private sdk: AlipaySdk) {}

  async createOrder(input: CreateOrderInput) {
    // 当面付场景
    const res = await this.sdk.exec('alipay.trade.precreate', {
      bizContent: {
        out_trade_no: input.outTradeNo,
        total_amount: (input.amountMicro / 1_000_000).toFixed(2),
        subject: input.subject,
      },
    });
    if (res.code !== '10000') throw new Error(`alipay precreate failed: ${res.subMsg}`);
    return { outTradeNo: input.outTradeNo, credential: { kind: 'qr_code', qrCodeUrl: res.qrCode } };
  }

  async verifyCallback(payload: string, headers: Record<string, string>) {
    const params = Object.fromEntries(new URLSearchParams(payload));
    const ok = await this.sdk.checkNotifySign(params);
    if (!ok) throw new CallbackVerificationError('alipay sign invalid', 'sign_check_false');
    const status = params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED'
      ? 'succeeded' : 'failed';
    return {
      outTradeNo: params.out_trade_no,
      status,
      amountMicro: Math.round(parseFloat(params.total_amount) * 1_000_000),
      rawPayload: payload,
    };
  }

  async refund(input: RefundInput) { /* alipay.trade.refund + out_request_no */ }
  async queryStatus(outTradeNo: string) { /* alipay.trade.query */ }
}
```

## 微信支付（V3 API）接入要点

微信支付面向中国大陆用户, 需要营业执照 + 微信支付商户号. V3 API (2020 年发布) 是当前主推版本, V2 仍可用但不再迭代新能力, 新接入直接用 V3.

- **createOrder**: 按支付场景四选一
  - JSAPI — 微信内 H5 / 公众号场景, 客户端用 `wx.chooseWXPay` 唤起
  - Native — 扫码付款, 服务端拿 code_url 渲染二维码 (中转站充值最常用)
  - H5 — 微信外移动浏览器场景, 跳转后回调到指定 URL
  - APP — 原生 APP 集成
- **回调验签**: HTTP header `Wechatpay-Signature` (HMAC-SHA256 ofecdsa) + `Wechatpay-Serial` (平台证书序列号) + `Wechatpay-Timestamp` + `Wechatpay-Nonce`. 验签后 body 里的 `resource.ciphertext` 还要用 APIv3 密钥做 AEAD-AES-256-GCM 解密才能拿到明文 payload
- **幂等键位置**: 业务字段 `out_trade_no` (商户订单号). 同 out_trade_no 重复下单返回原订单
- **退款**: `POST /v3/refund/domestic/refunds`, body 用 `transaction_id` 或 `out_trade_no` 定位原订单 + `out_refund_no` (退款单号). 同步返回受理状态, 退款到账后异步推送回调 (回调结构与支付回调同构, `event_type` 区分 `REFUND.SUCCESS` / `REFUND.ABNORMAL` / `REFUND.CLOSED`)
- **对账**: `GET /v3/bill/tradebill` (交易账单) + `GET /v3/bill/fundflowbill` (资金账单), 返回下载链接, 文件 GZIP 压缩 CSV. T+1 出账, 与 Stripe / 支付宝节奏一致
- **SDK**: 推荐 `wechatpay-axios-plugin` (社区, 维护活跃, axios 拦截器风格自动验签解密) 或 `wechatpay-node-v3` (社区, 更轻量). 微信官方仅提供 Java / PHP / Go SDK, Node.js 生态依赖社区
- **必拿凭证**: APPID + 商户号 (mchid) + **商户私钥** (apiclient_key.pem, 商户后台下载) + **平台证书** (从平台证书 API 拉取并定期轮换) + APIv3 密钥 (商户后台手动设置的 32 字节字符串, 用于回调解密)
- **官方文档**: <https://pay.weixin.qq.com/docs/merchant/development/interface-rules/signature-verification.html> (验签), <https://pay.weixin.qq.com/docs/merchant/apis/native-payment/direct-jsons/native-prepay.html> (Native 下单), <https://pay.weixin.qq.com/docs/merchant/apis/refund/refunds/create.html> (退款)

微信支付 V3 与 V2 最大的差异是「证书机制」. V2 用商户密钥 MD5 签名, 简单但安全性弱; V3 用 RSA / ECDSA 非对称签名 + 平台证书校验. 平台证书需要主动拉取并定期轮换 (上面「常见坑」会展开). 另外, V3 的金额单位是分 (整数), V2 是分但部分接口是元, 切版本时这一项最容易算错.

PaymentAdaptor 实现骨架:

```ts
import WechatpayAxiosPlugin from 'wechatpay-axios-plugin';
import type { PaymentAdaptor, CreateOrderInput, ... } from './types.js';

export class WechatPayAdaptor implements PaymentAdaptor {
  readonly name = 'wechat';
  // wxpay 由 plugin 注入了商户私钥 + 平台证书 + APIv3 密钥, 自动验签解密
  constructor(private wxpay: any, private appid: string, private mchid: string) {}

  async createOrder(input: CreateOrderInput) {
    const resp = await this.wxpay.v3.pay.transactions.native.post({
      appid: this.appid,
      mchid: this.mchid,
      description: input.subject,
      out_trade_no: input.outTradeNo,
      notify_url: `${BASE}/payment/notify/wechat`,
      amount: { total: Math.round(input.amountMicro / 10_000), currency: 'CNY' }, // 单位为分 (1 元 = 1_000_000 微元 = 100 分 → amountMicro / 10_000 = 分)
    });
    return { outTradeNo: input.outTradeNo, credential: { kind: 'qr_code', qrCodeUrl: resp.data.code_url } };
  }

  async verifyCallback(rawBody: string, headers: Record<string, string>) {
    // plugin 在 axios 拦截器层已经验签, 但回调路径不走 axios, 需要手动调验签 + 解密
    const verified = await this.wxpay.verifier.verify(headers, rawBody);
    if (!verified) throw new CallbackVerificationError('wechat sig invalid', 'verify_false');
    const decrypted = JSON.parse(this.wxpay.decipher(JSON.parse(rawBody).resource));
    return {
      outTradeNo: decrypted.out_trade_no,
      status: decrypted.trade_state === 'SUCCESS' ? 'succeeded' : 'failed',
      amountMicro: decrypted.amount.total * 10_000,
      rawPayload: rawBody,
    };
  }

  async refund(input: RefundInput) { /* POST /v3/refund/domestic/refunds */ }
  async queryStatus(outTradeNo: string) { /* GET /v3/pay/transactions/out-trade-no/{...} */ }
}
```

## 三家差异速查表

| 维度 | Stripe | 支付宝 | 微信支付 V3 |
|------|--------|--------|------------|
| 同步回调 vs 异步通知 | 异步 webhook (+ 同步 redirect 到 success_url) | 异步通知 (HTTP POST 表单) | 异步通知 (HTTP POST JSON) |
| 幂等键位置 | HTTP header `Idempotency-Key` | 业务字段 `out_trade_no` | 业务字段 `out_trade_no` |
| 验签机制 | HMAC-SHA256 (header `Stripe-Signature`) | RSA2 + 支付宝公钥 | ECDSA + 平台证书 → AEAD-AES-256-GCM 解密 body |
| 验签材料位置 | header + raw body | payload 中的 `sign` 字段 | header (signature/serial/timestamp/nonce) + raw body |
| 退款异步性 | 同步返回 status + 异步 webhook 二次确认 | 部分同步 (余额支付) + 部分异步 (信用卡) | 同步受理 + 异步通知 |
| 对账文件 | Reports API (异步生成 CSV / JSON) | 对账单下载接口 (T+1, gzip CSV) | 交易账单 + 资金账单 API (T+1, gzip CSV) |
| 沙箱环境 | 测试 Key (`sk_test_...`), 完整功能, 真实卡号用测试卡 | 沙箱网关 (sandbox 域名) + 沙箱 APPID | 仿真测试环境 (需提交申请, 限制较多) |
| SDK 维护方 | 官方 (`stripe@^17`) | 蚂蚁官方 (`alipay-sdk@^4`) | 微信仅提供 Java/PHP/Go, Node.js 用社区 SDK |
| 商户准入 | 海外公司主体 | 中国大陆营业执照 + 国内对公账户 | 中国大陆营业执照 + 微信支付商户号 |

## 接入清单（按这个顺序做不会漏）

1. **注册商户 / 账号 → 拿凭证**. Stripe 直接注册即可拿测试 key; 支付宝 / 微信支付要走线下资质审核, 通常 3-7 个工作日.
2. **在网关 admin 后台填凭证**. 推荐环境变量注入 (`STRIPE_SECRET_KEY` / `ALIPAY_PRIVATE_KEY` / `WECHATPAY_API_V3_KEY`), 敏感字段不要落库. 长期方案上 KMS / Secrets Manager.
3. **实现 PaymentAdaptor → 套到 Ch11 的 registry**. `registry.ts` 里 `register('stripe', new StripeAdaptor(...))`, 业务代码按 name 取, 不动其他模块. 单元测试覆盖 4 个方法的 happy path + 验签失败分支.
4. **配回调 URL** (`notify_url`). 必须公网可达 + HTTPS (自签证书不行, 平台不接受). 开发期用 ngrok / cloudflared tunnel 把本地 3000 端口打通; 上线后域名固定.
5. **跑沙箱环境跑通完整流程**. 顺序: createOrder → 模拟用户支付 → 等回调 → 验证 wallet 入账 → 触发重复回调 → 验证幂等 → 触发退款 → 等退款回调 → 验证 wallet 扣穿. 这 7 步全部通过才算接入完成.
6. **切生产 → 监控对账差异**. 跑 reconciler 至少一周, 观察 `pendingButPlatformSucceeded` / `statusMismatch` 两类 diff 数量. 数量稳定为 0 才算接入稳定. 生产首周建议把 reconciler 频率压到 5 分钟一次, 稳定后改 T+1.

## 常见坑

- **Stripe webhook 必须用 raw body 验签**. Hono / Express 默认对 `application/json` 自动 parse, parse 后再 stringify 字节顺序会变, 验签必失败. 在 webhook 路由前用 `bodyParser.raw({ type: 'application/json' })` 或 Hono 的 `c.req.raw.text()` 拿原文; Stripe 官方 Node SDK 有提示但容易踩.
- **支付宝公钥与平台公钥的混淆**. 支付宝有两个公钥概念: 「平台公钥」(全局, 文档里出现但实际不用) vs 「应用对应的支付宝公钥」(每个 APPID 一份, 商户后台「开放平台 → 应用 → 开发设置」里查). 验签用后者, 用前者会全部失败. 切换 APPID 时也要重新拉公钥.
- **微信支付平台证书自动续期**. 微信平台证书每 12 个月轮换, 商户侧需要在过期前主动拉新证书. 推荐用 `wechatpay-axios-plugin` 的自动证书管理 (启动时拉一次, 每 12 小时检查一次), 或自己写定时任务调 `GET /v3/certificates`. 不做轮换会在某天突然全部回调验签失败.
- **退款时机与冻结金额**. 用户发起退款请求 (admin 触发 adapter.refund) 到余额真正回退到 wallet (handleRefundCallback) 之间通常有几秒到几分钟的时差. 这段时间 wallet 余额还是充值后的状态, 用户可以继续消费. 严格场景需要在 refund 受理时立即把对应金额从 `balance_micro` 移到 `frozen_micro`, 等回调到达再从 `frozen_micro` 真扣; Ch11 教学版选了简化方案 (允许扣穿), 真实运营按客户群体选.
- **沙箱与生产的 callback URL 隔离**. Stripe 测试 key 和生产 key 共用同一个 webhook endpoint 时, 测试环境的支付事件会推到生产 webhook, 触发误入账. 拆成两个 endpoint, 网关侧根据 path 区分.
- **金额单位换算**. 三家全部不一样: Stripe 用最小货币单位 (USD 是分, JPY 是元), 支付宝用元 (字符串保留 2 位小数), 微信支付用分 (整数). PaymentAdaptor 内部统一换算成微元 (1 元 = 1_000_000 微元), 与 Ch11 wallet 的 `balance_micro` 对齐, 业务层不感知.
- **对账时间窗的边界**. 平台对账单的 cut-off 时刻可能是 23:59:59 也可能是 00:00:00, 跨天订单会落到不同窗口. reconciler 每次拉两天 (前一天 + 当天) 数据, 用 outTradeNo 做去重, 不在某一段窗口里的订单不处理 (Ch11 11.6 节有详述).
- **测试卡号 vs 真实卡号**. Stripe 沙箱必须用平台分发的测试卡号 (例如 `4242 4242 4242 4242`), 用真实卡号会拒付; 支付宝沙箱有专属买家账号体系, 与生产隔离; 微信支付仿真测试需要预先配置测试用户的 openid. 三家都不允许「拿真实账号在沙箱里跑一遍」, 测试数据必须用平台分发的.
- **退款金额不能超过原订单**. 三家都强制校验「累计退款金额 ≤ 原订单金额」. 部分退场景下 (用户分多次退) 需要在网关侧维护 `refunds.amount_micro` 的累加, 避免发起一笔会被平台拒的退款. Ch11 教学版只支持整笔退, 部分退留作扩展.
- **回调路由不要走鉴权 middleware**. 平台回调没有网关侧的 API Key, 强制走 Bearer Token 鉴权会导致全部回调返 401. 把 `/payment/notify/:provider` 路由独立挂在 auth middleware 之外, 验签代替鉴权 (验签通过 = 来源可信).

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
