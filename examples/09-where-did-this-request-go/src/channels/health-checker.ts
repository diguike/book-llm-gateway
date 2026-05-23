// 后台健康检查 worker
//
// 职责: 定期 (默认每 60s) 扫一遍 status=disabled 的 channel, 给它发一个最便宜模型的 ping
// 请求, 通过则恢复成 active. 让被风控临时禁用的 channel 在「上游放开后」自动回到流量池,
// 不需要人工干预.
//
// 探活策略:
//   - throttle 类禁用 (reason=upstream_429_rate_limited): 冷却时间 = THROTTLE_COOLDOWN_MS,
//     时间到点直接尝试探活; 探活失败再 disable, 进入 disable 路径;
//   - disable 类禁用 (其他 reason): 最小探活间隔 = DISABLE_PROBE_INTERVAL_MS (60s),
//     超过这个间隔的才尝试探活; 探活失败原样 disable, 下次 worker 跑时再试.
//
// 探活内容: 一个最便宜模型 (channel.enabled_models 数组的第一个) 的最小请求
//   {role:'user', content:'ping'}, max_tokens=1.
//   不在乎响应内容, 只要 HTTP 200 + body 不含 disable 关键字就算通过.
//   max_tokens=1 让探活本身的费用 ~ 0.0001 元, 对账上的损耗可以忽略.
//
// 为什么不用上游官方提供的 health 端点:
//   - 大多数 LLM 上游 (OpenAI / Anthropic / DeepSeek) 没有专门的 health endpoint;
//   - 即使有, /v1/models 这种「列模型」接口不会触发计费, 也就不能验证「这把 Key 还能
//     用来花钱」. 只有用 chat/completions 真请求一次, 才能确认账号没欠费 / 没被风控.
//
// 设计参考:
//   - one-api controller/channel-test.go::testChannel - 用 config.TestPrompt 发一条真实请求,
//     记录响应时间. 本书的 health-checker 走同样思路, 但加了状态机过渡 (active -> probing -> active/disabled).
//   - one-api monitor/manage.go::ShouldEnableChannel - 探活无 error 即认为可恢复.

import {
  listDisabledChannels,
  markChannelActive,
  markChannelDisabledAfterProbe,
  markChannelProbing,
} from './store.js';
import { buildAdaptorForChannel } from './router.js';
import { classifyError, DISABLE_PROBE_INTERVAL_MS, THROTTLE_COOLDOWN_MS } from './classifier.js';
import { getChannelRegistry, type ChannelEntry } from './registry.js';
import { createChildLogger } from '../log/logger.js';

// 后台 worker 没有请求级 trace_id, 只 bind 一个 component 标签让看板 / 日志聚合时
// 能按 service+component 过滤. 真要复用 trace_id (例如「这次探活是 admin 主动触发」),
// 调用方传一个 traceId 进来用 createChildLogger({ trace_id, component: 'health-checker' }).
const logger = createChildLogger({ component: 'health-checker' });

export interface HealthCheckerOptions {
  /** 主循环间隔, 毫秒. 默认 60s. 测试场景可调到 2s 加速观察. */
  intervalMs?: number;
  /** 单次探活 fetch 的超时, 毫秒. 默认 10s. */
  probeTimeoutMs?: number;
}

let _started = false;
let _timer: NodeJS.Timeout | null = null;

/** 启动 worker. 主进程 import 一次, 重复 start 自动忽略. */
export function startHealthChecker(opts: HealthCheckerOptions = {}): void {
  if (_started) return;
  _started = true;

  const intervalMs = opts.intervalMs ?? 60_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;

  const tick = async () => {
    try {
      await runOnce({ probeTimeoutMs });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'health_checker_tick_error');
    }
  };

  // 启动后立刻跑一次, 之后按 interval 循环
  void tick();
  _timer = setInterval(() => void tick(), intervalMs);
  if (_timer.unref) _timer.unref(); // 不阻塞进程退出
  logger.info({ interval_ms: intervalMs, probe_timeout_ms: probeTimeoutMs }, 'health_checker_started');
}

export function stopHealthChecker(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _started = false;
}

/** 单次扫描 + 探活. 暴露出来给 admin 手动触发用 ("立刻 retry 一遍 disabled channel"). */
export async function runOnce(opts: { probeTimeoutMs: number }): Promise<{
  scanned: number;
  recovered: number[];
  stillDisabled: number[];
}> {
  const disabled = listDisabledChannels();
  const recovered: number[] = [];
  const stillDisabled: number[] = [];
  const now = Date.now();

  for (const row of disabled) {
    // 判定是否到点可以探活
    const isThrottle = row.disabledReason === 'upstream_429_rate_limited';
    const cooldown = isThrottle ? THROTTLE_COOLDOWN_MS : DISABLE_PROBE_INTERVAL_MS;
    const since = row.disabledAt ?? row.lastProbedAt ?? 0;
    if (now - since < cooldown) {
      stillDisabled.push(row.id);
      continue;
    }

    // 探活前把它切到 probing (UI 上能看到中间态; 其他线程不会同时再 probe)
    markChannelProbing(row.id);
    const entry = getChannelRegistry().get(row.id);
    if (!entry) {
      stillDisabled.push(row.id);
      continue;
    }

    const result = await probe(entry, opts.probeTimeoutMs);
    if (result.ok) {
      markChannelActive(row.id);
      recovered.push(row.id);
      logger.info(
        {
          channel_id: row.id,
          channel_name: row.name,
          provider: row.provider,
          previous_reason: row.disabledReason,
        },
        'channel_recovered',
      );
    } else {
      markChannelDisabledAfterProbe(row.id, result.reason);
      stillDisabled.push(row.id);
      logger.warn(
        {
          channel_id: row.id,
          channel_name: row.name,
          provider: row.provider,
          reason: result.reason,
        },
        'channel_probe_failed',
      );
    }
  }

  if (disabled.length > 0) {
    logger.info(
      {
        scanned: disabled.length,
        recovered_count: recovered.length,
        still_disabled_count: stillDisabled.length,
      },
      'health_checker_tick',
    );
  }

  return { scanned: disabled.length, recovered, stillDisabled };
}

/**
 * 给一个 channel 发探针请求.
 *
 * 探针内容:
 *   { model: enabled_models[0], messages: [{role:'user',content:'ping'}], max_tokens: 1 }
 *
 * 返回 ok=true 当且仅当:
 *   - fetch 没抛网络错;
 *   - status 2xx;
 *   - body 不含 disable 关键字 (classifyError 不返回 disable 类).
 */
async function probe(
  entry: ChannelEntry,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  if (entry.enabledModels.length === 0) {
    return { ok: false, reason: 'no_enabled_models' };
  }
  const adaptor = buildAdaptorForChannel(entry);
  const ir = {
    model: entry.enabledModels[0]!,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  } as Parameters<typeof adaptor.buildRequest>[0];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const endpoint = adaptor.getEndpoint(ir);
    const { headers, body } = adaptor.buildRequest(ir);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    const raw = await resp.text();
    if (!resp.ok) {
      const cls = classifyError({ status: resp.status, body: raw });
      return { ok: false, reason: `probe_${cls.class}: ${cls.reason}` };
    }
    // 即使 200, 也可能是「上游用 200 + error.body 表达失败」
    const cls = classifyError({ status: resp.status, body: raw });
    if (cls.class === 'disable' || cls.class === 'throttle') {
      return { ok: false, reason: `probe_body_${cls.class}: ${cls.reason}` };
    }
    return { ok: true, reason: 'probe_2xx' };
  } catch (err) {
    return { ok: false, reason: `probe_network_error: ${(err as Error).message.slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}
