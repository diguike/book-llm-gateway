// /healthz: liveness 探针
//
// 语义: 进程还活着, 事件循环没卡死. 不检查依赖 (DB / 上游 / channel).
// k8s 上 liveness 失败会触发 pod 重启 -- 所以只能放「重启能解决」的检查.
//
// 实现: 直接返回 200 + 一个时间戳. 任何更复杂的逻辑都属于 readiness, 不属于 liveness.

import { Hono } from 'hono';

interface LivenessResponse {
  ok: true;
  uptime_s: number;
  ts: string;
}

const startedAt = Date.now();

export function createLivenessRouter(): Hono {
  const app = new Hono();
  app.get('/', (c) =>
    c.json<LivenessResponse>({
      ok: true,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      ts: new Date().toISOString(),
    }),
  );
  return app;
}
