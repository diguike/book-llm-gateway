# prompt-cache-demo

零依赖、独立可运行的 prompt caching 演示. 起一个内嵌的 HTTP 上游, 实现两套缓存语义:

- **Anthropic 显式 cache_control** (cache read = 0.1x input);
- **OpenAI 自动 prefix 缓存** (cached_tokens = 0.5x input).

跑一次看到:

1. 同一个 prompt 第一次调用 (冷) 与第二次调用 (热) 的 token / 成本对比;
2. Anthropic 写入溢价 (1.25x) vs 读取折扣 (0.1x) 的具体数字;
3. 一个反例: 在 prompt 前加 trace_id, 缓存命中率归零.

## 运行

```bash
cd tools/prompt-cache-demo
npm install
npm start
```

## 输出示例 (实测)

```
mock prompt-cache 上游 listening on http://localhost:14080

========================================================================
Anthropic 显式 cache_control 演示 (cache_read = 0.1x input)
========================================================================
第 1 次 (冷调): prompt=66 (cached_read=0 cached_write=63) completion=6 cost=2701 微元
第 2 次 (命中): prompt=66 (cached_read=63 cached_write=0) completion=6 cost=853 微元

→ 第 2 次比第 1 次节省 1848 微元 (68.4%).

========================================================================
OpenAI 自动 prefix 缓存演示 (cached_tokens = 0.5x input)
========================================================================
第 1 次 (冷调): prompt=346 (cached_read=0 cached_write=0) completion=5 cost=386 微元
第 2 次 (命中): prompt=346 (cached_read=64 cached_write=0) completion=5 cost=355 微元

→ 第 2 次比第 1 次节省 31 微元 (8.0%).

反例: 在 prompt 前面加 trace_id (网关层错误做法), 缓存命中归零
破坏 prefix 后: prompt=358 (cached_read=0 cached_write=0) completion=5 cost=399 微元
```

## 关键观察点

- Anthropic 的 5min cache_write 是 1.25x input 单价 (写入溢价), cache_read 是 0.1x. 在 system prompt 长 + 高频复用场景, 第二次起就能省 60-80%;
- OpenAI 的自动缓存只对 ≥1024 token 的 prefix 生效, 单价折扣 0.5x. 短 prompt 没有任何缓存收益;
- 网关层任何对 prompt 前缀的「装修」(加 trace_id / timestamp / 请求计数) 都会 100% 破坏命中, 必须严格透传.

## 价格参考

- Anthropic Prompt Caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI Prompt Caching: <https://openai.com/index/api-prompt-caching/>
- DeepSeek Context Caching: <https://api-docs.deepseek.com/news/news0802>
- Gemini caching pricing: <https://ai.google.dev/gemini-api/docs/pricing>
