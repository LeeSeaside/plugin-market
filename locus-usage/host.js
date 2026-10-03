/*!
 * 用量统计 · Host 半（com.locus.usage）
 *
 * 数据源（2026-09-29 方案A拍板）：内核 stats.db 的 messages 表 —— omp 18.x
 * "sessions sync" 管线的全量用量账本（token 四分类 / TTFT / 时长 / API 等价
 * 成本），subscription / token-plan 模型的用量也在内。quota 仍读
 * agent.db usage_history（stats.db 无限额快照）。
 *
 * 面板加载时 spawn `omp stats --json` 触发一次增量同步：omp 18.3.0 起内置
 * stats 子命令，语义即「先同步 session 文件后出数」，实测毫秒级（增量游标
 * file_offsets 幂等）。bundled exe 优先，全局 PATH omp 兜底；60s 节流 +
 * 并发单飞；同步失败静默降级为直读库（上次同步的快照）。
 *
 * 注入参数（omp:plugin-host:invoke handler，服务端事实源）：
 *   params.kernelHome  内核家目录绝对路径（createServices 解析结果）
 *   params.ompExe      bundled 内核 exe（懒解析，未 staged 为 null）
 *
 * 方法面：
 *   usage.summary { days?, all?, provider?, model? }
 *        → { unit: 'day'|'hour', total(含 cacheRate/tps/ttftS/errors/cacheSavings),
 *            daily[](含 errors), providers[], models[](含 tps/ttftS), facets }
 *   usage.models { all?, provider?, model? } → [{ modelKey, samples, tps, ttftS, updatedAt }]
 *   usage.quota                              → [{ limitId, label, usedFraction, status, resetsAt }]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;
const SYNC_THROTTLE_MS = 60_000;
const SYNC_TIMEOUT_MS = 30_000;

let statsDb = null;
let statsDbPath = null;
let agentDb = null;
let agentDbPath = null;
let syncPromise = null;
let lastSyncAt = 0;

function resolveStatsDbPath(kernelHome) {
  const candidates = [
    kernelHome ? path.join(kernelHome, 'stats.db') : null,
    path.join(os.homedir(), '.omp', 'stats.db'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* 探测失败继续 */
    }
  }
  return candidates[0];
}

function openStatsDb(kernelHome) {
  const p = resolveStatsDbPath(kernelHome);
  if (!p) throw new Error('stats.db 不存在 —— 内核从未同步过 session 统计');
  if (statsDb && statsDbPath === p) return statsDb;
  if (statsDb) {
    try {
      statsDb.close();
    } catch {
      /* 已关 */
    }
    statsDb = null;
  }
  statsDb = new DatabaseSync(p, { readOnly: true });
  statsDbPath = p;
  return statsDb;
}

function openAgentDb(kernelHome) {
  if (!kernelHome || typeof kernelHome !== 'string') {
    throw new Error('kernelHome 未注入（服务端参数缺失）');
  }
  const p = path.join(kernelHome, 'agent', 'agent.db');
  if (agentDb && agentDbPath === p) return agentDb;
  if (agentDb) {
    try {
      agentDb.close();
    } catch {
      /* 已关 */
    }
    agentDb = null;
  }
  agentDb = new DatabaseSync(p, { readOnly: true });
  agentDbPath = p;
  return agentDb;
}

/**
 * 面板加载触发的增量同步：`omp stats --json` 先同步后出数。并发单飞 +
 * 60s 节流；全部候选失败时返回 'unavailable'（直读库快照，不报错）。
 */
function syncSessions(ompExe, kernelHome) {
  if (Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return Promise.resolve('throttled');
  if (syncPromise) return syncPromise;
  const candidates = [...new Set([ompExe, 'omp'])].filter(Boolean);
  syncPromise = (async () => {
    for (const exe of candidates) {
      const ok = await new Promise((resolve) => {
        try {
          const child = spawn(exe, ['stats', '--json'], {
            timeout: SYNC_TIMEOUT_MS,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            // 与 chat-service spawn 内核同款：隔离模式下 session 落在同一 home。
            env: { ...process.env, PI_CODING_AGENT_DIR: path.join(kernelHome, 'agent') },
          });
          child.on('close', (code) => resolve(code === 0));
          child.on('error', () => resolve(false));
        } catch {
          resolve(false);
        }
      });
      if (ok) {
        lastSyncAt = Date.now();
        return 'synced';
      }
    }
    return 'unavailable';
  })();
  return syncPromise.finally(() => {
    syncPromise = null;
  });
}

const msToLocalDay = (ms) => {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 1.4.0 过滤面：all=true 不限窗；days<=1 走逐小时桶；provider/model 为精确
 * 匹配（空串忽略）。同一 WHERE 供 buckets / 聚合 / providers / models 四路
 * 查询共用，保证各卡口径一致。
 */
function buildWhere(params) {
  const where = [];
  const args = [];
  const all = params.all === true;
  const days = all ? 0 : Math.min(Math.max(Number(params.days) || DEFAULT_DAYS, 1), MAX_DAYS);
  if (!all) {
    where.push('timestamp >= ?');
    args.push(Date.now() - days * 86_400_000);
  }
  if (typeof params.provider === 'string' && params.provider) {
    where.push('provider = ?');
    args.push(params.provider);
  }
  if (typeof params.model === 'string' && params.model) {
    where.push('model = ?');
    args.push(params.model);
  }
  return {
    clause: where.length ? 'WHERE ' + where.join(' AND ') : '',
    args,
    all,
    days,
  };
}

function summaryRequest(params) {
  const db = openStatsDb(params.kernelHome);
  const { clause, args, all, days } = buildWhere(params);
  const hourly = !all && days <= 1;
  const bucket = hourly
    ? `strftime('%Y-%m-%d %H:00', timestamp/1000, 'unixepoch', 'localtime')`
    : `date(timestamp/1000, 'unixepoch', 'localtime')`;
  const daily = db
    .prepare(
      `SELECT ${bucket} AS day,
              COUNT(*) AS n, SUM(cost_total) AS cost,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
              SUM(CASE WHEN error_message IS NOT NULL AND error_message <> '' THEN 1 ELSE 0 END) AS errors
         FROM messages ${clause}
        GROUP BY day ORDER BY day`,
    )
    .all(...args);
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(cost_total) AS cost,
              MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
              SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cacheRead,
              SUM(cost_no_cache_input) AS costNoCache, SUM(cost_input) AS costIn,
              SUM(cost_cache_read) AS costCRead,
              SUM(CASE WHEN error_message IS NOT NULL AND error_message <> '' THEN 1 ELSE 0 END) AS errors,
              SUM(duration) AS genMs,
              SUM(CASE WHEN duration > 0 THEN output_tokens ELSE 0 END) AS genOut,
              SUM(CASE WHEN ttft > 0 THEN ttft ELSE 0 END) AS ttftMs,
              SUM(CASE WHEN ttft > 0 THEN 1 ELSE 0 END) AS ttftN
         FROM messages ${clause}`,
    )
    .get(...args);
  const providers = db
    .prepare(
      `SELECT provider, COUNT(*) AS n, SUM(cost_total) AS cost
         FROM messages ${clause} GROUP BY provider ORDER BY cost DESC`,
    )
    .all(...args);
  const modelClause = clause ? clause + ' AND model IS NOT NULL' : 'WHERE model IS NOT NULL';
  const models = db
    .prepare(
      `SELECT model, COUNT(*) AS n, SUM(cost_total) AS cost,
              SUM(duration) AS genMs,
              SUM(CASE WHEN duration > 0 THEN output_tokens ELSE 0 END) AS genOut,
              AVG(CASE WHEN ttft > 0 THEN ttft END) AS ttftMs
         FROM messages ${modelClause}
        GROUP BY model ORDER BY n DESC LIMIT 40`,
    )
    .all(...args);
  // facets 不过滤（供下拉选项），models/providers 过滤（供卡片口径一致）
  const facets = {
    providers: db
      .prepare(`SELECT DISTINCT provider FROM messages WHERE provider IS NOT NULL AND provider <> '' ORDER BY provider`)
      .all()
      .map((r) => r.provider),
    models: db
      .prepare(`SELECT DISTINCT model FROM messages WHERE model IS NOT NULL AND model <> '' ORDER BY model LIMIT 60`)
      .all()
      .map((r) => r.model),
  };
  const n = Number(totalRow?.n ?? 0);
  const input = Number(totalRow?.input ?? 0);
  const cacheRead = Number(totalRow?.cacheRead ?? 0);
  const genMs = Number(totalRow?.genMs ?? 0);
  const genOut = Number(totalRow?.genOut ?? 0);
  const ttftMs = Number(totalRow?.ttftMs ?? 0);
  const ttftN = Number(totalRow?.ttftN ?? 0);
  const costNoCache = totalRow?.costNoCache == null ? null : Number(totalRow.costNoCache);
  const cacheSavings =
    costNoCache == null
      ? null
      : Math.max(0, costNoCache - (Number(totalRow?.costIn ?? 0) + Number(totalRow?.costCRead ?? 0)));
  return {
    unit: hourly ? 'hour' : 'day',
    total: {
      count: n,
      cost: Number(totalRow?.cost ?? 0),
      firstDay: totalRow?.first_at ? msToLocalDay(totalRow.first_at) : null,
      lastDay: totalRow?.last_at ? msToLocalDay(totalRow.last_at) : null,
      errors: Number(totalRow?.errors ?? 0),
      // 口径与 omp stats --json overall.cacheRate 一致：read / (input + read)
      cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
      cacheSavings,
      tps: genMs > 0 ? (genOut / genMs) * 1000 : null,
      ttftS: ttftN > 0 ? ttftMs / ttftN / 1000 : null,
    },
    daily: daily.map((r) => ({
      day: r.day,
      count: Number(r.n),
      cost: Number(r.cost ?? 0),
      input: Number(r.input ?? 0),
      output: Number(r.output ?? 0),
      cacheRead: Number(r.cacheRead ?? 0),
      cacheWrite: Number(r.cacheWrite ?? 0),
      errors: Number(r.errors ?? 0),
    })),
    providers: providers.map((r) => ({ provider: r.provider, count: Number(r.n), cost: Number(r.cost ?? 0) })),
    models: models.map((r) => ({
      modelKey: r.model,
      samples: Number(r.n ?? 0),
      cost: Number(r.cost ?? 0),
      tps: Number(r.genMs) > 0 ? (Number(r.genOut ?? 0) / Number(r.genMs)) * 1000 : null,
      ttftS: Number(r.ttftMs) > 0 ? Number(r.ttftMs) / 1000 : null,
    })),
    facets,
    // token 流水现与 daily 同源同窗（stats.db 全量记账），不再有「待上报」态。
    tokens: daily.map((r) => ({
      day: r.day,
      input: Number(r.input ?? 0),
      output: Number(r.output ?? 0),
      cacheRead: Number(r.cacheRead ?? 0),
      cacheWrite: Number(r.cacheWrite ?? 0),
    })),
  };
}

function modelsRequest(params) {
  const db = openStatsDb(params.kernelHome);
  // duration / ttft 单位毫秒（与 /stats 面板 avgTtft 同源）；tps 与 TTFT 均
  // 按聚合比值（累计和相除即均值），样本数 = 该模型 assistant 消息数。
  // 1.4.0：吃与 summary 同一套 provider/model 过滤（days 由调用方给 all）。
  const { clause, args } = buildWhere(params);
  const modelClause = clause ? clause + ' AND model IS NOT NULL' : 'WHERE model IS NOT NULL';
  const rows = db
    .prepare(
      `SELECT model, COUNT(*) AS n, SUM(output_tokens) AS output,
              SUM(duration) AS genMs, AVG(ttft) AS ttftMs, MAX(timestamp) AS updated
         FROM messages ${modelClause}
        GROUP BY model ORDER BY n DESC LIMIT 30`,
    )
    .all(...args);
  return rows.map((r) => ({
    modelKey: r.model,
    samples: Number(r.n ?? 0),
    tps: Number(r.genMs) > 0 ? (Number(r.output ?? 0) / Number(r.genMs)) * 1000 : null,
    ttftS: Number(r.ttftMs) > 0 ? Number(r.ttftMs) / 1000 : null,
    updatedAt: Number(r.updated ?? 0),
  }));
}

function quotaRequest(params) {
  const d = openAgentDb(params.kernelHome);
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
  host.log('info', '用量统计 host 半已激活（数据源 = 内核 stats.db）');
  return {
    async request(method, params = {}) {
      // summary / models 先触发一次面板级增量同步（节流内直接跳过），
      // 再读库 —— 同步失败不阻断（降级为上次快照）。
      if (method === 'usage.summary' || method === 'usage.models') {
        await syncSessions(params.ompExe, params.kernelHome).catch(() => 'unavailable');
      }
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
