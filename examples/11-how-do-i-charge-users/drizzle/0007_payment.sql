-- Drizzle Migration 0007: v0.11 钱包 + 支付
--
-- 三张新表:
--
--   1. wallets (id, user_id, balance_micro, frozen_micro, ...)
--      用户钱包. 一个 user 一个 wallet, 1:1.
--      balance_micro = 当前可用余额 (微元); frozen_micro = 已冻结但未提现 (本章不实现冻结业务,
--      字段为后续「提现 / 退款待回退」预留).
--
--      为什么独立成表而不是继续用 users.balance_micro:
--        - users 是身份维度的领域对象 (org / email / 倍率), 钱包是金融维度.
--          一旦支持「同一 user 多钱包」(例如分企业子账号、跨币种) 必须拆开;
--        - wallets 表的所有写入都要走「乐观锁单条 UPDATE」, 与 users 表的其它字段写入分开,
--          减少长锁;
--        - 金融字段独立成表后, 可以单独做读权限隔离 (财务可读 wallet, 客服只能读 user).
--
--      乐观锁扣减语义: UPDATE wallets SET balance_micro = balance_micro - ?
--        WHERE id = ? AND balance_micro >= ?
--      并发写入时, SQLite 把 UPDATE 当原子语句执行, returning() 返回 0 行 = 余额不足或被
--      并发请求先扣到了, 直接转为业务错误返给客户端 (402).
--
--   2. recharges (id, wallet_id, out_trade_no UNIQUE, provider, amount_micro, status, ...)
--      充值流水. 一笔订单一行.
--
--      out_trade_no 是网关侧生成的「商户订单号」, 在所有支付平台间统一. 这个字段是「充值幂等」的
--      锚点 -- 加 UNIQUE 索引, 重复回调 INSERT 会因为唯一约束失败, 状态机判断后直接返回 success.
--
--      字段对照支付平台 (本章只实现 mock, 真实接入参考附录 A):
--        - Stripe:  payment_intent_id 对应 out_trade_no (我们让 Stripe 用我们的 idempotency key)
--        - 支付宝:  out_trade_no 由商户生成, 必须 < 64 位 + 全平台唯一
--        - 微信支付: out_trade_no 同支付宝, 但要求 6-32 位 + 数字字母组合
--      为兼容三家, 这里设 64 位上限.
--
--      raw_payload 是支付平台的回调原文 (JSON 字符串), 留作审计 + 对账用.
--
--      状态机:
--        pending     -- createOrder 后写入, 等待异步回调
--        succeeded   -- 收到验签通过的成功回调, 已执行入账 (wallet.balance_micro += amount_micro)
--        failed      -- 收到验签通过的失败回调 (用户取消 / 支付失败 / 超时)
--        refunded    -- 已被退款 (refunds 表里有对应 refund_no, status=succeeded)
--
--      pending -> succeeded / failed 是「外部触发 + 必须幂等」;
--      succeeded -> refunded 是「内部触发 + 必须乐观锁」(防止退款时余额已被消费扣穿).
--
--   3. refunds (id, recharge_id, refund_no UNIQUE, amount_micro, reason, status, ...)
--      退款流水. 一次退款一行. 多次部分退款时多行 (本章 v0.11 教学版只支持「一笔订单整笔退」).
--
--      refund_no 是网关侧生成的退款单号, 与 out_trade_no 类比. 加 UNIQUE 同样保证幂等.
--      reason 留给运营 / 客服记录, 例如 "客户取消订单" / "重复支付" / "对账差异自动平账".
--
--      状态机:
--        pending     -- admin 触发退款后写入, 已 call adapter.refund(), 等待异步回调
--        succeeded   -- 平台回调确认退款成功, 已执行回退 (wallet.balance_micro -= amount_micro)
--        failed      -- 平台回调拒绝退款 (例如已退过 / 单据不存在)
--
--      关于「退款时余额扣穿」: refund 执行回退时如果 wallet.balance_micro < amount_micro,
--      说明用户已经把这笔钱花掉了. 业务策略两种:
--        a. 强制扣穿 (允许 balance 为负, 后续充值优先抵扣);
--        b. 先 freeze 待用户后续充值时自动抵扣.
--      本章 v0.11 选 a (代码里乐观锁去掉 >= 检查), 简化教学, 真实运营按场景定.
--
-- 设计参考:
--   - new-api controller/topup.go::RequestEpay (订单创建 + LockOrder/UnlockOrder + EpayNotify 回调)
--     -- 字段口径与 PaymentProvider / TopUpStatus 设计同源
--   - one-api model/log.go::RecordTopupLog (单纯流水日志, 不细分状态机)
--   - Stripe Idempotency-Key: https://stripe.com/docs/api/idempotent_requests
--   - 支付宝异步通知: https://opendocs.alipay.com/open/270/105902
--   - 微信支付 V3 通知: https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_0.shtml

CREATE TABLE IF NOT EXISTS `wallets` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `user_id` integer NOT NULL,
  `balance_micro` integer NOT NULL DEFAULT 0,
  `frozen_micro` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
);

-- 一个 user 一个 wallet, 强约束
CREATE UNIQUE INDEX IF NOT EXISTS `wallets_user_id_idx` ON `wallets` (`user_id`);

CREATE TABLE IF NOT EXISTS `recharges` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `wallet_id` integer NOT NULL,
  `user_id` integer NOT NULL,
  `out_trade_no` text NOT NULL,
  `provider` text NOT NULL,
  `amount_micro` integer NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `raw_payload` text,
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`wallet_id`) REFERENCES `wallets` (`id`)
);

-- ★ 充值幂等的核心: out_trade_no 全局唯一, 重复回调 INSERT 会撞约束
CREATE UNIQUE INDEX IF NOT EXISTS `recharges_out_trade_no_idx` ON `recharges` (`out_trade_no`);
CREATE INDEX IF NOT EXISTS `recharges_wallet_status_idx` ON `recharges` (`wallet_id`, `status`);
CREATE INDEX IF NOT EXISTS `recharges_status_created_idx` ON `recharges` (`status`, `created_at`);

CREATE TABLE IF NOT EXISTS `refunds` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `recharge_id` integer NOT NULL,
  `refund_no` text NOT NULL,
  `amount_micro` integer NOT NULL,
  `reason` text,
  `status` text NOT NULL DEFAULT 'pending',
  `raw_payload` text,
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`recharge_id`) REFERENCES `recharges` (`id`)
);

-- ★ 退款幂等同样靠 refund_no 唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS `refunds_refund_no_idx` ON `refunds` (`refund_no`);
CREATE INDEX IF NOT EXISTS `refunds_recharge_status_idx` ON `refunds` (`recharge_id`, `status`);
