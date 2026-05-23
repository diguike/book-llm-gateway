# 第 11 章 v0.11 配套代码

v0.10 把对外卖 token 的成本护城河立住了, 但还差一道关卡: 用户怎么把钱打进网关账户. 第 11 章新增 wallets / recharges / refunds 三张表, 抽象出 `PaymentAdaptor` 接口 (与 Ch2 的 `ProviderAdaptor` 形成对称设计), 并把「充值幂等」「退款对账」「余额并发扣减」三道核心难题一次跑通. 不接任何真实支付 SDK, 用一个本地 HTTP server 模拟支付平台异步回调.

## 目录结构

```
src/
  payment/                              # ★ 本章核心新增
    types.ts                            # PaymentAdaptor 接口 + 4 方法 + Verified/Refund/Status DTO
    mock.ts                             # MockPaymentAdaptor 实现 (HMAC-SHA256 验签)
    registry.ts                         # 注册表, 启动时挂 mock
    reconciler.ts                       # T+1 对账脚本骨架 (queryStatus diff)
  wallet/                               # ★ 本章核心新增
    service.ts                          # ensureWallet / deductBalance (乐观锁) /
                                        # creditBalance / handleRechargeCallback /
                                        # handleRefundCallback (三道核心难题落地)
  admin/
    routes.ts                           # ★ 加 /admin/wallets, /admin/recharges, /admin/refunds
    payment-routes.ts                   # ★ /payment/notify/:provider 接收平台异步回调
  billing/
    calculator.ts                       # ★ preConsume/postConsume 改读 wallet.balance, 不再读 user.balance
  cli/
    seed-wallet.ts                      # ★ 给已有 user 补建 wallet (兼容 v0.10 老数据)
  scripts/
    mock-payment-platform.ts            # ★ 本地 HTTP server 模拟支付平台 (端口 5010, 异步 3s 回调)
    payment-flow-test.ts                # ★ e2e: 充值 → 异步回调 → 余额到账 → 调网关扣费 → 退款 → 余额恢复
    wallet-concurrency-test.ts          # ★ 验证 wallet 乐观锁: N 笔并发只允许 K 笔成功
  (其余沿用 v0.10)
drizzle/
  0007_payment.sql                      # ★ 本章新增: wallets / recharges / refunds 三张表 + 唯一索引
```

## 依赖

- Node.js 20+
- npm

## 启动 + 迁移

```bash
cd examples/11-how-do-i-charge-users
cp .env.example .env   # 至少改 ADMIN_TOKEN

npm install
npm run migrate        # 0001/0002/0003/0004/0005/0006/0007, 共 7 份

# 三个独立进程一起跑
npm run mock           # terminal 1: mock LLM 上游, 监听 :4010
npm run mock-pay       # terminal 2: mock 支付平台, 监听 :5010
npm run start          # terminal 3: 主网关, 监听 :3000
```

启动日志会打印 `payment_adaptors_bootstrapped`, 表示 mock PaymentAdaptor 注册成功.

## 端到端跑一遍

```bash
npm run payment-flow-test
```

预期输出 (依次):

```
[..] === payment-flow-test start ===
[..] user created {"userId":N,"walletId":N,"initialBalance":0}
[..] key issued ...
[..] recharge order created ...
[..] waiting 4s for async callback...
[..] wallet after recharge callback {"balanceCny":10}
[..] triggering duplicate callback...
[..] mock pay duplicate notify resp {"status":200}
[..] wallet after duplicate callback {"balanceCny":10}      # ★ 幂等: 余额未变
[..] calling chat completion...
[..] chat resp status {"status":200}
[..] wallet after chat {"balanceMicro":<10000000-X>,...}
[..] chat consumed {"microCny":X}
[..] initiating refund...
[..] refund accepted ...
[..] waiting 3s for refund callback...
[..] wallet after refund {"balanceMicro":<-X>,...}          # ★ 允许扣穿 (用户已花掉部分)
[..] === payment-flow-test PASSED ===
```

## 重复回调测试 (单独跑)

mock 平台支持手动触发回调. 创建一笔订单 + 等回调入账后, 再触发一次回调:

```bash
ADMIN_TOKEN=admin-change-me
BASE=http://localhost:3000

# 1. 创充值订单
RESP=$(curl -sS -X POST $BASE/admin/recharges -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"provider":"mock","amountCny":5}')
OUT_TRADE_NO=$(echo $RESP | python3 -c 'import json,sys;print(json.load(sys.stdin)["recharge"]["outTradeNo"])')

# 2. 等 3 秒, mock 自动回调
sleep 4
curl -sS $BASE/admin/wallets/1 -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. 手动再回调一次
curl -sS -X POST http://localhost:5010/api/orders/$OUT_TRADE_NO/pay
sleep 1
curl -sS $BASE/admin/wallets/1 -H "Authorization: Bearer $ADMIN_TOKEN"
# ★ 余额仍是同一个数, 没二次入账
```

主网关日志会输出 `recharge_callback_processed notice="already succeeded, idempotent ok"`.

## 并发扣费测试 (单独跑)

```bash
npm run wallet-concurrency-test
```

测试逻辑:

1. 建一个 user, 余额精确灌成「足够 10 笔预扣」(SHOULD_SUCCEED × 80 微元);
2. 并发 20 笔 chat 请求;
3. 期望: 10 笔成功 200, 10 笔失败 402, 余额最终 ≥ 0 不扣穿.

预期输出片段:

```
{"stage":"setup",...}
{"stage":"result","concurrent":20,"target_success":10,"actual_200":10,"actual_402":10,"other":[]}
{"stage":"final_wallet","balance_micro":N}
{"stage":"pass","verdict":"wallet optimistic lock prevented overspend"}
```

如果看到 `actual_200 > 10` 或 `balance_micro < 0`, 说明乐观锁被击穿, 是 bug.

## 模拟「支付失败」/「用户取消」

```bash
RESP=$(curl -sS -X POST $BASE/admin/recharges -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"provider":"mock","amountCny":10}')
OUT_TRADE_NO=$(echo $RESP | python3 -c 'import json,sys;print(json.load(sys.stdin)["recharge"]["outTradeNo"])')

# 立即触发取消 (在 3s 自动回调之前)
curl -sS -X POST http://localhost:5010/api/orders/$OUT_TRADE_NO/cancel

sleep 4
curl -sS "$BASE/admin/recharges?userId=1" -H "Authorization: Bearer $ADMIN_TOKEN"
```

预期 status=failed, wallet 余额不变.

## 模拟「平台主动重发回调」

把 `MOCK_PAY_RETRY_MS=2000` 重新启动 mock-pay, 每个回调都会在 2s 后再发一次. 不需要任何额外操作就能验证幂等.

## 相对 v0.10 的核心变化

| 维度 | v0.10 | v0.11 |
|------|------|------|
| 余额数据源 | `users.balance_micro` | `wallets.balance_micro` (1:1 关系) |
| 钱进入路径 | admin 手动调 `users/balance` 改数 | `recharges` 表 + `PaymentAdaptor.createOrder` + 异步回调 |
| 退款 | 无 | `refunds` 表 + `PaymentAdaptor.refund` + 异步回调 |
| 充值幂等 | n/a | `recharges.out_trade_no` UNIQUE + 状态机 (pending → succeeded / failed) |
| 退款幂等 | n/a | `refunds.refund_no` UNIQUE + 状态机 (pending → succeeded / failed) |
| 抽象层 | `ProviderAdaptor` (Ch2) | `ProviderAdaptor` + `PaymentAdaptor` (4 方法对称设计) |
| 对账 | n/a | `payment/reconciler.ts` 骨架 (T+1 queryStatus diff) |

## 仍然故意保留的缺陷 (留给后续章节)

- **不接真实支付 SDK**: Stripe / 支付宝 / 微信支付的具体接入点、SDK 升级、地区差异、合规, 全部留作附录 A. 正文 mock 只演示抽象层和幂等流程.
- **退款只支持整笔退**: 真实业务有「部分退」「按比例退」, 教学版简化为整笔.
- **`users.balance_micro` 字段保留**: 老数据兼容. v1.0 整合时彻底废弃.
- **对账文件下载未实现**: `reconciler.ts` 用 queryStatus 做「按订单逐条二次确认」, 真实生产是「下载平台对账 CSV → 全量 diff → 异常订单再二次确认」.
- **拼车号池 / 退款套利 / 偷偷降级模型**: 见 Ch10 (灰色玩法仅揭原理, 网关不实现).

## 引用

- new-api `controller/topup.go` 充值流水设计 (`TradeNo / Status / PaymentProvider`): <https://github.com/Calcium-Ion/new-api/blob/main/controller/topup.go>
- one-api `model/log.go` 充值日志 (`RecordTopupLog` / `LogTypeTopup`): <https://github.com/songquanpeng/one-api/blob/main/model/log.go>
- Stripe Idempotency-Key (HTTP header 形式): <https://stripe.com/docs/api/idempotent_requests>
- 支付宝异步通知 (out_trade_no + RSA2 sign): <https://opendocs.alipay.com/open/270/105902>
- 微信支付 V3 异步通知 (Wechatpay-Signature header + AEAD-AES-256-GCM): <https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_0.shtml>
