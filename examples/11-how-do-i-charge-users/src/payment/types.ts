// PaymentAdaptor: 支付平台适配器抽象接口
//
// 与 Ch2 的 ProviderAdaptor 形成对称设计:
//   ProviderAdaptor: 把网关的 IRChatRequest 翻译给上游 LLM API, 把响应翻译回 IR;
//   PaymentAdaptor:  把网关的「创建订单 / 验签回调 / 退款 / 查询」四件事翻译给支付平台.
//
// 一个支付平台 = 一个 PaymentAdaptor 实现. 网关核心代码只看接口, 不依赖任何 SDK.
//
// 三家典型平台在抽象层的差异:
//
//   维度          Stripe                  支付宝                  微信支付 V3
//   ---------------------------------------------------------------------------------
//   下单方式      PaymentIntent API       alipay.trade.precreate  /v3/pay/transactions/native
//   幂等键        Idempotency-Key header  out_trade_no            out_trade_no
//   回调形态      webhook + 同步 redirect  服务器异步通知          服务器异步通知
//   验签         HMAC-SHA256 (header)    RSA2 (param sign)       AEAD-AES-256-GCM (header)
//   回调验签来源  Stripe-Signature header alipay 公钥 verify       Wechatpay-Signature header
//   退款时机      同步 + webhook           异步 alipay.trade.refund 同步 + 异步通知
//   对账文件      Reports API (CSV/JSON)  对账单查询接口 (CSV)     交易账单 / 资金账单 (CSV)
//
// 三家的差异最终都被这套 4 方法接口收敛, 所以网关业务代码不用关心是哪一家.
//
// 真实接入这三家的代码量参考:
//   - Stripe TS SDK 官方版本一般 200-300 行 (verify webhook signature + create payment intent + handle refund);
//   - 支付宝 Open SDK 二次封装 250-400 行 (RSA 签名 + 加密 + verify);
//   - 微信支付 V3 SDK 350-500 行 (AEAD 解密 + 证书加载 + 自动密钥轮换);
// 真实代码不放正文 (合规 / SDK 升级 / 地区差异), 接入要点见附录 A.

/** 创建订单的入参 */
export interface CreateOrderInput {
  /** 网关侧生成的全局唯一商户订单号. 一切都靠它对账 + 幂等 */
  outTradeNo: string;
  /** 充值金额 (微元). adapter 内部按需要换算成厂商单位 */
  amountMicro: number;
  /** 网关侧 user_id, 写进订单的 metadata 方便对账 */
  userId: number;
  /** 商品描述, 通常是「中转站充值 ¥xx」 */
  subject: string;
}

/** 创建订单的返回 */
export interface CreateOrderOutput {
  /** 商户订单号 (回传, 校验用) */
  outTradeNo: string;
  /**
   * 适配器原生支付凭据. 三家平台返回的字段不一样, 这里用 union 类型描述:
   *   - Stripe:   { kind: 'client_secret', clientSecret: string, intentId: string }
   *   - 支付宝:    { kind: 'qr_code',       qrCodeUrl: string }
   *               或 { kind: 'redirect_url', url: string }
   *   - 微信支付:  { kind: 'qr_code',       qrCodeUrl: string }
   *   - mock:     { kind: 'redirect_url',  url: string }   (本地 HTTP server)
   */
  credential: PaymentCredential;
}

export type PaymentCredential =
  | { kind: 'redirect_url'; url: string }
  | { kind: 'qr_code'; qrCodeUrl: string }
  | { kind: 'client_secret'; clientSecret: string; intentId: string };

/** 平台异步回调 (notify webhook) 验签后解析出的标准化结果 */
export interface VerifiedCallback {
  /** 商户订单号. 网关侧据此 lookup recharges 行 */
  outTradeNo: string;
  /** 平台侧的支付状态翻译到网关状态机 */
  status: 'succeeded' | 'failed';
  /** 平台返回的实际金额 (微元), 与下单时的 amount 一致才入账 */
  amountMicro: number;
  /** 平台原始 payload (JSON 字符串), 落库做审计. 不要二次序列化 */
  rawPayload: string;
}

/** 验签失败 / payload 不合法时直接 throw, 网关层捕获后返 400 */
export class CallbackVerificationError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'CallbackVerificationError';
  }
}

/** 退款入参 */
export interface RefundInput {
  /** 原订单的商户订单号 */
  outTradeNo: string;
  /** 退款单号 (网关生成, 全局唯一). 与原订单号 1:1 对应. */
  refundNo: string;
  /** 退款金额 (微元), 教学版只支持整笔退, 必须 = 原 amount */
  amountMicro: number;
  /** 退款原因, 透传给平台 (大多数平台仅留作说明, 不影响退款行为) */
  reason: string;
}

/** 退款返回 */
export interface RefundOutput {
  /** 退款是否被平台接受. true 不代表已到账 -- 退款多数走异步, 真正到账等回调 */
  accepted: boolean;
  /** 平台侧的退款单号 (有些平台会回另一个号). 留作对账 */
  platformRefundNo?: string;
  /** 平台原始响应, 落库审计 */
  rawPayload: string;
}

/** 同步查询订单状态 (容灾用) */
export interface QueryStatusOutput {
  outTradeNo: string;
  /**
   * 平台侧的支付状态翻译到网关状态机. 当回调丢失时网关定时跑此方法对平台兜底查询.
   */
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'unknown';
  rawPayload: string;
}

/**
 * 支付平台适配器接口.
 *
 * 实现一个新平台 = new 一个 class 实现这 4 个方法 + 注册进 registry.
 */
export interface PaymentAdaptor {
  /** 适配器名字, 与 recharges.provider 字段对齐 */
  readonly name: string;

  /**
   * 创建订单. 不写库 -- 写库是 wallet/service.ts 的责任 (统一管 recharges 表).
   * 这个方法只对外发起一次请求, 拿回支付凭据 (URL / 二维码 / clientSecret).
   *
   * 失败 throw, 调用方捕获后写 recharges 时 status 直接给 failed.
   */
  createOrder(input: CreateOrderInput): Promise<CreateOrderOutput>;

  /**
   * 验签 + 解析平台回调.
   *
   * 三家平台的验签材料位置不同:
   *   - Stripe:   payload 是 raw body, signature 在 'Stripe-Signature' header
   *   - 支付宝:    payload 是 form-urlencoded 解析后的 map, signature 是其中的 'sign' 字段
   *   - 微信支付:  payload 是 raw body (内含 ciphertext), signature 在 'Wechatpay-Signature' header
   *
   * 为了适配三种, 接口同时收 payload (raw body) + headers (Map). 实现方按需选用.
   *
   * 验签失败 throw CallbackVerificationError, 网关返 400, 不写流水.
   */
  verifyCallback(payload: string, headers: Record<string, string>): Promise<VerifiedCallback>;

  /**
   * 异步发起退款.
   *
   * 真实接入:
   *   - Stripe:   refunds.create({ payment_intent: ..., idempotency_key: refundNo })  -- 同步返回, 然后 webhook 二次确认
   *   - 支付宝:    alipay.trade.refund -- 同步返回 + 异步通知
   *   - 微信支付:  /v3/refund/domestic/refunds -- 同步返回 + 异步通知
   *
   * 大多数平台 refund() 同步返回的是「受理成功」, 真正退款到账是回调里的 status=succeeded.
   * 所以本方法只负责发起 + 落 pending 行, 真正回退余额放 verifyCallback() 里做.
   */
  refund(input: RefundInput): Promise<RefundOutput>;

  /**
   * 同步查询订单状态 (容灾用).
   *
   * 用途:
   *   1. 客户端轮询「我充值的钱到账没?」时 -- 不应频繁调, 但作为兜底可用
   *   2. 网关侧定时跑「pending 超过 30 分钟的订单」反查平台状态, 防回调丢失
   */
  queryStatus(outTradeNo: string): Promise<QueryStatusOutput>;
}
