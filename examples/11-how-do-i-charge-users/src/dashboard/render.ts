// 第 9 章 v0.9: 看板 HTML 渲染 (纯字符串拼)
//
// 不引入任何前端框架. 理由:
//
//   1. 看板的本质是「把聚合查询结果摊到表格里」, React / Vue 这种 UI 框架在这件事
//      上没有任何价值, 反而要引一堆构建工具;
//   2. SSR HTML 加 <meta http-equiv="refresh" content="30"> 已经满足「每 30 秒自动
//      刷新一次」的运营需求, 不需要 WebSocket / SSE 推送;
//   3. 教学场景下纯字符串拼能让读者一行行看清「这个表格是怎么从 SQL 来的」, 比组件树
//      更直观.
//
// XSS 防御: 任何来自 DB 的字符串字段都过 escapeHtml. 数字 / 时间走 toLocale 之后
// 不需要再 escape (Number / Date toString 不含 <>). channel.name / disabled_reason
// 这些是从 admin 接口写进去的字符串, 必须 escape.
//
// 单位换算: 微元 -> 元 一律 / 1_000_000, 看板显示两位小数. token 直接整数显示.
// 延迟显示用 ms; > 1000 ms 才转 s.

import type {
  CostByDimension,
  KeyUsageRow,
  ChannelHealthRow,
  ModelErrorRow,
  QpsBucket,
  DashboardSummary,
} from './queries.js';

/**
 * 转义 HTML 危险字符. 五个标准实体, 与 OWASP cheat sheet 一致.
 * 不用第三方 html-escaper, 是因为这一段代码本身简单到不值得引依赖.
 */
export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return '';
  const s = String(input);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCny(microCny: number | null | undefined): string {
  if (microCny === null || microCny === undefined) return '0.00';
  return (microCny / 1_000_000).toFixed(4);
}

function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ============================================================
// QPS sparkline (ASCII bar chart)
// ============================================================
// 把当天每分钟的请求数渲染成一行 sparkline. 优势: 一眼能看出峰值时间分布,
// 不需要图表库. 缺点: 文字对齐依赖等宽字体, 看板 CSS 已经强制 monospace.

function renderQpsSparkline(buckets: QpsBucket[]): string {
  if (buckets.length === 0) {
    return '<div class="empty">今日还没有请求</div>';
  }
  const max = Math.max(...buckets.map((b) => b.count));
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const peakHint = `（最高一分钟 ${max} 次）`;
  // 一行显示最近 60 个数据点 (= 1 小时), 太长会换行
  const recent = buckets.slice(-60);
  const bars = recent
    .map((b) => {
      const ratio = max === 0 ? 0 : b.count / max;
      const idx = Math.min(blocks.length - 1, Math.floor(ratio * blocks.length));
      return `<span title="${escapeHtml(b.minute)} = ${b.count}">${blocks[idx]}</span>`;
    })
    .join('');
  const head = recent[0]?.minute ?? '';
  const tail = recent[recent.length - 1]?.minute ?? '';
  return `<div class="sparkline">${bars}</div>
    <div class="sparkline-axis"><span>${escapeHtml(head)}</span><span>${escapeHtml(tail)}</span></div>
    <div class="sparkline-hint">${escapeHtml(peakHint)}</div>`;
}

// ============================================================
// 各 section 渲染
// ============================================================

function renderSummary(summary: DashboardSummary, longSummary: DashboardSummary): string {
  return `
  <section class="summary">
    <div class="card">
      <div class="card-label">今日总请求</div>
      <div class="card-value">${summary.totalRequests.toLocaleString()}</div>
      <div class="card-sub">${summary.errorRequests} 笔异常 · ${formatPercent(
        summary.totalRequests > 0 ? summary.errorRequests / summary.totalRequests : 0,
      )}</div>
    </div>
    <div class="card">
      <div class="card-label">今日花费 (元)</div>
      <div class="card-value">¥${formatCny(summary.totalCostMicro)}</div>
      <div class="card-sub">输入 ${summary.totalPromptTokens.toLocaleString()} tok · 输出 ${summary.totalCompletionTokens.toLocaleString()} tok</div>
    </div>
    <div class="card">
      <div class="card-label">今日平均上游延迟</div>
      <div class="card-value">${formatLatency(summary.avgTotalLatencyMs)}</div>
      <div class="card-sub">${longSummary.windowLabel} 累计 ¥${formatCny(longSummary.totalCostMicro)}</div>
    </div>
  </section>`;
}

function renderQps(buckets: QpsBucket[]): string {
  return `
  <section>
    <h2>今日 QPS (按分钟聚合)</h2>
    ${renderQpsSparkline(buckets)}
  </section>`;
}

function renderCostByDimension(title: string, rows: CostByDimension[]): string {
  if (rows.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><div class="empty">暂无数据</div></section>`;
  }
  const trs = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.dimension)}</td>
      <td class="num">${r.totalRequests.toLocaleString()}</td>
      <td class="num">¥${formatCny(r.totalCostMicro)}</td>
      <td class="num">${(r.totalPromptTokens + r.totalCompletionTokens).toLocaleString()}</td>
    </tr>`,
    )
    .join('');
  return `
  <section>
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead><tr><th>维度</th><th class="num">请求数</th><th class="num">花费 (元)</th><th class="num">总 token</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </section>`;
}

function renderTopKeys(rows: KeyUsageRow[]): string {
  if (rows.length === 0) {
    return `<section><h2>Top 10 Key 用量</h2><div class="empty">暂无数据</div></section>`;
  }
  const trs = rows
    .map(
      (r) => `
    <tr>
      <td>key:${r.keyId}</td>
      <td class="num">${r.totalRequests.toLocaleString()}</td>
      <td class="num">¥${formatCny(r.totalCostMicro)}</td>
      <td class="num">${r.totalTokens.toLocaleString()}</td>
      <td class="num">${r.errorRequests}</td>
    </tr>`,
    )
    .join('');
  return `
  <section>
    <h2>Top 10 Key 用量</h2>
    <table>
      <thead><tr><th>Key</th><th class="num">请求</th><th class="num">花费 (元)</th><th class="num">Token</th><th class="num">异常</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </section>`;
}

function renderChannelHealth(rows: ChannelHealthRow[]): string {
  if (rows.length === 0) {
    return `<section><h2>Channel 健康状态</h2><div class="empty">还没有 channel</div></section>`;
  }
  const trs = rows
    .map((r) => {
      const statusClass =
        r.status === 'active' ? 'status-ok' : r.status === 'probing' ? 'status-warn' : 'status-bad';
      return `
    <tr>
      <td>${r.channelId}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.provider)}</td>
      <td><span class="${statusClass}">${escapeHtml(r.status)}</span></td>
      <td>${escapeHtml(r.disabledReason ?? '-')}</td>
      <td class="num">${r.totalRequests.toLocaleString()}</td>
      <td class="num">${formatPercent(r.errorRate)}</td>
      <td class="num">${formatLatency(r.avgUpstreamLatencyMs)}</td>
    </tr>`;
    })
    .join('');
  return `
  <section>
    <h2>Channel 健康状态 (今日)</h2>
    <table>
      <thead><tr>
        <th>ID</th><th>名称</th><th>Provider</th><th>状态</th><th>禁用原因</th>
        <th class="num">请求</th><th class="num">错误率</th><th class="num">平均上游延迟</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </section>`;
}

function renderTopErrorModels(rows: ModelErrorRow[]): string {
  if (rows.length === 0) {
    return `<section><h2>错误率 Top 5 模型</h2><div class="empty">今日还没有 ≥ 5 笔请求的模型</div></section>`;
  }
  const trs = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.model)}</td>
      <td class="num">${r.totalRequests.toLocaleString()}</td>
      <td class="num">${r.errorRequests}</td>
      <td class="num">${formatPercent(r.errorRate)}</td>
    </tr>`,
    )
    .join('');
  return `
  <section>
    <h2>错误率 Top 5 模型 (今日 ≥ 5 笔)</h2>
    <table>
      <thead><tr><th>模型</th><th class="num">请求数</th><th class="num">异常数</th><th class="num">错误率</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </section>`;
}

// ============================================================
// 完整页面
// ============================================================

export interface DashboardPageData {
  summaryToday: DashboardSummary;
  summary7d: DashboardSummary;
  qpsByMinute: QpsBucket[];
  costByUser: CostByDimension[];
  costByModel: CostByDimension[];
  topKeys: KeyUsageRow[];
  channelHealth: ChannelHealthRow[];
  topErrorModels: ModelErrorRow[];
}

const STYLES = `
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         max-width: 1200px; margin: 0 auto; padding: 24px;
         background: #0e1117; color: #e6edf3; }
  h1 { font-size: 20px; margin: 0 0 8px 0; }
  h2 { font-size: 16px; margin: 32px 0 12px 0; color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
  .meta { color: #8b949e; font-size: 12px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; }
  .card-label { color: #8b949e; font-size: 12px; }
  .card-value { font-size: 28px; font-weight: bold; margin: 6px 0; }
  .card-sub { color: #8b949e; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #30363d; font-size: 13px; }
  th { color: #8b949e; font-weight: normal; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .status-ok { color: #56d364; }
  .status-warn { color: #d29922; }
  .status-bad { color: #f85149; }
  .empty { color: #8b949e; font-size: 13px; padding: 12px; }
  .sparkline { font-size: 18px; letter-spacing: 1px; color: #58a6ff; line-height: 1; padding: 12px 0; overflow-x: auto; white-space: nowrap; }
  .sparkline-axis { display: flex; justify-content: space-between; color: #8b949e; font-size: 11px; }
  .sparkline-hint { color: #8b949e; font-size: 11px; margin-top: 4px; }
  footer { color: #8b949e; font-size: 11px; margin-top: 32px; text-align: center; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; color: #79c0ff; }
`;

export function renderDashboardPage(data: DashboardPageData): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>LLM Gateway 看板 · v0.9</title>
  <style>${STYLES}</style>
</head>
<body>
  <h1>LLM Gateway 看板</h1>
  <div class="meta">
    渲染时间: ${escapeHtml(new Date().toISOString())} ·
    自动刷新: 30s ·
    按 trace_id 反查请求: <code>curl /admin/usage?traceId=&lt;id&gt;</code>
  </div>
  ${renderSummary(data.summaryToday, data.summary7d)}
  ${renderQps(data.qpsByMinute)}
  ${renderCostByDimension('今日花费 · 按用户', data.costByUser)}
  ${renderCostByDimension('今日花费 · 按模型', data.costByModel)}
  ${renderTopKeys(data.topKeys)}
  ${renderChannelHealth(data.channelHealth)}
  ${renderTopErrorModels(data.topErrorModels)}
  <footer>
    LLM Gateway v0.9 · 数据来源 usage_records 表 · 时区按服务器本地时间
  </footer>
</body>
</html>`;
}
