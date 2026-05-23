// 流式上游连接的「首字节前」阶段
//
// 这一层从 v0.7 的 sse-proxy 里抽出来, 单独成为一个步骤. 原因 (回到 Ch7 章末埋的边角):
//
//   流式响应过程中渠道挂掉的两段式处理:
//     - 首字节前 (还没把任何 SSE 帧 enqueue 给客户端): 上游 fetch 失败 / 响应非 2xx,
//       我们还来得及换 channel 重试. 客户端只是在等响应头, 切上游对它完全透明.
//     - 已开始 stream: 客户端已经收到一部分 chunk 了, 这时换 channel 会导致 content
//       前后不连贯 (不同模型 / 不同 Key 生成的下半段). 这种情况只能把 error event
//       透给客户端, 让客户端 SDK 自己处理. 切 channel 是不可接受的.
//
// 「首字节前」具体定义为: fetch(endpoint).then(resp) 拿到的 Response 还没开始把它的 body
// 转发到下游 ReadableStream. 一旦下游 ReadableStream 的 start() 回调里执行了第一次
// controller.enqueue, 就过了「首字节前」的窗口.
//
// 本文件只负责「首字节前」的部分: fetch + 状态码判定. 拿到「已连接成功」的上游 Response
// 之后, 交回主路径, 由 sse-proxy 继续做边读边发.
//
// 错误分类返回值结构与 channels/classifier.ts 一致, 主路径根据 class 决定下一步:
//   - retryable / throttle: 换下一个 channel 重试 (excludeIds 累加当前 id);
//   - disable: 把当前 channel 标 disabled, 然后换 channel;
//   - transparent: 不切 channel, 直接透传给客户端.

import { classifyError, type ClassifyResult } from '../channels/classifier.js';
import type { ProviderAdaptor } from '../adaptors/base.js';
import type { IRChatRequest } from '../types/ir.js';

export type StreamConnectResult =
  | {
      kind: 'connected';
      /** 上游已建立连接, 状态 2xx, body 是流式 SSE 字节. 交回 sse-proxy 继续读 */
      upstreamResp: Response;
      /** 这次连接的 AbortController. 客户端断开时由 sse-proxy 调 .abort() */
      upstreamCtrl: AbortController;
    }
  | {
      kind: 'failed';
      /** 错误分类结果, 主路径据此决定换 channel 重试 / 透传给客户端 / 禁用 channel */
      classification: ClassifyResult;
      /** 上游 HTTP 状态码, 网络层错时为 null */
      status: number | null;
      /** 上游响应体 (字符串). transparent 类透传给客户端时直接 new Response(body, {status}) */
      body: string;
      /** 上游 content-type, transparent 透传时一并带上 */
      contentType: string | null;
    };

/**
 * 试着连一个上游, 只完成「fetch + 状态码判定」. 不做边读边发.
 *
 * 成功 (status 2xx + body 非空): 返回 connected, 调用方继续把它喂给 sse-proxy 主循环.
 * 失败 (网络错 / 4xx / 5xx / body 关键字命中): 返回 failed, 调用方据 classification 决定下一步.
 */
export async function tryConnectStream(
  adaptor: ProviderAdaptor,
  ir: IRChatRequest,
): Promise<StreamConnectResult> {
  const endpoint = adaptor.getEndpoint(ir);
  const { headers, body } = adaptor.buildStreamRequest(ir);

  const upstreamCtrl = new AbortController();

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: upstreamCtrl.signal,
    });
  } catch (err) {
    const e = err as Error;
    return {
      kind: 'failed',
      classification: classifyError({ status: null, networkError: e }),
      status: null,
      body: e.message,
      contentType: null,
    };
  }

  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text();
    return {
      kind: 'failed',
      classification: classifyError({ status: upstreamResp.status, body: errBody }),
      status: upstreamResp.status,
      body: errBody,
      contentType: upstreamResp.headers.get('content-type'),
    };
  }

  if (!upstreamResp.body) {
    return {
      kind: 'failed',
      classification: classifyError({ status: upstreamResp.status, body: '' }),
      status: upstreamResp.status,
      body: 'upstream returned empty body',
      contentType: upstreamResp.headers.get('content-type'),
    };
  }

  return { kind: 'connected', upstreamResp, upstreamCtrl };
}
