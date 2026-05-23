// SSE 透传主循环 + 反向取消 + 心跳
//
// 工作流程:
//
//                    +-----------------+
//   Client SSE ----> | ReadableStream  | <---- enqueue
//                    +-----------------+         ^
//                            |                   |
//                            v                   |
//                    +-----------------+         |
//                    | sse-proxy loop  | --------+ enqueue 归一化后的 chunk
//                    +-----------------+
//                            |
//                            v
//                    +-----------------+
//                    | upstream fetch  |
//                    | (signal=ctrl)   |
//                    +-----------------+
//                            ^
//                            |
//   Client close <===========+============ AbortController.abort()
//
// 反向取消的关键: 网关 fetch 上游时传入 AbortSignal, 客户端断开 (Node http
// 适配器把 cancel 信号传给我们的 ReadableStream) 时 controller.abort(), 上游
// 立刻收到 ConnectionReset, 不再继续生成 token.
//
// 心跳: 上游可能在 reasoning 类模型上沉默 30+ 秒. 中间链路 (Nginx default
// proxy_read_timeout = 60s) 会切断空闲连接. 我们每 15s 发一行 SSE comment
// (`: keepalive\n\n`), 客户端忽略, 中间代理看到「还有流量」就不会超时.
//
// 实现选型: 不用 Hono 的 streamSSE helper, 因为它在 Node 适配器下会因为
// transform/pull 机制导致 readable 早期 cancel (实测在 Node 24 + @hono/node-server
// 1.13 上, 第一个 chunk 后 onAbort 就误触发). 改用原生 ReadableStream + new Response,
// 行为最可预测.
//
// 参考:
//   - portkey-gateway v1.15.2 src/handlers/streamHandler.ts handleStreamingMode
//     (TransformStream + reader.read 边读边 enqueue);
//   - one-api relay/adaptor/openai/main.go StreamHandler (bufio.Scanner 按行
//     扫描 data: 前缀 + [DONE] 哨兵);
//   - one-api relay/adaptor/anthropic/main.go StreamHandler (Anthropic SSE
//     按行扫 + StreamResponseClaude2OpenAI 翻译).

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

export interface SseProxyOptions {
  /** Hono context, 拿 c.req.raw.signal 与 streamSSE */
  c: Context;
  /** 选中的上游 adaptor */
  adaptor: ProviderAdaptor;
  /** IR 请求 (stream 已强制 true) */
  ir: IRChatRequest;
  /** 心跳间隔, ms. 默认 15000 */
  heartbeatMs?: number;
  /** preConsume 阶段算过的本地 prompt token, 作为 fallback */
  fallbackPromptTokens: number;
  /**
   * 流结束 (或客户端中断) 回调. 主循环把 finalize 结果交给 caller, caller 负责
   * postConsume + commitTpm + commitMonthlyUsage (主路径已有这套链路, 不在
   * sse-proxy 内调).
   */
  onFinalize: (result: {
    promptTokens: number;
    completionTokens: number;
    abortedByClient: boolean;
    upstreamFailed: boolean;
    upstreamStatus: number | null;
    durationMs: number;
  }) => void | Promise<void>;
}

/**
 * SSE 透传主循环.
 *
 * 行为:
 *   1. AbortController 接到客户端 signal, fetch 上游;
 *   2. 上游响应非 2xx -> 直接把 error JSON 透给下游 (按 SSE 包一层),
 *      upstreamFailed=true, completionTokens=0;
 *   3. 上游 ReadableStream + TextDecoder, 按 \n\n 切 event, 每个 event 提
 *      `data: ...` 行 -> adaptor.parseStreamChunk -> 归一化的 OpenAI chunk;
 *   4. 每个归一化 chunk: extractCompletionText 喂给 counter; extractUsage 校准;
 *   5. 主循环把 chunk 发回下游 (encodeSseChunk);
 *   6. 上游 done (OpenAI [DONE] / Anthropic message_stop) -> 写 [DONE] -> finalize;
 *   7. 客户端 close (ReadableStream cancel 触发) -> stop reading -> finalize with abortedByClient=true.
 */
export async function proxySSE(opts: SseProxyOptions): Promise<Response> {
  const { c, adaptor, ir, heartbeatMs = 15000, fallbackPromptTokens, onFinalize } = opts;

  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildStreamRequest(ir);

  // 上游 AbortController. 客户端断开时 .abort(), 上游 fetch 抛 AbortError.
  const upstreamCtrl = new AbortController();
  let clientAborted = false;

  const start = Date.now();
  const counter = new StreamingTokenCounter(ir.model, fallbackPromptTokens);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: upstreamCtrl.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    await onFinalize({
      promptTokens: fallbackPromptTokens,
      completionTokens: 0,
      abortedByClient: aborted && clientAborted,
      upstreamFailed: !aborted,
      upstreamStatus: null,
      durationMs: Date.now() - start,
    });
    if (aborted) {
      return c.json({ error: { message: 'client closed before upstream connected' } }, 499 as 500);
    }
    return c.json({ error: { message: `upstream network error: ${(err as Error).message}` } }, 502);
  }

  // 上游非 2xx 直接透传 (网关与客户端约定: 错误响应保留原 status 与 body)
  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text();
    await onFinalize({
      promptTokens: fallbackPromptTokens,
      completionTokens: 0,
      abortedByClient: false,
      upstreamFailed: true,
      upstreamStatus: upstreamResp.status,
      durationMs: Date.now() - start,
    });
    return new Response(errBody, {
      status: upstreamResp.status,
      headers: { 'Content-Type': upstreamResp.headers.get('content-type') ?? 'application/json' },
    });
  }

  if (!upstreamResp.body) {
    await onFinalize({
      promptTokens: fallbackPromptTokens,
      completionTokens: 0,
      abortedByClient: false,
      upstreamFailed: true,
      upstreamStatus: upstreamResp.status,
      durationMs: Date.now() - start,
    });
    return c.json({ error: { message: 'upstream returned empty body' } }, 502);
  }

  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const adaptorState = adaptor.newStreamState();
  const encoder = new TextEncoder();

  // 构造自定义的 ReadableStream, cancel 回调 = 客户端关连接 -> 反向取消上游 fetch
  let hbHandle: NodeJS.Timeout | null = null;
  let upstreamStatus = upstreamResp.status;

  const downstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 心跳: 每 heartbeatMs 发一行 comment
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

      // 发 [DONE]
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
        durationMs: Date.now() - start,
      });

      async function handleRawEvent(rawEvent: string) {
        const lines = rawEvent.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          if (trimmed.startsWith(':')) continue; // SSE comment / 心跳
          if (!trimmed.startsWith('data:')) continue;
          const dataRaw = trimmed.slice(5).trim();
          if (dataRaw.length === 0) continue;

          const out = adaptor.parseStreamChunk(dataRaw, adaptorState);
          for (const chunk of out.chunks) {
            // 1. 喂 counter
            const text = extractCompletionText(chunk);
            if (text.length > 0) counter.ingestDelta(text);
            const usage = extractUsage(chunk);
            if (usage) counter.ingestUsage(usage);

            // 2. 写回下游
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

  // 直接返回 Response, 不走 streamSSE
  return new Response(downstream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // 让 Nginx 反代不缓冲 (见 nginx.conf.example)
      'X-Accel-Buffering': 'no',
    },
  });
}
