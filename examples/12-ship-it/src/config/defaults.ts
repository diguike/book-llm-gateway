// 常量默认值. 单独抽出来, 方便 env.ts 引用 + 测试 mock.
//
// 三套环境 (dev / prod / test) 的差异主要在以下几项:
//   - LOG_LEVEL: dev/test=debug, prod=info
//   - SSE_HEARTBEAT_MS: dev=15s (方便看), prod=15s, test=2s (跑得快)
//   - HEALTH_CHECK_INTERVAL_MS: dev=60s, prod=60s, test=5s
//   - INITIAL_BALANCE_CNY: dev/test=100 (方便跑), prod=0 (强制走充值链路)

export const APP_DEFAULTS = {
  PORT: 3000,
  // 主链路 max_tokens 兜底, 客户端不传时用这个估算预扣
  DEFAULT_MAX_TOKENS: 4096,
  DEFAULT_GROUP: 'default',
  MAX_CHANNEL_ATTEMPTS: 3,
} as const;

export const HEALTH_DEFAULTS = {
  // /readyz 要求至少多少个 channel active 才算 ready
  MIN_ACTIVE_CHANNELS: 1,
  // /readyz 探测超时
  READINESS_TIMEOUT_MS: 2000,
} as const;

export const STREAMING_DEFAULTS = {
  HEARTBEAT_MS: 15_000,
} as const;

export const LIMIT_DEFAULTS = {
  GLOBAL_QPS_LIMIT: 0,
  GLOBAL_TPM_LIMIT: 0,
  PER_MODEL_QPS_LIMIT: 0,
  PER_MODEL_TPM_LIMIT: 0,
} as const;

export const HEALTH_CHECKER_DEFAULTS = {
  INTERVAL_MS: 60_000,
} as const;

export const PAYMENT_DEFAULTS = {
  MOCK_PAY_BASE_URL: 'http://localhost:5010',
  MOCK_PAY_SECRET: 'test-mock-secret',
} as const;
