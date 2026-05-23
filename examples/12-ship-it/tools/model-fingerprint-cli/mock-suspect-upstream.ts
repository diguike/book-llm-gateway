// mock-suspect-upstream
//
// 一个故意「声称是 GPT-4o, 实际像 GLM-4-9B-Chat 表现」的 mock 上游, 用于在没有外网时
// 测试 model-fingerprint-cli. 端口 14081.
//
// 为每个探针 prompt 准备一个「伪装失败」的回答, 让 fingerprint 通过率显著低于 0.5.
// 启动:
//   tsx mock-suspect-upstream.ts &
//   tsx cli.ts --base-url http://localhost:14081 --claimed gpt-4o
//
// 期望输出: 5 个探针中至少 3 个 FAIL, 总置信度 < 0.5.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PORT = Number(process.env.MOCK_SUSPECT_PORT ?? 14081);

interface ChatReq {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

// 把每个探针的 prompt 关键字 -> 一个故意「不像 GPT-4o」的回答
function answerLikeGLM(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('identify yourself') || p.includes('which model')) {
    // 暴露真身: 自称 GLM
    return 'I am GLM-4, an AI assistant developed by Zhipu AI.';
  }
  if (p.includes('knowledge cutoff')) {
    // GLM-4 的截止远早于 GPT-4o 的 2023-10
    return '2023-06';
  }
  if (p.includes('exact same text')) {
    // tokenizer 漏洞: 丢 emoji, 字符变形
    return '```Hello, 世界! こんにちは```';
  }
  if (p.includes('/etc/passwd')) {
    // 不带任何 caveat, 直接给代码 (GPT/Claude 通常会带 caveat)
    return "```python\nwith open('/etc/passwd') as f:\n    print(f.readline())\n```";
  }
  if (p.includes('17 * 23')) {
    // 算错: 简单数学也错
    return '381';
  }
  return 'I do not understand the question.';
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');

  let payload: ChatReq;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  const userPrompt = payload.messages.find((m) => m.role === 'user')?.content ?? '';
  const text = answerLikeGLM(userPrompt);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-suspect-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      // 故意撒谎说是 gpt-4o, 但回答像 GLM
      model: payload.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(userPrompt.length / 4),
        completion_tokens: Math.ceil(text.length / 4),
        total_tokens: Math.ceil((userPrompt.length + text.length) / 4),
      },
    }),
  );
});

server.listen(PORT, () => {
  console.log(`mock-suspect upstream listening on http://localhost:${PORT}`);
  console.log('  (该上游声称提供任意 model, 实际回答像 GLM-4-9B-Chat, 用来验证 fingerprint CLI)');
});
