// SSE 透传主循环 + 反向取消 + 心跳
//
// v0.8 重构: 把 fetch 上游这一步抽到 sse-connect.ts (tryConnectStream).
// 本文件只负责「已连接上游 -> 边读边发给下游」这一段, 不再做 fetch.
// 主路径在 v0.8 里需要在「首字节前重试 / 换 channel」, 这套抽象后职责更清晰:
//
//   主路径流式分支:
//     for (attempt = 0; attempt < MAX; attempt++) {
//       picked = pickChannelForModel(group, model, excludeIds)
//       result = await tryConnectStream(picked.adaptor, ir)
//       if (result.kind === 'connected') {
//         return streamFromConnected({ upstreamResp, upstreamCtrl, adaptor, ... })
//       }
//       // result.kind === 'failed': 根据 classification 决定:
//       //   - transparent: new Response(body, {status}) 直接透传给客户端
//       //   - disable: markChannelDisabled, excludeIds.add, 重试
//       //   - throttle: markChannelDisabled (短期), excludeIds.add, 重试
//       //   - retryable: excludeIds.add, 重试 (不禁用)
//     }
//
// 一旦 streamFromConnected 开始 enqueue 第一个 chunk, 就已经过了「首字节前」窗口:
// 客户端已经收到 200 + 一部分 SSE 数据, 这时再换 channel 会让客户端看到「上半段是
// channel A 的输出, 下半段是 channel B 的输出」, 内容前后矛盾, 必然出戏. 所以一旦
// streamFromConnected 跑起来, 不再做故障转移, 中途出错只能透传 error event.
//
// 反向取消: 网关 fetch 上游时传入 AbortSignal, 客户端断开 -> downstream cancel ->
// upstreamCtrl.abort() -> 上游 fetch 抛 AbortError, undici 关 socket. 这套链路与 v0.7 同.
//
// 心跳: 上游可能在 reasoning 类模型上沉默 30+ 秒. 每 15s 发一行 SSE comment
// (`: keepalive\n\n`), 客户端忽略, 中间代理看到「还有流量」就不会超时.
//
// 参考:
//   - portkey-gateway v1.15.2 src/handlers/streamHandler.ts handleStreamingMode
//   - one-api relay/adaptor/openai/main.go StreamHandler

import type { Context } from 'hono';

import type { ProviderAdaptor } from '../adaptors/base.js';
import type { IRChatRequest } from '../types/ir.js';
import { StreamingTokenCounter } from './counter.js';
import {
  encodeSseChunk,
  extractCompletionText,
  extractUsage,
  SSE_DONE,
  SSE_HEARTBEAT,
} from './event-normalizer.js';
import { tryConnectStream } from './sse-connect.js';

export interface StreamFinalizeInfo {
  promptTokens: number;
  completionTokens: number;
  abortedByClient: boolean;
  upstreamFailed: boolean;
  upstreamStatus: number | null;
  durationMs: number;
}

export interface StreamFromConnectedOptions {
  /** Hono context, 用于返回 Response */
  c: Context;
  /** 已 fetch 成功的上游 Response (2xx + body 非空) */
  upstreamResp: Response;
  /** 上游 fetch 的 AbortController, 反向取消时调 .abort() */
  upstreamCtrl: AbortController;
  /** 选中的上游 adaptor (用 parseStreamChunk / newStreamState) */
  adaptor: ProviderAdaptor;
  /** IR 请求 (stream 已强制 true) */
  ir: IRChatRequest;
  /** 心跳间隔, ms. 默认 15000 */
  heartbeatMs?: number;
  /** preConsume 阶段算过的本地 prompt token, 作为 fallback */
  fallbackPromptTokens: number;
  /** 起始时间戳 (ms), 用于算 durationMs */
  startedAt: number;
  /** 流结束 / 客户端中断 / 上游中途断 时回调, caller 负责 postConsume + commit */
  onFinalize: (result: StreamFinalizeInfo) => void | Promise<void>;
}

/**
 * 「上游已连接, 开始边读边发」.
 *
 * 注意: 调用本函数后, 调用方不应再尝试故障转移 (主路径会拿到这个 Response 立刻发给
 * 客户端, 客户端见到 200 + SSE 帧就是「首字节后」状态, 切 channel 不安全).
 */
export function streamFromConnected(opts: StreamFromConnectedOptions): Response {
  const {
    upstreamResp,
    upstreamCtrl,
    adaptor,
    heartbeatMs = 15000,
    fallbackPromptTokens,
    startedAt,
    onFinalize,
  } = opts;

  let clientAborted = false;
  const counter = new StreamingTokenCounter(opts.ir.model, fallbackPromptTokens);

  if (!upstreamResp.body) {
    // 防御性: 调用方应在 tryConnectStream 里拦截这种情况.
    throw new Error('streamFromConnected: upstreamResp.body is null');
  }
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const adaptorState = adaptor.newStreamState();
  const encoder = new TextEncoder();

  let hbHandle: NodeJS.Timeout | null = null;
  const upstreamStatus = upstreamResp.status;

  const downstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      hbHandle = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_HEARTBEAT));
        } catch {
          /* 已关闭 */
        }
      }, heartbeatMs);

      let upstreamDone = false;
      let upstreamFailed = false;
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            await handleRawEvent(rawEvent);
            if (upstreamDone) break;
          }
          if (upstreamDone) break;
        }
        if (!upstreamDone && buffer.length > 0) {
          await handleRawEvent(buffer);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          upstreamFailed = true;
        }
      } finally {
        if (hbHandle) {
          clearInterval(hbHandle);
          hbHandle = null;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        upstreamCtrl.abort();
      }

      if (clientAborted) {
        counter.markAborted();
      }

      try {
        if (!clientAborted) {
          controller.enqueue(encoder.encode(SSE_DONE));
        }
        controller.close();
      } catch {
        /* 客户端可能在最后一刻断开 */
      }

      const fin = counter.finalize();
      await onFinalize({
        promptTokens: fin.promptTokens,
        completionTokens: fin.completionTokens,
        abortedByClient: fin.abortedByClient,
        upstreamFailed,
        upstreamStatus,
        durationMs: Date.now() - startedAt,
      });

      async function handleRawEvent(rawEvent: string) {
        const lines = rawEvent.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          if (trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;
          const dataRaw = trimmed.slice(5).trim();
          if (dataRaw.length === 0) continue;

          const out = adaptor.parseStreamChunk(dataRaw, adaptorState);
          for (const chunk of out.chunks) {
            const text = extractCompletionText(chunk);
            if (text.length > 0) counter.ingestDelta(text);
            const usage = extractUsage(chunk);
            if (usage) counter.ingestUsage(usage);

            try {
              controller.enqueue(encoder.encode(encodeSseChunk(chunk)));
            } catch {
              clientAborted = true;
              upstreamCtrl.abort();
              return;
            }
          }
          if (out.done) {
            upstreamDone = true;
            return;
          }
        }
      }
    },
    cancel() {
      // 客户端关连接 -> Node http 适配器 cancel 这个 readable
      // -> 反向取消上游 fetch (upstreamCtrl.abort)
      clientAborted = true;
      upstreamCtrl.abort();
      if (hbHandle) clearInterval(hbHandle);
    },
  });

  return new Response(downstream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ============================================================
// 向后兼容: 单 channel 的「fetch + 流式透传」一体化封装
//
// v0.8 主路径不直接用这个, 用 tryConnectStream + streamFromConnected 拼.
// 但 /v1/messages (Anthropic 原生入站) 这种简单透传场景仍然方便, 保留.
// ============================================================

export interface SseProxyOptions {
  c: Context;
  adaptor: ProviderAdaptor;
  ir: IRChatRequest;
  heartbeatMs?: number;
  fallbackPromptTokens: number;
  onFinalize: (result: StreamFinalizeInfo) => void | Promise<void>;
}

export async function proxySSE(opts: SseProxyOptions): Promise<Response> {
  const start = Date.now();
  const result = await tryConnectStream(opts.adaptor, opts.ir);

  if (result.kind === 'failed') {
    await opts.onFinalize({
      promptTokens: opts.fallbackPromptTokens,
      completionTokens: 0,
      abortedByClient: false,
      upstreamFailed: true,
      upstreamStatus: result.status,
      durationMs: Date.now() - start,
    });
    if (result.status === null) {
      return opts.c.json(
        { error: { message: `upstream network error: ${result.body}` } },
        502,
      );
    }
    return new Response(result.body, {
      status: result.status,
      headers: {
        'Content-Type': result.contentType ?? 'application/json',
      },
    });
  }

  return streamFromConnected({
    c: opts.c,
    upstreamResp: result.upstreamResp,
    upstreamCtrl: result.upstreamCtrl,
    adaptor: opts.adaptor,
    ir: opts.ir,
    heartbeatMs: opts.heartbeatMs,
    fallbackPromptTokens: opts.fallbackPromptTokens,
    startedAt: start,
    onFinalize: opts.onFinalize,
  });
}
