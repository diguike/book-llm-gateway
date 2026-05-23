// cost-router-demo
//
// 完全独立的零依赖 demo, 复制了主项目 cost-router.ts 的核心算法 + 5 个 mock channel,
// 演示「按 cost_priority asc 选最便宜可用 channel + fallback 决策」.
//
// 跑 `npm start`, 看到:
//   1. 5 个 channel 的配置打印;
//   2. 每个请求选哪个 channel + 为什么选;
//   3. 主路径失败的 fallback 链路;
//   4. 五个 channel 各自的单价 + 同一笔 prompt 的实际成本对比.

interface MockChannel {
  id: number;
  name: string;
  costPriority: number; // 越小越便宜
  priority: number;
  weight: number;
  // 单价 (元 / 1M tokens), 与主项目默认表对齐
  inputCnyPer1M: number;
  outputCnyPer1M: number;
  // 模拟可用性: 50% 概率失败 / always-down / always-ok
  reliability: 'always-ok' | 'fifty-fifty' | 'always-down';
}

const CHANNELS: MockChannel[] = [
  {
    id: 1,
    name: 'azure-oai-cheap',
    costPriority: 10,
    priority: 100,
    weight: 5,
    inputCnyPer1M: 0.5, // Azure enterprise commit
    outputCnyPer1M: 2.0,
    reliability: 'fifty-fifty', // 偶尔限流, 演示 fallback
  },
  {
    id: 2,
    name: 'deepseek-direct',
    costPriority: 20,
    priority: 100,
    weight: 5,
    inputCnyPer1M: 1.0,
    outputCnyPer1M: 4.0,
    reliability: 'always-ok',
  },
  {
    id: 3,
    name: 'openai-direct',
    costPriority: 50,
    priority: 100,
    weight: 5,
    inputCnyPer1M: 1.05,
    outputCnyPer1M: 4.32,
    reliability: 'always-ok',
  },
  {
    id: 4,
    name: 'reseller-pool',
    costPriority: 80,
    priority: 100,
    weight: 3,
    inputCnyPer1M: 2.0,
    outputCnyPer1M: 8.0,
    reliability: 'always-ok',
  },
  {
    id: 5,
    name: 'emergency-backup',
    costPriority: 100,
    priority: 50,
    weight: 1,
    inputCnyPer1M: 5.0,
    outputCnyPer1M: 20.0,
    reliability: 'always-down', // 永远失败, 兜底用
  },
];

interface PickedChannel {
  channel: MockChannel;
  tier: { costPriority: number; priority: number };
}

/**
 * cost-router 核心算法: 按 (cost_priority asc, priority desc) 分层, 同层加权随机.
 * excludeIds 用于失败重试时跳过已试过的 channel.
 */
function pickCheapestChannel(
  channels: MockChannel[],
  excludeIds: Set<number>,
): PickedChannel | null {
  const candidates = channels.filter((c) => !excludeIds.has(c.id));
  if (candidates.length === 0) return null;

  // 按 cost_priority asc 分层, 同层按 priority desc
  const sorted = [...candidates].sort((a, b) => {
    if (a.costPriority !== b.costPriority) return a.costPriority - b.costPriority;
    return b.priority - a.priority;
  });

  let i = 0;
  while (i < sorted.length) {
    const tierCost = sorted[i]!.costPriority;
    const layer: MockChannel[] = [];
    while (i < sorted.length && sorted[i]!.costPriority === tierCost) {
      layer.push(sorted[i]!);
      i++;
    }
    // 同层加权随机
    const totalWeight = layer.reduce((acc, c) => acc + Math.max(0, c.weight), 0);
    if (totalWeight <= 0) continue;
    let r = Math.random() * totalWeight;
    for (const c of layer) {
      r -= Math.max(0, c.weight);
      if (r <= 0) {
        return { channel: c, tier: { costPriority: c.costPriority, priority: c.priority } };
      }
    }
    return {
      channel: layer[layer.length - 1]!,
      tier: { costPriority: layer[0]!.costPriority, priority: layer[0]!.priority },
    };
  }
  return null;
}

// 模拟「发请求到上游」的结果
function simulateUpstream(channel: MockChannel): 'success' | 'fail' {
  if (channel.reliability === 'always-down') return 'fail';
  if (channel.reliability === 'always-ok') return 'success';
  // fifty-fifty
  return Math.random() < 0.5 ? 'success' : 'fail';
}

/** 算一次请求在指定 channel 上的成本 (微元), 输入 / 输出 token 数固定 */
function computeCost(channel: MockChannel, promptTokens: number, completionTokens: number): number {
  const inputPerToken = (channel.inputCnyPer1M * 1_000_000) / 1_000_000;
  const outputPerToken = (channel.outputCnyPer1M * 1_000_000) / 1_000_000;
  return Math.ceil(promptTokens * inputPerToken + completionTokens * outputPerToken);
}

function pad(s: string | number, width: number, align: 'left' | 'right' = 'left'): string {
  const str = String(s);
  if (str.length >= width) return str.slice(0, width);
  const pad = ' '.repeat(width - str.length);
  return align === 'left' ? str + pad : pad + str;
}

function header(title: string) {
  const line = '='.repeat(72);
  console.log(`\n${line}\n${title}\n${line}`);
}

// ============================================================
// Demo 1: 5 个 channel 的配置 + 单价对比
// ============================================================
function demoSetup() {
  header('Channel 配置 (按 cost_priority asc 排序)');
  console.log(
    `${pad('id', 4)} ${pad('name', 20)} ${pad('cost', 6)} ${pad('prio', 6)} ${pad('weight', 7)} ${pad('input/1M', 10)} ${pad('output/1M', 11)} ${pad('reliability', 14)}`,
  );
  console.log('-'.repeat(72));
  const sorted = [...CHANNELS].sort((a, b) => a.costPriority - b.costPriority);
  for (const c of sorted) {
    console.log(
      `${pad(c.id, 4)} ${pad(c.name, 20)} ${pad(c.costPriority, 6)} ${pad(c.priority, 6)} ${pad(c.weight, 7)} ${pad(c.inputCnyPer1M + '元', 10)} ${pad(c.outputCnyPer1M + '元', 11)} ${pad(c.reliability, 14)}`,
    );
  }
}

// ============================================================
// Demo 2: 跑 10 笔同 prompt 的请求, 看选择决策 + fallback 链路
// ============================================================
function demoPick(rounds: number) {
  header(`跑 ${rounds} 笔请求, 每笔 prompt=300 token / completion=200 token`);
  const promptTokens = 300;
  const completionTokens = 200;
  let totalCost = 0;
  let totalAttempts = 0;
  const hitCount: Map<number, number> = new Map();

  for (let i = 1; i <= rounds; i++) {
    const tried = new Set<number>();
    const trace: string[] = [];
    let finalChannel: MockChannel | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const picked = pickCheapestChannel(CHANNELS, tried);
      if (!picked) {
        trace.push('no more channels');
        break;
      }
      totalAttempts += 1;
      const result = simulateUpstream(picked.channel);
      trace.push(
        `[attempt=${attempt}] cost_tier=${picked.tier.costPriority} -> ${picked.channel.name} (${result})`,
      );
      if (result === 'success') {
        finalChannel = picked.channel;
        break;
      }
      tried.add(picked.channel.id);
    }

    const cost = finalChannel ? computeCost(finalChannel, promptTokens, completionTokens) : 0;
    totalCost += cost;
    if (finalChannel) {
      hitCount.set(finalChannel.id, (hitCount.get(finalChannel.id) ?? 0) + 1);
    }

    console.log(`\n请求 #${i}:`);
    for (const t of trace) console.log(`  ${t}`);
    if (finalChannel) {
      console.log(
        `  -> 命中 ${finalChannel.name} (cost_priority=${finalChannel.costPriority}), 成本 ${cost} 微元`,
      );
    } else {
      console.log(`  -> 全部 channel 失败, refund`);
    }
  }

  header('汇总');
  console.log(`总请求: ${rounds}`);
  console.log(`总上游尝试 (含失败重试): ${totalAttempts}`);
  console.log(`总成本: ${totalCost} 微元 (avg ${Math.round(totalCost / rounds)} 微元/请求)`);
  console.log('\nChannel 命中分布:');
  for (const c of CHANNELS) {
    const n = hitCount.get(c.id) ?? 0;
    if (n > 0) {
      const pct = ((n / rounds) * 100).toFixed(0);
      console.log(`  ${pad(c.name, 22)} ${pad(n, 3)} 次 (${pct}%)`);
    }
  }

  // 对照: 如果不走 cost-router, 而是平均轮询所有 healthy channel, 成本会是多少
  const healthyCosts = CHANNELS.filter((c) => c.reliability !== 'always-down').map((c) =>
    computeCost(c, promptTokens, completionTokens),
  );
  const avgRoundRobin =
    healthyCosts.reduce((a, b) => a + b, 0) / healthyCosts.length;
  console.log(
    `\n对照: 平均轮询所有可用 channel 的预期成本 ${Math.round(avgRoundRobin)} 微元/请求.`,
  );
  console.log(
    `本次 cost-router 实际平均 ${Math.round(totalCost / rounds)} 微元/请求, 节省 ${(
      ((avgRoundRobin - totalCost / rounds) / avgRoundRobin) *
      100
    ).toFixed(1)}%.`,
  );
}

// ============================================================
// 主入口
// ============================================================
demoSetup();
demoPick(10);
