// 流式 token 计数器 (v0.7 接进 SSE 主循环)
//
// 这是 Ch5 已经写好的 StreamingTokenCounter (放在 billing/streaming-counter.ts),
// 在 v0.7 被 sse-proxy 接进主循环. 本文件做一次 re-export, 让 streaming/ 目录
// 自成一个内聚的子系统 (sse-proxy / event-normalizer / counter / anthropic-events
// 都在一处), 也避免 sse-proxy 反过来 import billing 形成循环依赖.

export { StreamingTokenCounter, type StreamingFinalize } from '../billing/streaming-counter.js';
