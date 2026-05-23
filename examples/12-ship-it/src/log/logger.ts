// 第 9 章 v0.9: 结构化日志 (pino) + child logger 工厂
//
// 这一层把全 repo 的 `console.log` / 自由格式 pino 调用收口到一个 logger 实例.
// 关键设计:
//
//   1. JSON 输出 + 文件名 / 行号自动剥离, 让日志能直接接 ELK / Datadog / Loki;
//   2. base 字段固定带 service / env / pid, 跨进程聚合时不再丢上下文;
//   3. 通过 child(...) 在请求级别 bind trace_id, 后续所有调用自动带 trace_id;
//   4. 提供一份「日志字段字典」, 全 repo 任何 logger.info({...}) 的 key 都从这里取,
//      避免 trace_id / traceId / trace-id 这种同义词漂移.
//
// 字段字典对齐 one-api model/log.go 的 Log 结构, 但我们用 snake_case (JSON 习惯)
// 替代它的 PascalCase. RequestId 我们拆成两个: trace_id 是全链路唯一 (每次客户端
// 请求一个), request_id 是 hono ctx 级的请求标识 (重试 / 内部子请求也算一个新的).
// 实际项目里两者大概率重合, 留两个字段是给未来「重试展开成多个 request」的扩展.
//
// 关于 transport:
//   - 开发环境 (LOG_PRETTY=true): pino-pretty 加颜色与换行, 方便人读;
//   - 生产环境 (默认): 直接 JSON 一行一条到 stdout, 由 docker logs / journald
//     收走, 后接日志聚合.
// 这两种用法本质上是不同的 transport, pino 官方推荐用 worker thread 的 transport
// (而不是同步包 stdout), 我们直接遵循官方推荐 (https://getpino.io/#/docs/transports).

import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * 日志字段字典. 全 repo 调 logger 时只能用这里列出的 key, 避免同义词漂移.
 *
 * 不同字段的语义:
 *   trace_id            一次客户端请求的全链路唯一 ID. Hono middleware 生成, 贯穿
 *                       鉴权 / 限流 / billing / channel / streaming. 与 usage_records.trace_id 等值.
 *   request_id          单个 HTTP request 标识. 与 trace_id 一致 (本书未做内部子请求展开).
 *   user_id             网关用户 ID. 鉴权通过后立即写入.
 *   key_id              本次请求使用的内部 Key id (sk-gw-...). 与 keys.id 对齐.
 *   org_id              用户所属组织 ID.
 *   channel_id          实际命中的上游渠道 id (channels.id).
 *   channel_name        命中的渠道人类可读名 (channels.name), 看板与日志一起显示.
 *   model               IR.model 字段. 客户端声明的目标模型.
 *   provider            adaptor.name. 路由后的真实上游 (openai / deepseek / mock).
 *   prompt_tokens       真实 prompt token (上游 usage 返回).
 *   completion_tokens   真实 completion token.
 *   upstream_latency_ms fetch(upstream) 起到拿到 first byte / parse 完成的耗时.
 *   total_latency_ms    客户端请求到网关响应结束的总耗时.
 *   status              HTTP 状态码 (gateway 返回给客户端的那一档).
 *   error_code          错误标识 (例: insufficient_quota / rate_limit_exceeded / upstream_401).
 *   attempted_channels  本次请求实际尝试过的 channel id 列表 (有失败转移时 > 1).
 *   final_cost_micro_cny 实结金额 (微元).
 *   terminal_status     流式终态: finalized / canceled / partial.
 */
export const LogFields = {
  TRACE_ID: 'trace_id',
  REQUEST_ID: 'request_id',
  USER_ID: 'user_id',
  KEY_ID: 'key_id',
  ORG_ID: 'org_id',
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
  FINAL_COST_MICRO_CNY: 'final_cost_micro_cny',
  TERMINAL_STATUS: 'terminal_status',
} as const;

/** 全 repo 共享的根 logger. 业务代码不应该直接用, 用 createChildLogger 派生. */
function buildRootLogger(): Logger {
  const env = process.env.NODE_ENV ?? 'development';
  const level = process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug');
  const usePretty = (process.env.LOG_PRETTY ?? (env === 'production' ? 'false' : 'true')) === 'true';

  const opts: LoggerOptions = {
    level,
    base: {
      service: 'gateway',
      env,
      pid: process.pid,
    },
    // 时间戳用 ISO 字符串, JSON 聚合系统通常更友好 (默认是 unix ms number, 可读性差)
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    // 把上游 status / 自定义 status 字段都保持原状, 不让 pino 把它打成 levelKey
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (usePretty) {
    return pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,service,env',
        },
      },
    });
  }

  // 生产: 直接 JSON 到 stdout
  return pino(opts);
}

const rootLogger = buildRootLogger();

/**
 * 派生一个带固定 bindings 的 child logger.
 *
 * pino 的 child(bindings) 不会复制 bindings, 而是把它绑到 child logger 实例上,
 * 之后所有 child.info({...}) 都会自动 merge 进去. 这是为什么 trace_id 的注入
 * 只在 middleware 里调一次, 后续全链路都自动带 (https://getpino.io/#/docs/child-loggers).
 *
 * 典型用法:
 *   const logger = createChildLogger({ trace_id: 'abc...' });
 *   logger.info({ channel_id: 2 }, 'channel_picked');
 *   // 输出 JSON 含: trace_id=abc..., channel_id=2, msg=channel_picked
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return rootLogger.child(bindings);
}

/**
 * 给「没有 trace_id 上下文」的代码用 (例如启动时 migration / health-checker tick).
 * 不建议在请求路径中使用 -- 请求路径一律走 ctx.logger.
 */
export function getRootLogger(): Logger {
  return rootLogger;
}

export type { Logger } from 'pino';
