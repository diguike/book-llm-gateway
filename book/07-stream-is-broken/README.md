---
title: 第 7 章 SSE 流式透传与反向取消
feishu_url: "https://www.feishu.cn/wiki/XIuJwSVK9i8xRdkbIPocX0HCnbe"
last_synced: "2026-05-16T18:28:58"
---

## 7.1 v0.6 的「流式」是个空壳

v0.6 把限流、配额、计费都补齐了，但有一行代码到现在还卡着主路径:

```ts
if (ir.stream) {
  releaseTpmReservations(limitCtx.tpmReservations);
  return c.json(
    { error: { message: 'streaming is not supported in v0.6; will be added in Ch7' } },
    400,
  );
}
```

凡是带 `stream: true` 的请求, v0.6 直接 400 拒掉。对 chat 类应用这条线根本走不通——用户体验的核心是「打字机感」: 模型边生成边显示，不能等 30 秒一次性吐出几千字。

为什么这条路在前 6 章一直没动。因为流式响应在工程上跟非流式是两套语义:

- 非流式。客户端发请求，上游计算 30 秒，网关 `await fetch` 拿到完整 body, `JSON.parse`, 一次性返给客户端: 整个过程是一个 request/response 对。
- 流式。客户端发请求，上游每生成几个 token 就 flush 一段 SSE event, 网关必须**边收边发**, 整条响应是一串增量帧，跨越几秒到几分钟。

非流式的 `await fetch + text` + `c.json` 这套写法在流式场景下任意一行都会出事:

1. `await fetch` 自身没问题，但 `await response.text()` 会等到上游完整结束，这就退化成了「非流式」——客户端看到的还是 30 秒一次性吐。
2. 计费在流式里要边收边算。客户端中途 Ctrl+C 时，已发出的 token 必须算钱，没发出的不算. 「等响应结束再算」的逻辑在这里直接错位。
3. 反向取消。客户端关闭连接时，网关如果继续 `await reader.read()`, 上游会继续生成 token, 几千个 token 烧出去，谁付。必须把客户端 close 反向传到上游 fetch, 让上游停下来。
4. 中间链路缓冲: Nginx 默认 `proxy_buffering on`, 会把上游分段的 chunk 攒到 4KB 才一次性 flush 给客户端: 这一行配置不关掉，流式响应实际上还是「攒批吐」.

v0.7 要解决的就是这四件事。一段一段拆。

把这四件事拆解到代码层面，实际工程量比想象的小。流式响应不是一个独立的子系统——它复用 Ch2 的 adaptor / Ch3 的归一化器 / Ch5 的 StreamingTokenCounter / Ch6 的 TPM 桶，本章新增的代码主要是「主循环 + 反向取消的胶水」. 但这层胶水不写，前面六章铺好的能力在流式场景下都无法发挥. v0.7 的核心价值是让流式与非流式共享同一份计费 / 限流逻辑，而不是替每个能力再写一份「流式版」.

这种「胶水代码价值大于实现量」的特征，在工程上其实是一个判定标准。一个系统的核心抽象设计得好，适配新场景时的增量代码应该是「胶水」级别的。如果新场景需要重写大半个系统，那是抽象设计有问题. v0.7 增加的代码总量不到 600 行 (含 mock 上游 / stream-test 脚本 / 客户端 demo), 真正的流式核心 sse-proxy.ts 只有 200 行——这从侧面验证 Ch2-Ch6 的抽象方向是正确的。

## 7.2 SSE 协议本身

Server-Sent Events (SSE) 是 HTML5 标准里规定的一套「单向流式响应」协议, WHATWG HTML Living Standard 有定义。但它的实际复杂度只有几条:

**响应头**:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

`Content-Type: text/event-stream` 是核心: 浏览器看到这个 type, EventSource API 自动按 SSE 解析。中间代理 (Nginx / Cloudflare) 看到这个 type, 通常会跳过响应压缩 (`gzip` 会把流量攒批). OpenAI / Anthropic / DeepSeek 流式上游清一色用这个。

**消息体**: 每条事件由几行组成，行末 `\n` 分隔，整条事件以空行 `\n\n` 结尾。

```
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Hello"}}]}\n
\n
data: {"id":"chatcmpl-...","choices":[{"delta":{"content":", world"}}]}\n
\n
```

`data:` 行携带 JSON 字符串. `event:` 行可以指定事件类型 (浏览器 EventSource 按这个分发), 但 OpenAI 兼容上游基本不用. `id:` 与 `retry:` 字段更少用，本书不涉及。

**终止哨兵**: OpenAI 约定流式结束时发一条特殊事件:

```
data: [DONE]\n
\n
```

这不是 SSE 标准的一部分，是 OpenAI 自己加的「显式结束」标志。客户端 SDK (openai-python / openai-node) 看到这一行就停止读。没有这一行，客户端只能靠 TCP FIN 推断结束，体验不一致——所以网关必须替上游补齐这条哨兵。

Anthropic 的语义不同。流到 `message_stop` 事件后 TCP FIN, 不发 `[DONE]`. 这是 6 处协议差异里关于流式的那一处. Ch3 写过的 `AnthropicEventNormalizer` 在 `message_stop` 事件返回 `done: true`, 由网关补一行 `data: [DONE]\n\n` 给客户端，客户端就当成 OpenAI 流式收尾。

**心跳行**: 以 `:` 开头的行是 SSE comment, 客户端解析时会忽略。工程上用它做长连接心跳:

```
: keepalive\n
\n
```

Nginx 默认 `proxy_read_timeout 60s`——上游 60 秒没动静就把连接切了. reasoning 类模型 (o1 / DeepSeek-R1) 在 thinking 阶段可能沉默 90+ 秒，中间链路一切，客户端就拿不到结果: 网关每 15 秒发一行 comment, 中间链路看到「还有流量」，不切。

这五件事就是 SSE 协议本身的全部表面信息。工程上的复杂度不在协议，在「边读边写 + 反向取消 + 边算 token」这三条同时进行。

为什么不用 WebSocket? WebSocket 是双向全双工，流式生成只需要服务端推、客户端听，用 SSE 半双工更简单, HTTP/1.1 既有的代理 / 负载均衡 / 鉴权机制全部能复用。这是 OpenAI / Anthropic / DeepSeek 不约而同选 SSE 的工程原因，而不是它们没考虑过 WebSocket.

为什么不用 HTTP/2 server push? Server push 是 HTTP/2 的「请求未发起就先推内容」，它解决的是页面资源预取场景，与「持续流式响应」不是一回事——HTTP/2 即使在请求响应模式下，也能用 stream frame 实现增量传输 (服务端在一个 stream 上多次写 DATA frame). 实际上 OpenAI 与 Anthropic 的 HTTP/2 接口在协议下层就是用这套，上层语义仍然是 SSE 的 `text/event-stream`. SSE 与 HTTP/2 不是替代关系，而是堆叠关系。

## 7.3 用 ReadableStream 边收边发

Node 20+ 的 `fetch` 返回标准 `Response`, `response.body` 是一个 `ReadableStream<Uint8Array>`. 流式响应的核心操作模式是:

```ts
const upstreamResp = await fetch(endpoint, { method: 'POST', headers, body });
const reader = upstreamResp.body!.getReader();
const decoder = new TextDecoder('utf-8');

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  // 处理 chunk
}
```

`await reader.read()` 在没数据时挂起协程，等上游 flush 一段就唤醒。这是边收边发的物理基础。

但有几条工程纪律必须遵守:

**TextDecoder 一定要传 `{ stream: true }`**. UTF-8 是变长编码，一个 3 字节字符的中间被切成两次 read 是常态。不传 stream 选项, decode 会把残半字符按 U+FFFD 替换字符抛出，客户端拿到一串乱码后无法恢复. `{ stream: true }` 告诉 decoder「保留尾部不完整 byte, 下次接着算」, UTF-8 边界自动对齐。中文场景下这条尤其重要——每个汉字 3 字节, TCP 分片切到中间的概率比英文环境高几倍。

**SSE event 用 `\n\n` 分隔，不是 `\n`**. 一段 chunk 可能跨多个 event, 也可能是一个 event 的开头。标准做法是 buffer 累加 + indexOf:

```ts
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let sep: number;
  while ((sep = buffer.indexOf('\n\n')) >= 0) {
    const rawEvent = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    handleRawEvent(rawEvent);
  }
}
```

`one-api` 用 Go 的 `bufio.Scanner` 配自定义 Split 函数 (`relay/adaptor/openai/main.go:29` 起的 `StreamHandler`), Portkey v1.15.2 用 `buffer.split(splitPattern)` 配 `proxyProvider` 决定的分隔符 (`src/handlers/streamHandler.ts:139` 起的 `readStream`), 两套语义等价，都是基于「在分隔符前的所有 byte 是一个完整 event」.

**写回下游用原生 ReadableStream**, 不要走 Hono 的 `streamSSE` helper. Hono 的 `streamSSE` 在 Node 适配器下用 `TransformStream` + 写一个 readable, 写出去的 stream 在 `@hono/node-server` 的 pull 模型下会触发误判 onAbort——实测在 Node 24 + @hono/node-server 1.13 上，第一个 chunk 写出去后 readable 就被 cancel 一次。这条坑踩过的人会有共鸣，改回原生 ReadableStream + `new Response(rs)` 行为最可预测。

```ts
const downstream = new ReadableStream<Uint8Array>({
  async start(controller) {
    // 边读上游边 enqueue 给下游
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // ...parseChunk -> encodeSseChunk -> controller.enqueue
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  },
  cancel() {
    // 客户端断开 → 反向取消上游
    upstreamCtrl.abort();
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
```

`controller.enqueue` 把 bytes 推进 readable 队列, Node http 适配器拿到就立刻 flush 给客户端 socket. 「边收边发」就是这一行 `enqueue` 在做的事。

`X-Accel-Buffering: no` 是给 Nginx 看的兜底响应头。后面 7.8 节会讲 Nginx 反代的细节，这里先记下。这一行能让 Nginx 针对当前响应单独关闭缓冲，即使运维忘了改全局 `proxy_buffering`, 流式也不会被攒批。

**为什么用 ReadableStream 的 `start` 而不是 `pull`?** Web Streams 标准提供两种回调: `start` 在 stream 创建时立刻调一次, `pull` 在消费者每次想读新数据时调。一般来说 `pull` 更省内存——按需读，不会让生产者跑得比消费者快。但在 SSE 透传场景下，生产者 (上游 fetch 的 reader) 本来就是被动等数据，我们的代码只是把上游 reader 的输出转推到 downstream controller, 中间没有任何「buffer 积压」的可能。用 `start` 一次性把整个 while 循环跑完更直观，也避免了 `pull` 多次回调里管理状态的复杂度。

**chunk size 与 backpressure**. 上游 OpenAI 每个 SSE event 大概 200-500 字节，一秒最多 50 event, 流量峰值约 25KB/s. Node http 的 socket 写缓冲默认 16KB 起步，写得太快也只是积压在内核 buffer, 不会出错。真要做严格 backpressure (例如下游是慢速网络), `controller.enqueue` 在 desiredSize <= 0 时仍然 enqueue, 但生产者应当根据 `controller.desiredSize` 判断要不要 await. 本章不展开这种极端场景，教学示例下不必引入。

## 7.4 AbortController 全链路反向取消

反向取消是流式响应最容易出事故的地方。没做反向取消的网关有一类经典故障。客户端 Ctrl+C 后，上游继续生成 token, 几千个 token 烧出去——客户没收到 (TCP 已断), 但上游账单照计。在「对外卖 token」的场景下这是真金白银的损失。

反向取消的工程实现是一个三段联动:

```
客户端 close TCP
       |
       v
Node http server 检测到 socket 关闭, 调 outgoing.close
       |
       v
@hono/node-server 看到 outgoing.close, 调 reader.cancel
       |
       v
ReadableStream 的 cancel() 回调被触发
       |
       v
我们在 cancel() 里调 upstreamCtrl.abort()
       |
       v
fetch 的 signal 被 abort, undici 关闭上游 TCP socket
       |
       v
上游 (OpenAI / Anthropic / mock) 收到 socket close, 停止生成 token
```

每一节都是被动触发，最上游的客户端 Ctrl+C 是唯一的主动事件: 这种「逐节传播」的设计让每一层都可以独立替换——例如把 Hono 换成 Fastify, 只要 Fastify 的 ReadableStream 也支持 cancel 回调，这条链路就能继续工作。

关键工程动作是「把 AbortController.signal 传给上游 fetch」，然后在自己的 ReadableStream.cancel 里调 `.abort()`:

```ts
const upstreamCtrl = new AbortController();

const upstreamResp = await fetch(endpoint, {
  method: 'POST',
  headers,
  body,
  signal: upstreamCtrl.signal,   // <- 反向取消的物理通路
});

// ...

const downstream = new ReadableStream<Uint8Array>({
  async start(controller) { /* 边收边发 */ },
  cancel() {
    upstreamCtrl.abort();        // <- 客户端 close 触发的反向传播
  },
});
```

实测反向取消是否真的传到上游，最直接的办法是写一个 mock 上游，在 `res.on('close')` 里打日志: 配套代码 `scripts/mock-upstream.ts` 干的就是这件事——它每 250ms 吐一个 chunk, 跑 10 个 chunk 共 2.5 秒。客户端用 `stream-test.ts` 跑 `--abort-after-chunks 3`, 收到 3 个 chunk 后主动 abort, 看 mock 日志:

```
WARN: mock_aborted_by_client id=chatcmpl-mock-...
WARN: mock_stop_early_due_to_abort id=... chunks_sent=2
```

`mock_aborted_by_client` 这条日志能打出来，反向取消就跑通了。没这条日志就是某一节断了，要逐节排查。

踩过一个具体的坑: mock 上游最初用 `req.on('close')` 监听客户端断开. Node http 把 `req.on('close')` 设计成「请求 stream 关闭」事件，而 POST 请求的 body 在 curl `-d ...` 发完后，客户端 half-close 写半边，这个事件就会误触发——所有正常的 POST 请求都被当成 abort. 正确的写法是监听**响应**的 close:

```ts
res.on('close', () => {
  if (!res.writableEnded) {
    // 真的是客户端断开, 不是 res.end() 正常关闭
    aborted = true;
  }
});
```

`res.writableEnded` 在调用 `res.end()` 后才是 true, 用它做判定就能区分「正常结束」与「客户端中途关闭」. 这条边角写在 mock 里，也写在生产网关里——任何要监听客户端断开的代码都要走这套。

Portkey v1.15.2 的 `handleStreamingMode` (`src/handlers/streamHandler.ts:300` 起。也用 `TransformStream` + 后台 async fn 的模式，但它在 finally 里调 `writer.close()`, 反向取消依赖 Cloudflare Workers 的 `executionCtx.waitUntil` 配合 signal 传播，不是显式的 AbortController. 本书的 Node.js 选型决定了必须用显式 AbortController——这是单机部署最稳妥的写法。

**反向取消还有一个时间窗口的边角**: 客户端在 fetch 还没拿到响应头时就 close, 与已经开始读 body 时 close, 走两条不同的代码路径. fetch 阶段 close 会让 `await fetch()` 抛 AbortError, 我们在 try/catch 里把 reservation refund 掉，不进入 streamSSE 流程. body 读取阶段 close 会通过 downstream readable 的 cancel 触发 upstreamCtrl.abort, 然后流式终态走 canceled. 两条路径在配套代码 `sse-proxy.ts` 的 try/catch 与 ReadableStream.cancel 两处分别处理，代码里能清楚看到这两条路。

**多副本部署下的反向取消**. 单机 Node 进程里 AbortController 是进程内的，跨副本不需要传递。但 Ch12 上线整合时讨论的「多副本 + 负载均衡」场景下，客户端连的是 LB, 后面随机选一个副本 A 处理这次请求: 客户端 close 时 LB → 副本 A, 反向取消信号只在副本 A 内闭环——这没问题，因为这次请求的整条状态都在副本 A 上 (fetch 上游、计费、TPM 桶都是进程内). 也就是说反向取消不依赖跨副本的共享状态，这是单机内存方案在工程上的另一个隐性优势。

## 7.5 Anthropic 流式 6 事件接入 SSE 主循环

Ch3 已经写过 `AnthropicEventNormalizer`, 它把 Anthropic 的 6 种流式事件 (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`) 状态机式地压成 OpenAI delta chunk 数组. v0.7 要做的事情是把这个归一化器接进 SSE 主循环。

接口在 `adaptors/base.ts` 上加了三个钩子:

```ts
export interface ProviderAdaptor {
  // ... v0.2/v0.3 的方法

  /** 构造流式 fetch 的 headers + body. 强制 stream=true. */
  buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string };

  /** 创建 adaptor 自管的流式状态对象. */
  newStreamState(): StreamState;

  /** 把一行 raw SSE data 翻译成统一格式的 OpenAI delta chunk. */
  parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput;
}
```

OpenAI 实现 (`adaptors/openai.ts`) 几乎是透传, raw line 直接 `JSON.parse`:

```ts
parseStreamChunk(rawLine: string, _state: StreamState): StreamChunkOutput {
  const line = rawLine.trim();
  if (line === '[DONE]') return { chunks: [], done: true };
  const parsed = JSON.parse(line) as OpenAIDeltaChunk;
  return { chunks: [parsed], done: false };
}
```

Anthropic 实现 (`adaptors/anthropic.ts`) 把 raw event 喂给归一化器:

```ts
newStreamState(): StreamState {
  // 跨多个事件维护 id / model / promptTokens / block 类型映射,
  // 用 class 实例做状态承载.
  return { normalizer: new AnthropicEventNormalizer() };
}

parseStreamChunk(rawLine: string, state: StreamState): StreamChunkOutput {
  const event = JSON.parse(rawLine) as AnthropicStreamEvent;
  const normalizer = state.normalizer as AnthropicEventNormalizer;
  const out = normalizer.push(event);
  return { chunks: out.chunks, done: out.done };
}
```

`AnthropicEventNormalizer.push()` 内部按当前事件类型分发: `message_start` 提取 id/model/promptTokens, 同时发出一个 `{role:'assistant', content:''}` 首块 (与 OpenAI 首块对齐); `content_block_delta` 按 delta type 分发到 OpenAI 的 `content` / `tool_calls[].function.arguments` / `reasoning_content` 三条通路; `message_stop` 返回 `done: true`. 完整实现在 Ch3 写过, v0.7 直接 import 用。

主循环这一层完全不知道上游是 OpenAI 还是 Anthropic——它只调 `adaptor.parseStreamChunk(line, state)`, 拿到统一格式的 OpenAI delta chunk, 然后 `controller.enqueue(encodeSseChunk(chunk))` 发给下游: 跨家协议的差异全部封装在 adaptor 里，主循环干干净净。

one-api 在 `relay/adaptor/anthropic/main.go:249` 起的 `StreamHandler` 是同一套思路: scanner 按行扫 SSE, `data:` 前缀剥掉后 JSON.unmarshal 成 Anthropic 事件，调 `StreamResponseClaude2OpenAI` 翻译成 OpenAI chunk, 通过 `render.ObjectData(c, response)` 写回 gin 的 http response. 区别只在「Go 用 bufio.Scanner, TS 用 ReadableStream.getReader + TextDecoder」.

为什么 Anthropic 上游用 `Accept: text/event-stream` 请求头。官方 API 默认会按 JSON 返回，必须显式声明客户端能接 SSE 才会开始流式. OpenAI 上游不挑这一行，但 Anthropic 会查。

## 7.6 流式 token 计数器接入计费闭环

非流式场景下 token 计数走的是「`await response.text()` 拿到完整 body, JSON.parse 抽 `usage` 字段」这套。流式场景下 token 是「边收边累加」:

```
chunk 1 -> 累加 1 token (本地 tiktoken 估算)
chunk 2 -> 累加 1 token
...
chunk N -> 上游可能在最后一个 chunk 送 usage: { prompt_tokens: ..., completion_tokens: ... }
          -> 用上游真实值校准本地累加值
```

`StreamingTokenCounter` 在 Ch5 已经写好, v0.7 把它接进 SSE 主循环:

```ts
const counter = new StreamingTokenCounter(ir.model, fallbackPromptTokens);

// 在每个归一化 chunk 到达时:
const text = extractCompletionText(chunk);
if (text.length > 0) counter.ingestDelta(text);

const usage = extractUsage(chunk);
if (usage) counter.ingestUsage(usage);

// 流结束 (含中断) 时:
const fin = counter.finalize();
// fin.promptTokens / fin.completionTokens / fin.abortedByClient
```

`extractCompletionText` 在 `streaming/event-normalizer.ts`, 它从一个 OpenAI chunk 里抽出所有 completion 相关的文本:

```ts
export function extractCompletionText(chunk: OpenAIDeltaChunk): string {
  let text = '';
  for (const ch of chunk.choices ?? []) {
    const delta = ch.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (typeof delta.reasoning_content === 'string') text += delta.reasoning_content;
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const args = tc.function?.arguments;
        if (typeof args === 'string') text += args;
      }
    }
  }
  return text;
}
```

三条通路全要算 token: `content` 是普通文本, `reasoning_content` 是 DeepSeek reasoner / Anthropic thinking 的内部推理, `tool_calls[].function.arguments` 是工具调用参数: 上游对这三种通通收费，网关也都要算。

**让上游送 usage**. OpenAI 的流式默认不送 usage, 必须在请求里加 `stream_options.include_usage: true`. 这一行在 `OpenAIAdaptor.buildStreamRequest` 里自动注入:

```ts
buildStreamRequest(ir: IRChatRequest): { headers: Record<string, string>; body: string } {
  const streamIR: IRChatRequest = {
    ...ir,
    stream: true,
    stream_options: { include_usage: true, ...(ir as { stream_options?: object }).stream_options },
  } as IRChatRequest;
  return {
    headers: {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(streamIR),
  };
}
```

不主动注入这一行, OpenAI 流式响应只会送 delta, 不送 usage, 网关只能用本地 tiktoken 估算——估算与上游真实 usage 通常差 1-3%, 计费上是真金白银的偏差。

Anthropic 不一样，它每个 `message_delta` 事件都带 `usage.output_tokens`, 网关不需要主动要求。

**为什么 fallback 到本地 tiktoken 仍然不可省**? OpenAI 上游虽然送 usage, 但有几个边角必须用本地兜底:

1. 客户端中途断开。上游可能还没送出 usage 事件 (usage 一般在最后一个 chunk), 网关只能用本地累加值;
2. 上游异常 (例如 OOM 中途断连). 同样没有 usage 事件;
3. 非标准上游 (一些早期 OpenAI 兼容的国产模型不支持 stream_options.include_usage). 本地兜底是唯一选择。

`StreamingTokenCounter.finalize()` 的优先级是「上游 usage 优先，没有就用本地累加」，这套两路对账机制在所有边角下都能给出一个合理的 token 数，计费链路不会因为「没拿到 usage」而崩。

中断场景 (canceled / partial) 下本地估算与上游真实 usage 的偏差通常 < 5%, 由 Ch5 的两阶段计费多退少补机制自动消化——预扣按 max_tokens 上界扣得足够多，实结按估算值返回，用户最多被多算几个 token (微元级), 不会出现「按 1000 token 收钱实际只生成 200 token」这种宏观偏差。

**为什么 prompt_tokens 也要兜底**? 流式响应的 prompt_tokens 是上游 chat 模型对输入的真实计数，与本地 tiktoken 估算通常差 1-3%. 但有两类情况差更多:

1. 多模态请求 (含图片). 本地 tiktoken 估算 image_url 用固定 85 token, 上游真实可能 200-2000 token (按图片分辨率). 差距 10x 起步。
2. 工具调用历史 (tools 字段 + tool_results). 本地估算简化处理，上游真实把整个 JSON schema + tool_call 历史按各家私有 tokenizer 算。

对计费精度要求高时，应当尽量让上游送 usage. preConsume 阶段必须用本地估算 (没办法，还没调上游), 但 postConsume 阶段优先用上游真实值。两阶段计费的「多退少补」机制把估算偏差自然消化掉，这是 Ch5 的设计目的之一。

## 7.7 三种终态: finalized / canceled / partial

非流式场景下一次请求的终态只有三种:

- `finalized`: 正常结束, postConsume 实结;
- `refunded`: 上游失败 (5xx / 网络错), 全额退回，不计费;
- `failed`: 主路径异常 (postConsume 自身报错), 余额已扣留待人工对账。

流式场景多出两态:

- `canceled`: 客户端中途 Ctrl+C / 关连接。已发出的 token 计费入账，多扣的部分退回;
- `partial`: 上游中途异常断 (TCP 错 / 上游 OOM). 同样已收到的 token 计费，多扣的部分退回。

`canceled` 与 `partial` 在计费上完全等价 (都是「按已发出的实际值实结」), 拆成两个 status 是为了 Ch9 看板能按状态聚合——`canceled` 比例反映客户端行为质量 (用户经常半路放弃说明 prompt 质量有问题), `partial` 比例反映上游稳定性。不拆的话，一个 `finalized` 标签什么信息都看不出来。

实现在 `billing/calculator.ts` 新加一个 `postConsumeStream` 函数，与 `postConsume` 流程几乎完全一致，仅差在最后写入 status 时取的是入参 `terminalStatus`:

```ts
export function postConsumeStream(
  input: PostConsumeInput & { terminalStatus: 'finalized' | 'canceled' | 'partial' },
): PostConsumeOutput {
  // ... 与 postConsume 完全一致的 promptCost / completionCost / balanceDelta 计算

  db.update(usageRecords)
    .set({
      // ...
      status: input.terminalStatus,
      finalizedAt: now,
    })
    .where(eq(usageRecords.id, input.recordId))
    .run();

  return { /* ... */ };
}
```

主路径在 sse-proxy 的 `onFinalize` 回调里决定走哪个分支:

```ts
onFinalize: async (fin) => {
  // A) 上游根本没建立 (DNS / 401 / TCP RST 等)
  if (fin.upstreamStatus === null) {
    refundReservation(reservation.recordId, 'stream_upstream_unreachable');
    releaseTpmReservations(limitCtx.tpmReservations);
    return;
  }

  // B/C/D: 都进入 postConsumeStream, 区别仅在 terminalStatus
  const terminal: 'finalized' | 'canceled' | 'partial' = fin.upstreamFailed
    ? 'partial'
    : fin.abortedByClient
      ? 'canceled'
      : 'finalized';

  const settle = postConsumeStream({
    recordId: reservation.recordId,
    userId: auth.userId,
    model: ir.model,
    provider: adaptor.name,
    realPromptTokens: fin.promptTokens,
    realCompletionTokens: fin.completionTokens,
    terminalStatus: terminal,
  });
  commitTpmReservations(
    limitCtx.tpmReservations,
    fin.promptTokens + fin.completionTokens,
  );
  commitMonthlyUsage(auth.keyId, settle.finalCost);
},
```

四条分支:

- 上游建立失败 (upstreamStatus null): 全额退 + 释放 TPM, 整条请求等同于「没花一分钱」;
- 上游 [DONE] / message_stop, 客户端没断: finalized, 用上游真实 usage 实结;
- 客户端 Ctrl+C: canceled, 用「上游已发出的 token 累加值」实结;
- 上游流读到中途断: partial, 用「已收到的 token 累加值」实结。

**Ch6 TPM 的对账在这里收口**. `commitTpmReservations(reservations, actualTotal)` 调用时, `actualTotal = promptTokens + completionTokens` 是真实总用量。如果中途取消, `actualTotal` 是已发出的部分, TPM 桶把「预扣 - 实际」的差额自动退回 (commitTpm 的多退少补语义). 这就是 Ch6 章末预告的「流式 TPM 闭环」.

**Ch6 月度配额的累加也在这里收口**. `commitMonthlyUsage(auth.keyId, settle.finalCost)` 把这次请求真实花的钱累加到 `keys.monthly_used_micro`. canceled / partial 也照常累加——已发出的 token 真的烧到了上游账户，必须计入月度配额。

one-api 在流式场景下走的是「StreamHandler 内部把 usage 累加值写回 ctx, 调用方在 `relay/controller/helper.go` 的 `PostConsumeQuota` 里实结」，不区分 canceled / partial / finalized——所有流式中断都隐式落到 finalized. 这套设计对计费够用，但对看板分析丢失了状态信息。本书拆开三态，是为了让 Ch9 的看板能按状态做透视。

**为什么 canceled 也要计费?** 直觉上「客户端没收到完整答复，为什么要收钱」是个公平问题: 但工程上:

1. 上游已经生成了那些 token, 实际消耗了算力，上游账单一定会算。网关如果不向用户收，这部分成本网关自己承担——商业上不可持续;
2. 「按已发出的实际值」收，已经体现了对客户端中断行为的友好——没断的话用户要付更多。计费公平性是基于「真实消耗」，不是「客户端的主观满意度」;
3. 不收费会产生反向激励。客户端可以故意每次只读 1 个 chunk 就关连接，网关每次都不收费，但实际上每次都让上游烧了一段 token. 这种漏洞在对外卖 token 场景下会被人主动利用。

OpenAI 自家也是这套语义: 客户端 close 时上游已经生成的 token 全部计费。官方流式 API 文档 ([platform.openai.com/docs/api-reference/chat-streaming](https://platform.openai.com/docs/api-reference/chat-streaming)) 明确说 stream chunk 一旦产生就计入 usage, 客户端断开不会触发回退。这一点跟客户端 SDK 的体验设计完全无关，计费是基础设施侧的硬规则。

**finalized 的两种形态**. OpenAI 流式 finalized 时 `finish_reason` 有 `stop` / `length` / `tool_calls` / `content_filter` 四种值. Anthropic 的 `stop_reason` 是 `end_turn` / `max_tokens` / `stop_sequence` / `tool_use`, 通过 `stopReasonToFinishReason` 函数 (Ch3 写的。映射回 OpenAI. 计费链路不关心 finish_reason 的具体值，只关心 status 是不是 `finalized`. finish_reason 在 Ch9 看板里用作错误率分析的细分维度 (例如 content_filter 高说明 prompt 风险).

**failed 与 partial 的区别**. partial 是「上游开始生成，中途出错」，已发出的 token 计费; failed 是「postConsume 自身出错」(例如 DB 异常), 余额已扣但没法写入 record 实结。两者的处理路径完全不同: partial 是用户接受的正常状态, failed 需要运营人工对账。本书把 failed 保留为非流式的兜底状态，流式分支没显式出现 failed——但 postConsumeStream 自身异常时，主路径会 catch 并标 failed (与非流式同一套), 这条边角在 sse-proxy 的 onFinalize 外层 try/catch 处理。

## 7.8 Nginx 反代

到这里网关侧的工程已经齐了。但实际部署的网关大概率挂在 Nginx 反代后面 (TLS 终止 / 域名分发 / 多副本负载均衡). Nginx 默认的 `proxy_buffering on` 会把流式响应攒批，这是反代场景下最常见的「流式不工作」原因。

`nginx.conf.example` 给出关键三行:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;

    # 关掉响应缓冲: 上游一个 chunk 进来立刻 flush 给客户端
    proxy_buffering off;
    # 也关掉请求缓冲, 让上游 (本机网关) 立刻拿到客户端的 close 信号
    proxy_request_buffering off;

    # 长流式响应 (reasoning 模型可能 1 分钟沉默) 不能被超时切断
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
```

`proxy_buffering off` 是最关键的一条。不加这一条, Nginx 会把上游 (本机网关。的每段 chunk 暂存在内存缓冲区，攒到 4KB (默认 `proxy_buffer_size`) 才一次性 flush 给客户端: 流式打字机的体验直接被吃掉。

`proxy_request_buffering off` 影响反向取消。默认开启时, Nginx 会先把客户端的 POST body 完整缓冲在自己这边再转发给后端。这意味着客户端 close TCP 后, Nginx 还在「替客户端发请求」，后端拿不到 close 信号，反向取消断在中间链路。

`proxy_read_timeout 90s` 配合网关侧的 15s 心跳——心跳每 15s 写一行, Nginx 看到「还有流量」就重置超时计时. 90s 是 6 个心跳周期的余量。

我们的网关响应头还带了 `X-Accel-Buffering: no`. 这是 Nginx 专门为「按响应单独关闭缓冲」设计的字段，即使 location 块里忘了加 `proxy_buffering off`, Nginx 看到这个响应头也会针对该响应禁用缓冲。双保险，缺一条都能工作。

Cloudflare 走另一套——它自己识别 `Content-Type: text/event-stream` 自动绕开 minify / compression, 但需要在 Workers / Pages 配置里把 `Enable Streaming` 打开 (默认开). Cloudflare 文档明确说。流式响应不能加 `Content-Encoding: gzip`, 否则会被攒批。我们的网关没主动加压缩，这条天然满足。

**HTTP/2 与 HTTP/1.1 在 Nginx 反代下的差异**. HTTP/2 多路复用一个 TCP 连接传多个并发请求，流式响应在 HTTP/2 下走 DATA frame 增量传输，默认就是「边收边发」的语义，不需要 chunked transfer encoding. 但 Nginx 在 `proxy_pass http://127.0.0.1:3000` 时使用 HTTP/1.1 跟后端通信 (除非显式开 `proxy_http_version 2`, 而 Node http server 也得开 HTTP/2 配套——配置链非常长). 实际部署中绝大多数 Nginx → Node 的反代仍走 HTTP/1.1 + chunked, 所以 `proxy_buffering off` 这一条必须显式加。

**`Connection: keep-alive` 的两层语义**. 这个响应头在 SSE 场景下的字面意思是「服务端不主动关闭 TCP, 等客户端 close」，但它的关键作用是在中间代理 (Nginx) 看到时，不会触发「响应结束就关连接」的优化路径: 如果不加，某些代理会在第一个 chunk 发完后尝试 close TCP, 后续 chunk 全部丢失。

## 7.9 端到端验证

把全套跑起来。一个 terminal 起 mock 上游，另一个起网关，再一个跑客户端。

启动 mock 上游 (每 250ms 一个 chunk, 跑 10 个 chunk):

```bash
cd examples/07-stream-is-broken
npm install
npm run mock     # 监听 :4010
```

启动网关:

```bash
npm run migrate
npm run start    # 监听 :3000
```

建一把 Key (跟 Ch6 一样):

```bash
ADMIN_TOKEN=test-admin-token-12345
BASE=http://localhost:3000

curl -sS -X POST $BASE/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Acme"}'
curl -sS -X POST $BASE/admin/users -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"orgId":1,"name":"alice","balanceCny":100}'
GW_KEY=$(curl -sS -X POST $BASE/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"userId":1,"name":"streamer"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'])")
```

**场景 1: 正常流式完成**

```bash
npx tsx src/scripts/stream-test.ts \
  --base $BASE --key $GW_KEY --model mock-gpt-4o-mini \
  --prompt "tell me a story"
```

客户端输出 (实测):

```
[stream-test] http status=200 content-type=text/event-stream; charset=UTF-8
[stream-test] first delta at +611ms
Hello, world! This is a mock streaming response from the upstream.
[stream-test] finish_reason=stop
[stream-test] upstream usage: prompt=3 completion=17
[stream-test] received [DONE]
```

`first delta at +611ms`——网关在收到上游第一帧后 611ms 内就推到客户端，不是攒到结束才一次性吐。这是流式响应工作的最直接证据。

`upstream usage: prompt=3 completion=17`——上游送了 usage, 网关用真实值校准，余额扣的是 `(3 * input_price + 17 * output_price) * multiplier`, 多扣的部分退回。

`stream_settled` 日志 (网关侧):

```
INFO stream_settled
  trace_id: 53d15562a3d86aae5eaf7b9e1386e952
  terminal_status: finalized
  prompt_tokens: 3
  completion_tokens: 17
  final_cost_micro_cny: 71
  balance_delta_micro_cny: 963
  duration_ms: 2569
```

`balance_delta_micro_cny: 963`——这次预扣 1033 µCNY (按 max_tokens=256 估算), 实际只花 70 µCNY, 退回 963 µCNY. 多退少补在流式上同样工作。

**场景 2: 客户端中途 Ctrl+C, 反向取消**

```bash
npx tsx src/scripts/stream-test.ts \
  --base $BASE --key $GW_KEY --model mock-gpt-4o-mini \
  --prompt "another story" \
  --abort-after-chunks 3
```

客户端:

```
[stream-test] http status=200 content-type=text/event-stream; charset=UTF-8
[stream-test] first delta at +303ms
Hello, world
[stream-test] aborting after 3 chunks (simulated Ctrl+C)
```

收到 3 个 chunk 后客户端主动 `controller.abort()`, fetch 抛 AbortError, 进程退出。这一刻:

- 客户端 TCP socket FIN;
- 网关侧 `@hono/node-server` 的 outgoing.close 触发;
- 网关侧 downstream readable 的 cancel() 被调;
- cancel() 里 `upstreamCtrl.abort()` 触发;
- 网关侧 fetch 抛 AbortError, undici 关闭与 mock 的 TCP socket;
- mock 侧 `res.on('close')` 触发，打日志 `mock_aborted_by_client`, 停止后续 setTimeout.

mock 日志 (实测):

```
WARN: mock_aborted_by_client id=chatcmpl-mock-1778792125207
WARN: mock_stop_early_due_to_abort id=... chunks_sent=2
```

网关日志:

```
INFO stream_settled
  trace_id: 21f5c0f805ca76a88ac6065531b047f2
  terminal_status: canceled
  prompt_tokens: 9
  completion_tokens: 3
  final_cost_micro_cny: 21
  balance_delta_micro_cny: 1012
  duration_ms: 520
```

`terminal_status: canceled`, completion_tokens=3 (已发出的 3 个 chunk 累加值), final_cost=21 µCNY. 多扣的 1012 µCNY 退回. usage_records 里这一行:

```sql
sqlite3 data/gateway.db \
  "SELECT id, status, prompt_tokens, completion_tokens, final_cost, pre_reserved_cost FROM usage_records ORDER BY id DESC LIMIT 1;"
-- 10|canceled|9|3|21|1033
```

`canceled` 计费完整落账. 「已用部分计费，多扣的退回」这条工程纪律在客户端中断场景下成立。

**场景 3: 上游 fetch 阶段就失败 (上游 Key 没配)**

把 OPENAI_API_KEY 留作默认值 `sk-replace-me`, 跑一个真实路由:

```bash
curl -i -N -X POST $BASE/v1/chat/completions \
  -H "Authorization: Bearer $GW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

输出:

```
HTTP/1.1 502 Bad Gateway
Content-Type: application/json

{"error":{"message":"upstream network error: fetch failed"}}
```

网关日志:

```
WARN stream_refunded_no_output
  trace_id: b32dade4b1d6713f811c0d53ef71909b
  record_id: 11
  upstream_status: null
  duration_ms: 259
```

usage_records:

```
11|refunded|0|0|0|147
```

`status: refunded`, final_cost=0. 上游 fetch 阶段就失败的情况下，预扣的 147 µCNY 全额退回，跟非流式上游失败的语义完全一致。

三种场景对应 usage_records 的三种终态:

| 场景 | status | prompt | completion | final_cost | 余额对账 |
|------|--------|--------|-----------|-----------|---------|
| 正常完成 | finalized | 3 | 17 | 71 µCNY | 退回 963 µCNY |
| 客户端中断 | canceled | 9 | 3 | 21 µCNY | 退回 1012 µCNY |
| 上游不可达 | refunded | 0 | 0 | 0 | 退回 147 µCNY |

三态都跑通，流式计费闭环就成立了。

**为什么要构造 mock 上游而不是直接打真实 OpenAI?** 三个原因:

1. 真实 OpenAI 每次请求都花钱，验证流程不可能跑几十次;
2. 真实 OpenAI 的网络抖动会污染验证信号——某次 fetch 失败不一定是网关 bug;
3. 反向取消的验证需要观察「上游能不能感知到 abort」，真实 OpenAI 给不到这个信号，必须在自己控制的 mock 进程里打日志才能确认。

Mock 上游 50 行代码，单 Node 进程，每个请求模拟「先送 role 首块，然后每 250ms 送一个 content delta, 跑 10 个 chunk 后送 usage + [DONE]」，同时监听 `res.on('close')` 打 `mock_aborted_by_client` 日志: 这套 mock 既可以验证完整流程，也可以验证反向取消，一次到位。

**生产环境怎么验证?** 真要上线后做端到端测试，推荐两条:

1. 短暂跑 `stream-test` 对真实 OpenAI 上游，看延迟分布 (first delta 时间 / chunk 间隔抖动). 用真上游验证「网关不引入额外延迟」;
2. 用 `--abort-after-chunks 3` 跑几次后看上游账单——如果反向取消有效，这几次请求的 token 数应当远小于 max_tokens; 如果反向取消失效，上游会按 max_tokens 上限全部生成完，账单偏差能从 dashboards 上看出来。

**性能压测**. 单进程 Node 在流式场景下的极限取决于内存与上下文切换。单连接的 SSE 透传内存占用约 8KB (TextDecoder + buffer + ReadableStream), 1 万个并发 SSE 连接约 80MB 内存，一台 4GB 机器轻松挂。但实际瓶颈在事件循环——每个连接每秒大约触发 50 次 reader.read() + enqueue, 1 万连接就是 50 万次/秒, Node 单线程跑不动。实际项目 1000-3000 并发 SSE 是合理上限，再大要上多副本。

## 7.10 v0.7 之后还差什么

v0.7 完成的能力清单:

- SSE 协议透传: `text/event-stream` 响应头 + `data:` 行格式 + `[DONE]` 哨兵 + `: keepalive` 心跳;
- 原生 `fetch + ReadableStream + TextDecoder` 边收边发;
- AbortController 全链路反向取消 (客户端 close → downstream.cancel → upstreamCtrl.abort → 上游 fetch 终止);
- Anthropic 6 事件归一化器接入 (Ch3 写好的 normalizer + adaptor 三钩子);
- 流式 token 边收边算 + 上游 usage 校准 (`stream_options.include_usage` 自动注入);
- 三态终态: finalized / canceled / partial, 对应不同业务语义但共享同一份计费逻辑;
- TPM 实结 + 月度配额累加: Ch6 的接口在流式终止时自然咬合;
- Nginx 反代关键配置 + `X-Accel-Buffering: no` 兜底响应头。

但 v0.7 仍然挂在一根细线上——全网关只有**一把上游 Key**.

- 这把 Key 触发上游风控 (返 401 + `unauthorized` body): 所有流式请求立刻被切，后续每一次新请求继续命中同一把 Key, 继续 401, 无自动恢复;
- 上游 5xx 抖动 (典型: OpenAI us-east-1 maintenance window): 同样，所有流式被中断，客户端看到一片 502;
- 单 provider 限速被打满。上游本身的分钟级 TPM 配额耗尽时，网关收到 429 透给客户端，但「换一个 Key / 换一个 provider 重试」的逻辑没有。

这三种故障的共同特征是。故障发生在「单一资源」层面 (一个 Key / 一个 provider), 而网关没有任何故障转移机制: 在企业基建场景下意味着所有内部用户被影响，在对外卖 token 场景下意味着 SLA 违约——运维人员需要手动改配置 + 重启服务，半夜被叫起来的工单往往就是这一类。

v0.8 引入贯穿全书的第四个核心领域对象 `Channel` (渠道). 一个 model 背后可挂多个 channel (同 provider 多 Key, 或不同 provider 的等价模型), 按权重 / 优先级轮询。错误分类器区分「4xx 业务错」「5xx 可重试错」「被风控类自动禁用错」三种处理路径: 后台健康检查定期探活，被禁用的 channel 在恢复后自动重新加入轮询。

同步处理 Ch7 埋的边角——**流式响应过程中渠道挂掉**的两段式。首字节前可重试 (上游连接失败时换 channel 重发，客户端还没拿到任何 SSE 帧，切上游对客户端透明), 已开始输出只能透传错误给客户端 (流到一半切 channel 会导致客户端收到截断的内容，不可恢复，必须把 error event 透给下游让 SDK 自己处理). 这两条规则在 Ch8 章节里展开。

## 配套代码

完整可运行的 v0.7 代码在 `examples/07-stream-is-broken/`. 目录结构:

```
src/
  index.ts                          # (new) 主路径增加 stream 分支 -> proxySSE
  streaming/                        # (new) 本章核心
    sse-proxy.ts                    # SSE 透传主循环 + 反向取消 + 心跳
    event-normalizer.ts             # OpenAI / Anthropic chunk 统一接口
    counter.ts                      # re-export Ch5 StreamingTokenCounter
    anthropic-events.ts             # 沿用 Ch3
  adaptors/
    base.ts                         # (new) 接口加 3 个流式钩子
    openai.ts                       # (new) buildStreamRequest / parseStreamChunk
    anthropic.ts                    # (new) 流式归一化接入
    deepseek.ts                     # 继承自 openai, 无需改
  billing/calculator.ts             # (new) 新增 postConsumeStream (三态)
  scripts/
    mock-upstream.ts                # (new) 演示 + 反向取消验证
    stream-test.ts                  # (new) 流式客户端 + abort 模拟
  (其余沿用 v0.6)
client/index.html                   # (new) 10 行打字机 demo
nginx.conf.example                  # (new) 反代关键配置
```

`npm install && npm run migrate && npm run start` 启动。配套 mock 上游 `npm run mock` 起在另一个 terminal. 跑 `npx tsx src/scripts/stream-test.ts --base http://localhost:3000 --key sk-gw-XXX --model mock-gpt-4o-mini --abort-after-chunks 3` 看反向取消跑通——客户端在第 3 个 chunk 后断开, mock 进程打 `mock_aborted_by_client`, usage_records 落账 status=canceled, partial cost (本次 21 µCNY) 入账，多扣的 1012 µCNY 退回。

## 下一章预告

v0.7 之后，网关在流式场景下做到了三件事。客户端看到打字机 (SSE 真透传), 客户端 Ctrl+C 时上游立刻停 (反向取消), 已发出的 token 按真实值计费 (三态终态). 但全网关仍然依赖单一上游 Key——上游返 401 (风控) / 5xx (维护窗口) / 限速 (账号 TPM 配额满。时，没有任何自动恢复机制: 运维半夜手动改配置重启服务，在企业基建场景下影响所有内部用户，对外卖 token 场景下意味着 SLA 违约。

第 8 章引入 `Channel` (渠道。概念。一个 model 背后挂多个 channel, 按权重 / 优先级轮询。错误分类器区分可重试 / 自动禁用 / 透传给客户端三种路径: 后台健康检查定期探活恢复被禁用的渠道。同步处理 Ch7 埋的边角——流式响应过程中渠道挂掉的两段式 (首字节前可重试 / 已开始输出只能透传错误).

---

> 本章来自《AI Token 中转站实战：从 0 搭建企业级 LLM 网关》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-llm-gateway](https://github.com/diguike/book-llm-gateway)
