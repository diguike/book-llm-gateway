// 第 9 章 v0.9: trace_id 生成 + child logger 注入 middleware
//
// 这是「第一个」需要挂的 middleware, 排在 auth / limit 之前.
// 排在最前面的原因:
//
//   1. trace_id 是后续所有日志的关联键. auth 失败的 401 也应该带 trace_id,
//      不然「为什么这把 Key 被拒了」这种事故排查会断线;
//   2. 客户端可能传 X-Request-Id (常见用法, 客户端方便自己关联), 网关如果
//      存在这种头, 就把它当 trace_id 复用; 否则生成一个新的;
//   3. 把 child logger 注入 ctx, 后续每一层都从 ctx 取 logger, 不再 import 全局.
//
// 字段格式: crypto.randomUUID() 输出标准 36 字符 UUIDv4. one-api 用 hex(16)
// 32 字符的自定义格式, 本书统一用 UUID, 与上游 OpenAI 等的 x-request-id 头格式一致,
// 跨系统对账时不需要再做格式转换.
//
// 响应头: 把 trace_id 通过 X-Request-Id 响应头回写给客户端. 客户端遇到「这次调用
// 网关返回异常」时, 把这个值发给我们运维, 一行 grep 就能定位.
//
// 性能考虑: randomUUID() 是 Node 18+ 内置的 crypto 同步实现, 单次约 1-2us,
// 不会成为热路径瓶颈.

import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';

import { createChildLogger, type Logger } from './logger.js';

/** ctx.var.logger 的类型. 后续所有 middleware / handler 通过 c.get('logger') 拿到 */
export type TraceVariables = {
  trace_id: string;
  logger: Logger;
  request_started_at: number;
};

/**
 * trace_id middleware. 必须挂在 auth / limit 之前.
 *
 * 行为:
 *   1. 取客户端的 X-Request-Id 头, 没有则 randomUUID() 生成;
 *   2. 把 trace_id + 一个 child logger (已 bind trace_id) 注入 ctx;
 *   3. 把 trace_id 写回响应头, 让客户端能拿到;
 *   4. next() 后打一行 request_completed, 含状态码 + 总耗时. 这是看板 QPS / 错误率
 *      的核心数据源 -- 不需要每条业务日志都打, 一个统一的尾部日志足够.
 */
export const traceMiddleware: MiddlewareHandler<{ Variables: TraceVariables }> = async (c, next) => {
  const startedAt = Date.now();
  const clientGiven = c.req.header('x-request-id');
  const traceId =
    typeof clientGiven === 'string' && clientGiven.length > 0 && clientGiven.length < 200
      ? clientGiven
      : randomUUID();

  const logger = createChildLogger({
    trace_id: traceId,
    request_id: traceId,
    method: c.req.method,
    path: c.req.path,
  });

  c.set('trace_id', traceId);
  c.set('logger', logger);
  c.set('request_started_at', startedAt);
  c.header('X-Request-Id', traceId);

  logger.debug({ ip: c.req.header('x-forwarded-for') ?? null }, 'request_started');

  try {
    await next();
  } finally {
    const totalLatency = Date.now() - startedAt;
    logger.info(
      {
        status: c.res?.status ?? 0,
        total_latency_ms: totalLatency,
      },
      'request_completed',
    );
  }
};
