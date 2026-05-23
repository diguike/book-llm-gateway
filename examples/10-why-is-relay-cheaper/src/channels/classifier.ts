// 错误分类器
//
// 把上游响应 (status + body) 或 fetch 抛出的异常归到四类:
//
//   - transparent: 4xx 业务错 (400/404/422 等). 不重试, 不禁用, 原样透传给客户端.
//                  典型场景: 客户端请求体不合规, 模型名拼错, prompt 触发 content_filter.
//
//   - retryable  : 5xx 上游故障 / 网络层错. 同 channel 不重试 (避免同样错重复),
//                  但允许换 channel 重试. 典型场景: 上游 502/503/504 / 网络抖动 / TCP RST.
//
//   - disable    : 401/403 / "invalid_api_key" / "account_deactivated".
//                  立即禁用该 channel, 进入 disabled 状态等 health-checker 探活恢复.
//                  典型场景: Key 被风控吊销, 账户欠费, 权限被撤销.
//
//   - throttle   : 429 / "rate_limit_exceeded" / "tpm_exceeded".
//                  短期禁用 channel (默认 5 分钟), 时间到后自动恢复.
//                  与 disable 的区别: throttle 是「暂时性的, 上游主动限速」, 不是「Key 死了」.
//                  这两类必须拆开, 因为后台 worker 的探活策略不同:
//                    - disable: 探活间隔 60s (Key 复活通常是人工解封, 频率低)
//                    - throttle: 5 分钟到点直接恢复 (限速过去就过去了)
//
// 设计参考:
//   - one-api monitor/manage.go::ShouldDisableChannel - 这套关键字字典是真金白银踩出来的,
//     本书直接照抄了核心几条 (invalid_api_key / account_deactivated / api key not valid /
//     organization has been disabled / insufficient_quota / your credit balance is too low).
//   - one-api controller/relay.go::shouldRetry - 4xx (除 429) 不重试, 5xx + 429 重试.
//     本书把它拆得更细: 4xx 大部分 transparent, 401/403 单拎出来 disable.
//   - portkey-gateway v1.15.2 src/handlers/handleAPICall.ts retryCount - 重试是 status code
//     白名单驱动 (默认 408/425/429/500/502/503/504).

export type ErrorClass = 'transparent' | 'retryable' | 'disable' | 'throttle';

export interface ClassifyInput {
  /** HTTP 状态码. fetch 网络层错时为 null */
  status: number | null;
  /** 响应体 (字符串). 长度上限 4KB, 超过截断 */
  body?: string;
  /** fetch 抛出的 Error 实例 (网络层错时存在) */
  networkError?: Error;
}

export interface ClassifyResult {
  class: ErrorClass;
  reason: string;
}

/**
 * 把一次上游调用的失败结果归类.
 *
 * 决策顺序 (按特异性从高到低):
 *   1. networkError 存在 -> retryable (DNS / TCP RST / connect timeout 都是网络层错)
 *   2. status === 401 or 403 -> disable
 *   3. status === 429 -> throttle
 *   4. 4xx (其他) -> transparent
 *   5. 5xx -> retryable
 *   6. body 关键字命中 (账户欠费 / Key 失效 / 组织被禁) -> disable
 *      这一条放在最后, 是因为某些上游会把 401 类错误以 200 + error.body 形式返回
 *      (OpenAI 兼容上游常见做法), 必须扫 body 兜底.
 */
export function classifyError(input: ClassifyInput): ClassifyResult {
  // 1. 网络层错
  if (input.networkError) {
    return {
      class: 'retryable',
      reason: `network_error: ${input.networkError.message.slice(0, 200)}`,
    };
  }

  const status = input.status;
  const body = input.body ?? '';

  // 2. 401 / 403 -> disable (鉴权或权限问题, Key 失效)
  if (status === 401 || status === 403) {
    return { class: 'disable', reason: `upstream_${status}` };
  }

  // 3. 429 -> throttle (上游限速, 短期冷却)
  if (status === 429) {
    return { class: 'throttle', reason: 'upstream_429_rate_limited' };
  }

  // 4. body 关键字扫描: 某些上游用 200 + error.body 表达鉴权失败,
  //    或者 5xx body 里其实写着 "api key not valid" 这种 disable 信号
  const lowerBody = body.toLowerCase().slice(0, 4096);
  const disableKeywords = [
    'invalid_api_key',
    'invalid api key',
    'api key not valid',
    'api key expired',
    'account_deactivated',
    'account has been deactivated',
    'authentication_error',
    'organization has been disabled',
    'organization has been restricted',
    'insufficient_quota',
    'your credit balance is too low',
    '已欠费',
    'permission_error',
    'permission denied',
  ];
  for (const kw of disableKeywords) {
    if (lowerBody.includes(kw)) {
      return { class: 'disable', reason: `body_keyword: ${kw}` };
    }
  }

  // 5. 5xx -> retryable (默认上游故障可换 channel 重试)
  if (status !== null && status >= 500 && status < 600) {
    return { class: 'retryable', reason: `upstream_${status}` };
  }

  // 6. 其他 4xx -> transparent (业务错, 透传给客户端)
  if (status !== null && status >= 400 && status < 500) {
    return { class: 'transparent', reason: `upstream_${status}` };
  }

  // 7. 兜底: 2xx 不应该走到这里 (这是错误分类器), 但保守起见标 transparent
  return { class: 'transparent', reason: `unexpected_status: ${status}` };
}

/**
 * throttle 状态的默认冷却时长 (毫秒). 5 分钟覆盖大多数 RPM 窗口.
 * health-checker 看 disabled_at + THROTTLE_COOLDOWN_MS 判定要不要尝试恢复.
 */
export const THROTTLE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * disable 状态的最小探活间隔 (毫秒). 60s 一次, 避免对失效 channel 上的 Key 持续探活
 * 触发上游风控升级.
 */
export const DISABLE_PROBE_INTERVAL_MS = 60 * 1000;
