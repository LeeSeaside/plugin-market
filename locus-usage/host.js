/*!
 * 用量统计 · Host 半（com.locus.usage）
 *
 * runner 契约同 com.locus.git（全权 Node，每插件一进程）。数据源 = 内核
 * agent.db（<kernelHome>/agent/agent.db），只跑 SELECT —— 与内核进程共存的
 * 只读消费（schema 实测：recorded_at 均为毫秒时间戳；client_usage 在 desk
 * RPC 模式下暂无写入，tokens 段会以 null 显形）。
 *
 * 注入参数（omp:plugin-host:invoke handler，服务端事实源）：
 *   params.kernelHome  内核家目录绝对路径（createServices 解析结果）
 *
 * 方法面：
 *   usage.summary { days? }  → { total, daily[], providers[], tokens|null }
 *   usage.models             → [{ model_key, samples, tps, ttft_s, updated_at }]
 *   usage.quota              → [{ limit_id, label, used_fraction, status, resets_at }]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;

let db = null;
let dbPath = null;

function openDb(kernelHome) {
  if (!kernelHome || typeof kernelHome !== 'string') {
    throw new Error('kernelHome 未注入（服务端参数缺失）');
  }
  const p = path.join(kernelHome, 'agent', 'agent.db');
  if (db && dbPath === p) return db;
  if (db) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
    db = null;
  }
  db = new DatabaseSync(p);
  dbPath = p;
  return db;
}

const msToLocalDay = (ms) => {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function summaryRequest(params) {
  const days = Math.min(Math.max(Number(params.days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const sinceMs = Date.now() - days * 86_400_000;
  const d = openDb(params.kernelHome);
  // 只读消费：全部 SELECT；任何 schema 漂移都以可读错误显形。
  const daily = d
    .prepare(
      `SELECT date(recorded_at/1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS n, SUM(cost_usd) AS cost
         FROM usage_cost_history WHERE recorded_at >= ?
        GROUP BY day ORDER BY day`,
    )
    .all(sinceMs);
  const totalRow = d
    .prepare(
      `SELECT COUNT(*) AS n, SUM(cost_usd) AS cost,
              MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at
         FROM usage_cost_history`,
    )
    .get();
  const providers = d
    .prepare(
      `SELECT provider, COUNT(*) AS n, SUM(cost_usd) AS cost
         FROM usage_cost_history GROUP BY provider ORDER BY cost DESC`,
    )
    .all();
  // client_usage 在 desk RPC 模式下当前无写入（实测 0 行）：0 行时 tokens=null，
  // UI 显形为「暂无数据」而不是画一张空图。
  const tokenRows = d
    .prepare(
      `SELECT date(recorded_at/1000, 'unixepoch', 'localtime') AS day,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite
         FROM client_usage WHERE recorded_at >= ?
        GROUP BY day ORDER BY day`,
    )
    .all(sinceMs);
  return {
    total: {
      count: Number(totalRow?.n ?? 0),
      cost: Number(totalRow?.cost ?? 0),
      firstDay: totalRow?.first_at ? msToLocalDay(totalRow.first_at) : null,
      lastDay: totalRow?.last_at ? msToLocalDay(totalRow.last_at) : null,
    },
    daily: daily.map((r) => ({ day: r.day, count: Number(r.n), cost: Number(r.cost ?? 0) })),
    providers: providers.map((r) => ({ provider: r.provider, count: Number(r.n), cost: Number(r.cost ?? 0) })),
    tokens:
      tokenRows.length > 0
        ? tokenRows.map((r) => ({
            day: r.day,
            input: Number(r.input ?? 0),
            output: Number(r.output ?? 0),
            cacheRead: Number(r.cacheRead ?? 0),
            cacheWrite: Number(r.cacheWrite ?? 0),
          }))
        : null,
  };
}

function modelsRequest(params) {
  const d = openDb(params.kernelHome);
  const rows = d
    .prepare(
      `SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at
         FROM model_perf ORDER BY samples DESC LIMIT 30`,
    )
    .all();
  return rows.map((r) => ({
    modelKey: r.model_key,
    samples: Number(r.samples ?? 0),
    tps: Number(r.gen_ms) > 0 ? Number(r.output_tokens ?? 0) / Number(r.gen_ms) * 1000 : null,
    ttftS: Number(r.ttft_samples) > 0 ? Number(r.ttft_ms ?? 0) / 1000 : null,
    updatedAt: Number(r.updated_at ?? 0),
  }));
}

function quotaRequest(params) {
  const d = openDb(params.kernelHome);
  const rows = d
    .prepare(
      `SELECT u.limit_id, u.label, u.used_fraction, u.status, u.resets_at
         FROM usage_history u
        WHERE u.id IN (SELECT MAX(id) FROM usage_history GROUP BY limit_id)
        ORDER BY CASE u.limit_id WHEN 'rolling-5h' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END`,
    )
    .all();
  return rows.map((r) => ({
    limitId: r.limit_id,
    label: r.label,
    usedFraction: Number(r.used_fraction ?? 0),
    status: r.status,
    resetsAt: r.resets_at ? Number(r.resets_at) : null,
  }));
}

export async function activate(host) {
  host.log('info', '用量统计 host 半已激活');
  return {
    async request(method, params = {}) {
      switch (method) {
        case 'usage.summary':
          return summaryRequest(params);
        case 'usage.models':
          return modelsRequest(params);
        case 'usage.quota':
          return quotaRequest(params);
        default:
          throw new Error(`未知方法：${method}`);
      }
    },
  };
}

export default { activate };
