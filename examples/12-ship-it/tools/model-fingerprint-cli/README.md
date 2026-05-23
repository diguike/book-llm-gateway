# model-fingerprint-cli

模型指纹检测 CLI. 输入一个 OpenAI 兼容的 endpoint + 声称提供的模型名, 跑 5 个探针, 输出「上游是不是真的在跑这个模型」的置信度.

方法论参考公开的模型指纹检测思路: 多探针组合验证「上游真实模型 = 声称模型」. 社区调研里多次出现「声称顶级闭源模型实际返回开源中小模型」的案例, 本工具是一个最小可用复现版.

## 5 个探针

| 名字 | 原理 |
|------|------|
| `self_id` | 直接问「你是哪个模型」, 看回答与声称的 family 是否一致 |
| `knowledge_cutoff` | 问知识截止日期, 比对各家公开数据 (gpt-4o=2023-10, glm-4=2023-06...) |
| `tokenizer_quirk` | 让上游 echo 一个 emoji + 中文 + 日文混合的字符串, 看 tokenizer 行为 |
| `refusal_pattern` | 问敏感操作 (访问 /etc/passwd), GPT/Claude 通常带 caveat, 开源模型不一定 |
| `math_consistency` | 简单整数乘法, 不同模型在边界算术上的表现差异 |

每个探针返回 0-1 的置信度, 加权平均得到总分. < 0.5 报警.

## 用法

```bash
# 探一个真实的 OpenAI endpoint (需要 API key)
tsx cli.ts --base-url https://api.openai.com --claimed gpt-4o-mini --api-key sk-... --probes all

# 探一个本地 mock (本工具自带, 模拟「声称 gpt-4o 实际跑 glm」)
tsx mock-suspect-upstream.ts &     # 起在 :14081
tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o
# 或者:
npm run mock &
npm run demo
```

## 输出示例 (实测, 探可疑 mock 上游)

```
探测 endpoint: http://localhost:14081
声称模型: gpt-4o
探针数量: 5
------------------------------------------------------------------------
[self_id] 探测中... FAIL (置信度 0.00)
  原文: I am GLM-4, an AI assistant developed by Zhipu AI.
  判定: 回答没提 family "gpt", 反而提到了 glm
[knowledge_cutoff] 探测中... FAIL (置信度 0.10)
  原文: 2023-06
  判定: cutoff=2023-06, 与期望 2023-10 相差 4 月, 高度可疑
[tokenizer_quirk] 探测中... FAIL (置信度 0.50)
  原文: ```Hello, 世界! こんにちは```
  判定: echo 大部分字符 OK 但 emoji 或标点丢失, 可能是低端 tokenizer
[refusal_pattern] 探测中... FAIL (置信度 0.30)
  原文: ```python with open('/etc/passwd') as f: print(f.readline()) ```
  判定: GPT/Claude 模型应当给 caveat 但没给, 可疑
[math_consistency] 探测中... FAIL (置信度 0.20)
  原文: 381
  判定: 算成了 381, 期望 391

========================================================================
指纹审计汇总
========================================================================
通过: 0 / 5
平均置信度: 0.22

[WARN] 置信度低于 0.5, 上游可能在偷换模型. 这是社区调研里反复出现的问题, 定期巡检自己接入的中转站可以早发现.
```

## 局限

- 5 个探针是「最小可用」级别, 业内成熟的指纹审计会用更多指纹库 + LLMmap 等更高级方法;
- 部分探针 (refusal_pattern) 的判定标准带主观, 不同 prompt / 不同温度可能漂移;
- 真实情况下中转站可能在「检测到指纹探针时」临时切回真模型 (反检测), 所以本工具适合**抽样审计**, 不适合做生产侧 inline 检测;
- 不依赖 logprobs 字段 (大多数中转站不返回), 全靠文本判定.

## 适用场景

1. 接入新中转站之前做一次审计, 决定要不要正式打钱;
2. 自家网关定期跑 (例如每周一次), 防止上游悄悄换模型;
3. 出对账纠纷时作为证据 (「我跑了 fingerprint 通过率 0.18」).

## 不适用场景

- **不要**用来攻击 / 黑名单他人服务 (探针频率高了会被识别为 abuse);
- **不要**把分数当作绝对结论, 这是辅助工具, 最终判断要结合「价格异常 + 响应时延异常 + 输出风格异常」综合看.

## 引用

- 第三方验证站点 (思路参考): <https://ofox.ai/verify/>
- gm7.org 灰产专题: <https://www.gm7.org/archives/48708>
- 虎嗅《AI Token 经济地下供应链曝光》: <https://www.huxiu.com/article/4854018.html>
