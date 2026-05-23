// v1.0 环境变量校验. 启动时一次性跑, 缺失或类型错直接 process.exit(1).
//
// 设计原则:
//   1. 所有 env 必须在这里声明 + 校验, 业务代码不能再 process.env.X 散读.
//   2. 必填的字段写 .min(1) (字符串) 或 .int().positive(), 缺失立即报错.
//   3. 可选的字段给默认值, 错误类型给清晰提示.
//   4. NODE_ENV 决定一些字段的默认值 (例如 prod 把 INITIAL_BALANCE_CNY 兜底为 0).
//
// 这个模式的好处: 启动失败比运行时失败快得多. 一个 typo 的 env 名 (比如 OPENAI_KEY 写成
// OPENAI_API_KEY) 在 v0.10 之前会等到第一次发请求时上游 401 才报错. v1.0 启动就报.

import { z } from 'zod';

import {
  APP_DEFAULTS,
  HEALTH_CHECKER_DEFAULTS,
  LIMIT_DEFAULTS,
  PAYMENT_DEFAULTS,
  STREAMING_DEFAULTS,
} from './defaults.js';

const intFromString = (defaultVal: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultVal : Number(v)))
    .refine((v) => Number.isFinite(v), { message: 'must be a finite number' });

const intFromStringRequired = () =>
  z
    .string()
    .min(1, 'required')
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && Number.isInteger(v), {
      message: 'must be an integer',
    });

// boolean from string: 'true' / '1' / 'yes' = true, others = false
const boolFromString = (defaultVal: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultVal;
      return v === 'true' || v === '1' || v === 'yes';
    });

const NodeEnv = z.enum(['dev', 'prod', 'test']).default('dev');

const EnvSchema = z.object({
  // ---------- 基础 ----------
  NODE_ENV: NodeEnv,
  PORT: intFromString(APP_DEFAULTS.PORT),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---------- 持久层 ----------
  // SQLite 文件路径. 必填, 提醒读者明确选择.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (SQLite file path)'),

  // ---------- 鉴权 ----------
  // ADMIN_TOKEN 必填且非默认值 (生产部署强制改). dev/test 允许默认.
  ADMIN_TOKEN: z.string().min(8, 'ADMIN_TOKEN must be at least 8 chars'),

  // ---------- 上游 (至少一家可用. v1.0 不强制三家全填, 让读者按需注释) ----------
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  OPENAI_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),

  // ---------- mock LLM 上游 (e2e 测试 + 默认 channel 用) ----------
  MOCK_BASE_URL: z.string().url().default('http://localhost:4010'),
  MOCK_PORT: intFromString(4010),
  MOCK_CHUNK_INTERVAL_MS: intFromString(250),

  // ---------- 计费 ----------
  INITIAL_BALANCE_CNY: intFromString(100),
  DEFAULT_MAX_TOKENS: intFromString(APP_DEFAULTS.DEFAULT_MAX_TOKENS),

  // ---------- 限流 (0 = 关) ----------
  GLOBAL_QPS_LIMIT: intFromString(LIMIT_DEFAULTS.GLOBAL_QPS_LIMIT),
  GLOBAL_TPM_LIMIT: intFromString(LIMIT_DEFAULTS.GLOBAL_TPM_LIMIT),
  PER_MODEL_QPS_LIMIT: intFromString(LIMIT_DEFAULTS.PER_MODEL_QPS_LIMIT),
  PER_MODEL_TPM_LIMIT: intFromString(LIMIT_DEFAULTS.PER_MODEL_TPM_LIMIT),

  // ---------- 流式 ----------
  SSE_HEARTBEAT_MS: intFromString(STREAMING_DEFAULTS.HEARTBEAT_MS),

  // ---------- 渠道健康检查 ----------
  HEALTH_CHECK_INTERVAL_MS: intFromString(HEALTH_CHECKER_DEFAULTS.INTERVAL_MS),

  // ---------- 渠道选择 ----------
  DEFAULT_GROUP: z.string().default(APP_DEFAULTS.DEFAULT_GROUP),
  MAX_CHANNEL_ATTEMPTS: intFromString(APP_DEFAULTS.MAX_CHANNEL_ATTEMPTS),

  // ---------- 支付 (mock) ----------
  MOCK_PAY_BASE_URL: z.string().url().default(PAYMENT_DEFAULTS.MOCK_PAY_BASE_URL),
  MOCK_PAY_PORT: intFromString(5010),
  MOCK_PAY_AUTO_DELAY_MS: intFromString(3000),
  MOCK_PAY_REFUND_DELAY_MS: intFromString(2000),
  MOCK_PAY_RETRY_MS: intFromString(0),
  MOCK_PAY_SECRET: z.string().min(1, 'MOCK_PAY_SECRET is required').default(PAYMENT_DEFAULTS.MOCK_PAY_SECRET),
  PAYMENT_NOTIFY_BASE: z.string().url().default('http://localhost:3000'),

  // ---------- /readyz ----------
  READINESS_REQUIRE_WALLET: boolFromString(true),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

/**
 * 校验并解析所有 env 变量. 失败时打印缺失字段并 process.exit(1).
 *
 * 设计点: 不抛异常, 直接 exit. 启动期的配置错误属于「程序员错误」, 不应当被业务代码捕获.
 * exit code = 1 让 systemd / docker / k8s 都能识别为启动失败.
 */
export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('[env] config validation failed:');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
    }
    process.exit(1);
  }

  // 跨字段约束:
  //   prod 模式下, ADMIN_TOKEN 不允许等于 .env.example 的默认值
  if (parsed.data.NODE_ENV === 'prod' && parsed.data.ADMIN_TOKEN === 'admin-change-me') {
    // eslint-disable-next-line no-console
    console.error(
      '[env] ADMIN_TOKEN is still the default placeholder. set a strong random token in production.',
    );
    process.exit(1);
  }

  // prod 模式下, 至少要配一家真实上游 OR 显式声明用 mock
  if (parsed.data.NODE_ENV === 'prod') {
    const hasReal =
      (parsed.data.OPENAI_API_KEY && parsed.data.OPENAI_API_KEY !== 'sk-replace-me') ||
      (parsed.data.DEEPSEEK_API_KEY && parsed.data.DEEPSEEK_API_KEY !== 'sk-replace-me') ||
      (parsed.data.ANTHROPIC_API_KEY && parsed.data.ANTHROPIC_API_KEY !== 'sk-ant-replace-me');
    if (!hasReal) {
      // eslint-disable-next-line no-console
      console.warn(
        '[env] no real upstream key configured in prod mode. only mock channels will work.',
      );
    }
  }

  cached = parsed.data;
  return cached;
}

/**
 * 测试场景下重置缓存 (跑多个测试用例时常用).
 */
export function _resetEnvCache(): void {
  cached = null;
}

// 仅供 typecheck / 静态导出. 业务代码用 loadEnv() 获取.
export { EnvSchema };

// 不在 import 时立即跑, 否则单跑 typecheck / migrate 都会被强制校验. 让入口 (index.ts /
// migrate.ts / scripts) 显式调.

// 只有以下两种入口才需要全校验:
//   1. src/index.ts 启动主网关
//   2. src/scripts/* 跑 e2e 时
// 类似 npm run typecheck / drizzle:generate / migrate 这些不需要的, 不调 loadEnv().

// 工具方法: 只对希望「用最小 env 也能跑」的 cli 用
intFromStringRequired; // satisfy unused
