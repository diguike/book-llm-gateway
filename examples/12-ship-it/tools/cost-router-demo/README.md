# cost-router-demo

零依赖、独立可运行的成本路由演示. 把主项目 `src/optimization/cost-router.ts` 的核心算法 + 5 个 mock channel 复制进来, 不需要起网关、不需要 DB.

跑一次看到:

1. 5 个 channel 的配置 (cost_priority / priority / weight / 单价 / 模拟可用性);
2. 跑 10 笔同 prompt 的请求, 每笔的选择决策 + fallback 链路;
3. 命中分布: 看 cost-router 是不是真的优先把流量送到最便宜的 channel;
4. 对比: 「平均轮询所有可用 channel」与「按 cost-router 选最便宜」的成本差.

## 运行

```bash
cd tools/cost-router-demo
npm install
npm start
```

## 输出示例 (实测节选)

```
====================================
Channel 配置 (按 cost_priority asc 排序)
====================================
id   name                 cost   prio   weight  input/1M   output/1M    reliability
1    azure-oai-cheap      10     100    5       0.5元      2元          fifty-fifty
2    deepseek-direct      20     100    5       1元        4元          always-ok
3    openai-direct        50     100    5       1.05元     4.32元       always-ok
4    reseller-pool        80     100    3       2元        8元          always-ok
5    emergency-backup     100    50     1       5元        20元         always-down

请求 #1:
  [attempt=0] cost_tier=10 -> azure-oai-cheap (fail)
  [attempt=1] cost_tier=20 -> deepseek-direct (success)
  -> 命中 deepseek-direct (cost_priority=20), 成本 950 微元
...
```

## 关键观察点

- `azure-oai-cheap` (cost_priority=10) 即使 50% 概率失败, 仍然每次先被尝试;
- 失败后 fallback 严格按 cost_priority asc 顺序逐档降级;
- 最贵的 `emergency-backup` 几乎不会被命中 (除非前 4 个都死);
- 「平均轮询」对照组的预期单笔成本通常比 cost-router 实际成本高 30-50%.

## 与主项目的关系

主项目里 `src/optimization/cost-router.ts::pickCheapestChannel` 是这个算法的产品版本: 多了 DB 持久化、健康检查、abilities 反范式索引等. 算法核心 (按 cost_priority 分层 + 同层 weighted 选 + fallback) 与本 demo 一致.
