// Batch 异步通道
//
// 教学版极简 batch:
//   - 请求体里多一个 priority: "low" 字段, 走 batch 通道;
//   - 价格按 prices.batch_input/output 走 (50% 折扣);
//   - 上游不真的发 batch API (那是 OpenAI Files + Batches API 两步), 直接同步发,
//     但只用 supports_batch=true 的 channel, 计费按 batch 单价.
//
// 真实 batch API 流程 (参考 OpenAI 文档 https://developers.openai.com/api/docs/guides/batch):
//
//   1. 客户端把多条 request 拼成 jsonl 文件;
//   2. POST /v1/files upload 文件, 拿到 file_id;
//   3. POST /v1/batches 提交, completion_window: "24h";
//   4. 24 小时内异步执行, 期间客户端 polling 状态;
//   5. 完成后下载结果文件.
//
// 现实情况下中转站 batch 通道有两种实现:
//   a. 真 batch: 把客户端的同步请求攒 5-15 分钟一批, 然后发上游 batch API.
//      用户付出延迟换 50% 单价折扣. 适合: 评分 / 翻译 / 摘要等非交互场景.
//   b. 假 batch: 用一个吃 batch 折扣的「专享 key」(企业账号, 跑闲时计算队列),
//      给前端伪装成同步. 这种实现只是「拿到 batch 价但是同步响应」, 上游不真的走 batch.
//
// Anthropic 也支持 batch (https://docs.anthropic.com/en/api/creating-message-batches),
// 同样 50%, 且与 prompt caching 可以叠加.
//
// 本章 v0.10 的简化版实现 (a) 的雏形:
//   - 网关接受 priority: "low" 字段;
//   - 把请求挂到一个内存队列, 5 秒窗口或攒满 10 条触发 flush;
//   - 选 supports_batch=true 的 channel 同步发;
//   - 计费按 batch 单价.
//
// 不实现 OpenAI 真 batch jsonl 上传 / file_id / polling 完整链路, 教学场景 5 秒窗口
// 已经能看到 50% 折扣的效果. 真要上线读者按 OpenAI 文档接上即可.

import { buildAdaptorForChannel, getChannelRegistry } from '../channels/index.js';
import type { ProviderAdaptor } from '../adaptors/base.js';
import type { IRChatRequest, IRChatResponse } from '../types/ir.js';

/**
 * 单笔 batch 任务. 用一个内存数组管理就够了 (教学场景, 不入 DB).
 */
interface BatchJob {
  id: string;
  ir: IRChatRequest;
  group: string;
  resolve: (resp: IRChatResponse) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const BATCH_WINDOW_MS = Number(process.env.BATCH_WINDOW_MS ?? 5000);
const BATCH_MAX_SIZE = Number(process.env.BATCH_MAX_SIZE ?? 10);

const queueByModel: Map<string, BatchJob[]> = new Map();
let flushHandle: NodeJS.Timeout | null = null;

/**
 * 把一笔请求挂进 batch 队列, 返回一个 Promise.
 * 触发 flush 条件 (任一):
 *   1. 队列长度 >= BATCH_MAX_SIZE;
 *   2. 距离第一笔入队超过 BATCH_WINDOW_MS.
 *
 * 教学简化: 一个模型一个队列. flush 时简单遍历队列逐笔发上游.
 *   真实 batch 应当拼成 jsonl 一次提交, 这里就是为了演示 priority=low 走 supports_batch=true
 *   的 channel + 按 batch 单价计费.
 */
export function enqueueBatchRequest(group: string, ir: IRChatRequest): Promise<IRChatResponse> {
  return new Promise<IRChatResponse>((resolve, reject) => {
    const job: BatchJob = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ir,
      group,
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };

    let q = queueByModel.get(ir.model);
    if (!q) {
      q = [];
      queueByModel.set(ir.model, q);
    }
    q.push(job);

    if (q.length >= BATCH_MAX_SIZE) {
      // 立即 flush 当前模型队列
      void flushModel(ir.model);
      return;
    }

    if (!flushHandle) {
      flushHandle = setTimeout(() => {
        flushHandle = null;
        void flushAll();
      }, BATCH_WINDOW_MS);
    }
  });
}

async function flushAll(): Promise<void> {
  const models = [...queueByModel.keys()];
  await Promise.all(models.map((m) => flushModel(m)));
}

async function flushModel(model: string): Promise<void> {
  const q = queueByModel.get(model);
  if (!q || q.length === 0) return;
  // 取走当前队列
  const batch = q.splice(0, q.length);

  // 选一个 supports_batch=true 的 channel.
  // 教学简化: 取所有支持 batch 的 channel 里 cost_priority 最小的, 不再做 fallback.
  const registry = getChannelRegistry();
  const list = registry.lookup(batch[0]!.group, model).filter((c) => c.supportsBatch);
  if (list.length === 0) {
    for (const j of batch) j.reject(new Error(`no batch-capable channel for model=${model}`));
    return;
  }
  const channel = list.sort((a, b) => a.costPriority - b.costPriority)[0]!;
  const adaptor: ProviderAdaptor = buildAdaptorForChannel(channel);

  // 同步逐笔发 (教学简化, 不拼 jsonl). 真实 batch 是一个上游请求处理 N 笔, 50% 折扣.
  await Promise.all(
    batch.map(async (job) => {
      try {
        const endpoint = adaptor.getEndpoint(job.ir);
        const { headers, body } = adaptor.buildRequest(job.ir);
        const resp = await fetch(endpoint, { method: 'POST', headers, body });
        const text = await resp.text();
        if (!resp.ok) {
          job.reject(new Error(`batch upstream ${resp.status}: ${text.slice(0, 200)}`));
          return;
        }
        const parsed = await adaptor.parseResponse(resp, text);
        job.resolve(parsed);
      } catch (err) {
        job.reject(err as Error);
      }
    }),
  );
}

/** 把整个 batch 系统的状态导出, 供 admin 看板 / 测试用. */
export function batchQueueSnapshot(): Array<{ model: string; pending: number; oldestAgeMs: number }> {
  const now = Date.now();
  return [...queueByModel.entries()].map(([model, q]) => ({
    model,
    pending: q.length,
    oldestAgeMs: q.length > 0 ? now - q[0]!.enqueuedAt : 0,
  }));
}
