// 第 9 章 v0.9: 看板路由
//
// 路由设计:
//   GET /admin/dashboard          SSR HTML 看板 (浏览器直开)
//   GET /admin/dashboard.json     聚合数据的 JSON (给监控告警 / 自动化用)
//
// 鉴权: 浏览器场景不方便加 Authorization header, 改成「查询字符串 token」.
//   /admin/dashboard?token=<ADMIN_TOKEN>
// 第一次访问需要带, 浏览器记住 URL 后刷新自动复用. 这只是教学场景的简化,
// 生产环境应该改成 cookie + 后台登录 (本书 Ch12 上线整合时处理).
//
// 一致性: 看板的数据全部来自 usage_records 与 channels 表, 与 admin/usage 接口
// 用的是同一份数据源. 这是「全链路 trace_id」设计的副产品 -- 一旦所有请求都把
// channel_id / upstream_latency_ms 落进 usage_records, 看板就不需要单独维护
// 时间序列数据库, 也不需要 metrics exporter.

import { Hono } from 'hono';

import {
  getTodaySummary,
  getLastNDaysSummary,
  getTodayQpsByMinute,
  getTodayCostByUser,
  getTodayCostByModel,
  getTopKeysToday,
  getChannelHealthToday,
  getTopErrorModelsToday,
} from './queries.js';
import { renderDashboardPage } from './render.js';

export function createDashboardRouter(): Hono {
  const app = new Hono();

  // 浏览器访问用. token 走 query string, 方便复制 URL.
  app.use('*', async (c, next) => {
    const expected = process.env.ADMIN_TOKEN ?? '';
    if (!expected) {
      return c.text('ADMIN_TOKEN env var is not configured on server', 500);
    }
    const given = c.req.query('token') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (given !== expected) {
      return c.text('forbidden: pass ?token=<ADMIN_TOKEN> or Authorization header', 403);
    }
    await next();
  });

  app.get('/', (c) => {
    const data = {
      summaryToday: getTodaySummary(),
      summary7d: getLastNDaysSummary(7),
      qpsByMinute: getTodayQpsByMinute(),
      costByUser: getTodayCostByUser(),
      costByModel: getTodayCostByModel(),
      topKeys: getTopKeysToday(10),
      channelHealth: getChannelHealthToday(),
      topErrorModels: getTopErrorModelsToday(5),
    };
    const html = renderDashboardPage(data);
    return c.html(html);
  });

  app.get('/data', (c) => {
    return c.json({
      summary_today: getTodaySummary(),
      summary_7d: getLastNDaysSummary(7),
      qps_by_minute: getTodayQpsByMinute(),
      cost_by_user: getTodayCostByUser(),
      cost_by_model: getTodayCostByModel(),
      top_keys: getTopKeysToday(10),
      channel_health: getChannelHealthToday(),
      top_error_models: getTopErrorModelsToday(5),
    });
  });

  return app;
}
