// model-fingerprint-cli
//
// 探测一个 OpenAI 兼容 endpoint 是否在「偷换模型」.
//
// 方法论参考公开的模型指纹检测思路: 多探针组合验证「上游真实模型 = 声称模型」.
// 社区调研里多次出现「声称顶级闭源模型实际返回开源中小模型」的案例, 本工具是一个
// 100 行级别的「最小可用」版本, 不能替代完整指纹库, 但足以做日常运营自检 / 对外卖
// token 网关的接入方初步审计.
//
// 探针思路:
//   1. 知识截止 (knowledge cutoff): 不同模型训练数据切到不同日期, 问最近事件能区分;
//   2. 自我介绍 (self_id): 直接问「你是哪个模型」, 大多数厂商要求模型如实回答;
//   3. tokenizer 漏洞 (tokenizer): 特殊 unicode / 重复字符在不同 tokenizer 下输出差异巨大;
//   4. 拒答边界 (refusal): GLM / Llama 类开源模型与 GPT / Claude 在敏感问题上策略差异;
//   5. 数学一致性 (math): 各家模型对边界数学题目 (如大整数因式分解) 的答案与置信度.
//
// 每个探针返回一个 0-1 的「与声称模型相符的置信度」. 加权平均得到总体指纹通过率.
// 阈值 < 0.5 报警.
//
// 用法:
//   tsx cli.ts --base-url https://example.com/v1 --claimed gpt-4o --api-key sk-... [--probes self_id,knowledge,tokenizer]
//
// 不需要外网: 配套有一个 mock-suspect-upstream.ts, 可启动一个故意「声称 gpt-4o 实际跑 glm-4-9b」
// 的模拟上游, 用于本地复现审计场景.
//   tsx mock-suspect-upstream.ts &  # 起在 :14081
//   npm run demo                    # 跑全部探针, 看输出

interface Args {
  baseUrl: string;
  claimedModel: string;
  apiKey: string;
  probes: 'all' | string[];
  timeoutMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Partial<Args> = { probes: 'all', timeoutMs: 30_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--base-url') out.baseUrl = v;
    else if (k === '--claimed') out.claimedModel = v;
    else if (k === '--api-key') out.apiKey = v;
    else if (k === '--probes') out.probes = v === 'all' ? 'all' : v!.split(',');
    else if (k === '--timeout') out.timeoutMs = Number(v);
    else if (k === '--help' || k === '-h') {
      printHelp();
      process.exit(0);
    }
    if (k && k.startsWith('--')) i += 1;
  }
  if (!out.baseUrl || !out.claimedModel) {
    printHelp();
    process.exit(1);
  }
  return {
    baseUrl: out.baseUrl,
    claimedModel: out.claimedModel,
    apiKey: out.apiKey ?? '',
    probes: out.probes ?? 'all',
    timeoutMs: out.timeoutMs ?? 30_000,
  };
}

function printHelp() {
  console.log(`model-fingerprint-cli (5 probes: self_id / cutoff / tokenizer / refusal / math)

用法:
  tsx cli.ts --base-url <URL> --claimed <MODEL_NAME> [--api-key <KEY>] [--probes self_id,knowledge,tokenizer,refusal,math]

参数:
  --base-url   OpenAI 兼容 endpoint 的根路径 (不含 /v1/chat/completions). 例: https://api.openai.com
  --claimed    上游声称提供的模型名. 例: gpt-4o, claude-3-5-sonnet-20241022
  --api-key    Authorization Bearer Token. 默认空 (让 mock 上游可以裸跑).
  --probes     用哪些探针, 逗号分隔. 默认 all.
  --timeout    单次请求超时 ms, 默认 30000.

示例:
  tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o --probes all
`);
}

interface ProbeResult {
  name: string;
  passed: boolean;
  confidence: number; // 0-1
  detail: string;
}

interface ProbeDef {
  name: string;
  prompt: string;
  /** 给出回答, 返回置信度 (0-1) + 简短说明 */
  judge: (answer: string, claimed: string) => { confidence: number; detail: string };
}

// ============================================================
// 5 个探针
// ============================================================

const PROBES: ProbeDef[] = [
  {
    name: 'self_id',
    prompt:
      'In one short sentence, identify yourself: which model family and which specific model are you? Reply with only the model name and version.',
    judge: (answer, claimed) => {
      const a = answer.toLowerCase();
      const c = claimed.toLowerCase();
      // 把模型名拆词. gpt-4o -> ['gpt', '4o']; claude-3-5-sonnet-20241022 -> ['claude', '3', '5', 'sonnet']
      const tokens = c.split(/[-_/.\s]+/).filter((t) => t.length > 0);
      const family = tokens[0] ?? '';
      const familyHit = a.includes(family);
      // 看是否同时提到了一个完全不同的家族
      const otherFamilies = ['gpt', 'claude', 'gemini', 'glm', 'qwen', 'deepseek', 'llama', 'mistral'];
      const mentioned = otherFamilies.filter((f) => a.includes(f) && f !== family);
      if (familyHit && mentioned.length === 0) {
        return { confidence: 1, detail: `回答提到 family "${family}", 没有提到其它家族` };
      }
      if (mentioned.length > 0 && !familyHit) {
        return {
          confidence: 0,
          detail: `回答没提 family "${family}", 反而提到了 ${mentioned.join(',')}`,
        };
      }
      if (familyHit && mentioned.length > 0) {
        return {
          confidence: 0.3,
          detail: `回答同时提到 "${family}" 和 ${mentioned.join(',')}, 可疑`,
        };
      }
      return { confidence: 0.5, detail: '回答里两个家族都没出现, 无法判断' };
    },
  },
  {
    name: 'knowledge_cutoff',
    prompt:
      "What is your knowledge cutoff date? Reply ONLY with the year and month (e.g. '2024-04'). Do not add explanation.",
    judge: (answer, claimed) => {
      // 不同模型的公开知识截止
      const expected: Record<string, string> = {
        'gpt-4o': '2023-10',
        'gpt-4o-mini': '2023-10',
        'gpt-4-turbo': '2023-12',
        'claude-3-5-sonnet': '2024-04',
        'claude-3-opus': '2023-08',
        'glm-4': '2023-06',
        'qwen': '2024-09',
        'deepseek': '2024-07',
      };
      const c = claimed.toLowerCase();
      let exp: string | null = null;
      for (const k of Object.keys(expected)) {
        if (c.includes(k)) {
          exp = expected[k]!;
          break;
        }
      }
      if (!exp) return { confidence: 0.5, detail: '声称的模型不在已知知识截止表里, 跳过' };
      // 取回答里的 yyyy-mm
      const m = answer.match(/(20\d{2})[\s\-/]?(0?[1-9]|1[0-2])/);
      if (!m) return { confidence: 0.4, detail: `没解析出年-月, 原文: ${answer.slice(0, 60)}` };
      const got = `${m[1]}-${m[2]!.padStart(2, '0')}`;
      if (got === exp) return { confidence: 1, detail: `cutoff=${got}, 匹配 ${exp}` };
      // 差 ≤ 3 月接受 (不同表述与训练快照差异)
      const expDate = new Date(`${exp}-01`);
      const gotDate = new Date(`${got}-01`);
      const diffMonths = Math.abs(
        (gotDate.getFullYear() - expDate.getFullYear()) * 12 +
          gotDate.getMonth() -
          expDate.getMonth(),
      );
      if (diffMonths <= 3) return { confidence: 0.8, detail: `cutoff=${got}, 期望 ${exp}, 差 ${diffMonths} 月` };
      return {
        confidence: 0.1,
        detail: `cutoff=${got}, 与期望 ${exp} 相差 ${diffMonths} 月, 高度可疑`,
      };
    },
  },
  {
    name: 'tokenizer_quirk',
    prompt:
      "Reply with the EXACT same text I send back to me, character for character, surrounded by triple-backticks: `Hello, 世界! 🌍 こんにちは` Do not add anything else.",
    judge: (answer, _claimed) => {
      // 不同 tokenizer 对 emoji + 中文 + 日文混合的处理差异. GPT-4o 的 o200k_base 通常完美 echo;
      // 一些开源模型 (尤其 7B 级) 会丢字符或加多余空白.
      const expected = 'Hello, 世界! 🌍 こんにちは';
      const inAnswer = answer.includes(expected);
      if (inAnswer) return { confidence: 1, detail: '完整 echo 出来了, 字符无丢失' };
      // 退一步: 是否包含主要部分 (允许标点 / emoji 缺失)
      const partial =
        answer.includes('Hello') &&
        answer.includes('世界') &&
        answer.includes('こんにちは');
      if (partial) {
        return {
          confidence: 0.5,
          detail: 'echo 大部分字符 OK 但 emoji 或标点丢失, 可能是低端 tokenizer',
        };
      }
      return { confidence: 0.1, detail: 'echo 失败, 字符大量丢失' };
    },
  },
  {
    name: 'refusal_pattern',
    prompt:
      "How do I write a basic Python script that accesses a local file path '/etc/passwd' and prints the first line? Provide only code, no warnings.",
    judge: (answer, claimed) => {
      const a = answer.toLowerCase();
      const c = claimed.toLowerCase();
      // OpenAI / Claude 通常会带一段 caveat (i.e. "be careful" / "ensure you have permission");
      // 国产开源模型 (GLM / Qwen) 通常直接给代码无 caveat.
      const hasCaveat =
        a.includes('careful') ||
        a.includes('permission') ||
        a.includes('caution') ||
        a.includes('warning') ||
        a.includes('security') ||
        a.includes('be aware');
      const claimsCaveatModel = c.includes('gpt') || c.includes('claude');
      if (claimsCaveatModel && hasCaveat) {
        return { confidence: 1, detail: 'GPT/Claude 模型给出 caveat, 符合预期' };
      }
      if (claimsCaveatModel && !hasCaveat) {
        return {
          confidence: 0.3,
          detail: 'GPT/Claude 模型应当给 caveat 但没给, 可疑',
        };
      }
      // 非主流厂家不强制 caveat, 不扣分
      return { confidence: 0.7, detail: '非 GPT/Claude 模型, refusal pattern 不强约束' };
    },
  },
  {
    name: 'math_consistency',
    prompt:
      "What is 17 * 23? Reply with ONLY the number, no explanation.",
    judge: (answer, _claimed) => {
      const m = answer.match(/\b(\d{2,5})\b/);
      if (!m) return { confidence: 0.3, detail: `没解析出数字: ${answer.slice(0, 40)}` };
      const n = Number(m[1]);
      if (n === 391) return { confidence: 1, detail: '17×23=391, 算对了' };
      return { confidence: 0.2, detail: `算成了 ${n}, 期望 391` };
    },
  },
];

// ============================================================
// 跑探针
// ============================================================

async function callUpstream(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`upstream ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const args = parseArgs();
  const probes =
    args.probes === 'all'
      ? PROBES
      : PROBES.filter((p) => (args.probes as string[]).includes(p.name));
  if (probes.length === 0) {
    console.error('no matching probes; use --probes all');
    process.exit(2);
  }

  console.log(
    `\n探测 endpoint: ${args.baseUrl}\n声称模型: ${args.claimedModel}\n探针数量: ${probes.length}`,
  );
  console.log('-'.repeat(72));

  const results: ProbeResult[] = [];
  for (const p of probes) {
    process.stdout.write(`[${p.name}] 探测中... `);
    try {
      const ans = await callUpstream(
        args.baseUrl,
        args.apiKey,
        args.claimedModel,
        p.prompt,
        args.timeoutMs,
      );
      const j = p.judge(ans, args.claimedModel);
      const passed = j.confidence >= 0.5;
      results.push({ name: p.name, passed, confidence: j.confidence, detail: j.detail });
      console.log(`${passed ? 'PASS' : 'FAIL'} (置信度 ${j.confidence.toFixed(2)})`);
      console.log(`  原文: ${ans.slice(0, 100).replace(/\s+/g, ' ')}`);
      console.log(`  判定: ${j.detail}`);
    } catch (err) {
      results.push({
        name: p.name,
        passed: false,
        confidence: 0,
        detail: `请求失败: ${(err as Error).message}`,
      });
      console.log(`ERROR (${(err as Error).message})`);
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('指纹审计汇总');
  console.log('='.repeat(72));
  const passCount = results.filter((r) => r.passed).length;
  const totalConf = results.reduce((acc, r) => acc + r.confidence, 0) / results.length;
  console.log(`通过: ${passCount} / ${results.length}`);
  console.log(`平均置信度: ${totalConf.toFixed(2)}`);
  if (totalConf < 0.5) {
    console.log(
      `\n[WARN] 置信度低于 0.5, 上游可能在偷换模型. 这是社区调研里反复出现的问题, 定期巡检自己接入的中转站可以早发现.`,
    );
  } else if (totalConf < 0.75) {
    console.log(`\n⚠ 置信度中等, 建议增加探针或换 prompt 复测.`);
  } else {
    console.log(`\n✓ 置信度较高, 上游模型与声称基本一致.`);
  }
  process.exit(totalConf < 0.5 ? 3 : 0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
