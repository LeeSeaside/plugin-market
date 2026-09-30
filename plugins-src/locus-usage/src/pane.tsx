/**
 * 用量统计 · 面板实现（由 main.tsx 在 apply 内动态 import —— 重模块图
 * （recharts / motion / 组件图）的模块初始化必须发生在 __injectReact
 * 之后：recharts 在模块求值期就会调用 forwardRef/createContext，静态
 * import 会让这段初始化跑到宿主 React 注入之前而炸掉）。
 *
 * 视觉 = amicro mono-charts 真实组件（逐卡参数化：色值 → 宿主 CSS 变量）；
 * 数据 = Host 半 stats.db 账本（omp:plugin-host:invoke 桥）。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { MonoRoundedKpiCardChart } from './components/mono-charts/MonoRoundedKpiCardChart';
import { MonoRoundedBarChart } from './components/mono-charts/MonoRoundedBarChart';
import { MonoRoundedGaugeArc } from './components/mono-charts/MonoRoundedGaugeArc';
import { MonoRoundedDonutChart } from './components/mono-charts/MonoRoundedDonutChart';
import { MonoRoundedBulletChart, type BulletItem } from './components/mono-charts/MonoRoundedBulletChart';
import {
  GitHubActivity,
  type Contribution,
  type ContributionLevel,
} from './components/mono-charts/GitHubActivity';
import { CARD, WELL, FOOT, FOOT_L, FOOT_R } from './components/mono-charts/shell';
import type { LocusPluginCtx } from './env';

/* ─────────────────────────── 类型（Host 半 wire 契约） ─────────────────────────── */

interface DailyPoint {
  day: string;
  count: number;
  cost: number;
}
interface Summary {
  total: { count: number; cost: number; firstDay: string | null; lastDay: string | null };
  daily: DailyPoint[];
  providers: { provider: string; count: number; cost: number }[];
}
interface ModelRow {
  modelKey: string;
  samples: number;
  tps: number | null;
  ttftS: number | null;
}
interface QuotaRow {
  limitId: string;
  label: string;
  usedFraction: number;
  status: string;
  resetsAt: number | null;
}

/* ─────────────────────────── 格式化 ─────────────────────────── */

function fmtUsd(v: number): string {
  if (!isFinite(v)) return '$0';
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}
function fmtUsdShort(v: number): string {
  if (!isFinite(v) || v <= 0) return '0';
  if (v >= 100) return '$' + Math.round(v);
  if (v >= 1) return '$' + v.toFixed(1);
  if (v >= 0.01) return '$' + v.toFixed(2);
  return '<1¢';
}
function fmtNum(v: number): string {
  if (!isFinite(v)) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}
function fmtDay(iso: string): string {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(5) : '';
}
function fmtReset(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ─────────────────────────── 热力数据（13 周贡献格） ─────────────────────────── */

function toContributions(daily: DailyPoint[]): Contribution[] {
  const counts = daily
    .filter((d) => d.count > 0)
    .map((d) => d.count)
    .sort((a, b) => a - b);
  const q = (p: number) =>
    counts.length ? counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] : 0;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  const levelOf = (c: number): ContributionLevel =>
    c <= 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4;

  const byDay = new Map(daily.map((d) => [d.day, d.count]));
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // 终点 = 今天；起点 = 91 天前回退到周日（GitHub 日历列 = 周，首行周日）。
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 90);
  start.setDate(start.getDate() - start.getDay());

  const out: Contribution[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = iso(d);
    const count = byDay.get(key) ?? 0;
    out.push({ date: key, count, level: levelOf(count) });
  }
  return out;
}

/* ─────────────────────────── 范围切换 ─────────────────────────── */

const RANGES = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 365, label: '1 年' },
];

function Segmented(props: { days: number; busy: boolean; onPick: (d: number) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--bg-soft)] p-0.5">
      {RANGES.map((r) => {
        const active = props.days === r.days;
        return (
          <button
            key={r.days}
            type="button"
            disabled={props.busy}
            onClick={() => props.onPick(r.days)}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] tabular-nums leading-relaxed transition-colors ${
              active
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg-primary)]'
                : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg-primary)]'
            } ${props.busy ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── 面板 ─────────────────────────── */

export function UsagePane(props: { ctx: LocusPluginCtx }) {
  const ctx = props.ctx;
  const [sum, setSum] = useState<Summary | null>(null);
  const [sum90, setSum90] = useState<Summary | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [quota, setQuota] = useState<QuotaRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(90);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastLoadAt = useRef(0);
  const daysRef = useRef(days);
  daysRef.current = days;

  const rpc = useCallback(
    (method: string, params?: Record<string, unknown>) =>
      ctx.api.invoke('omp:plugin-host:invoke', {
        pluginId: ctx.id,
        method,
        params: params ?? {},
      }) as Promise<unknown>,
    [ctx],
  );

  const load = useCallback(
    (d: number) => {
      lastLoadAt.current = Date.now();
      setBusy(true);
      Promise.all([
        rpc('usage.summary', { days: d }),
        rpc('usage.summary', { days: 90 }),
        rpc('usage.models'),
        rpc('usage.quota'),
      ])
        .then((r) => {
          setSum(r[0] as Summary);
          setSum90(r[1] as Summary);
          setModels(Array.isArray(r[2]) ? (r[2] as ModelRow[]) : []);
          setQuota(Array.isArray(r[3]) ? (r[3] as QuotaRow[]) : []);
          setErr(null);
        })
        .catch((e: unknown) => setErr(String((e as Error)?.message ?? e)))
        .finally(() => setBusy(false));
    },
    [rpc],
  );

  useEffect(() => {
    load(90);
  }, [load]);

  /* 面板重新可见（隐藏 tab 是 display:none，IO 能感知）→ 超 60s 自动重同步。 */
  const paneReady = !!sum || !!err;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries[entries.length - 1].isIntersecting;
        if (!vis) return;
        if (Date.now() - lastLoadAt.current < 60_000) return;
        load(daysRef.current);
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load, paneReady]);

  const onPick = (d: number) => {
    setDays(d);
    load(d);
  };

  if (!sum && !err) {
    const Loader = ctx.beui['Loader'] as React.ComponentType<Record<string, unknown>>;
    return (
      <div
        data-plugin-pane={ctx.id}
        data-omp-tw=""
        ref={rootRef}
        className="p-4 text-[var(--fg-muted)]"
      >
        <Loader variant="spinner" size={14} label="读取内核用量账本" />
      </div>
    );
  }

  const daily = sum ? sum.daily ?? [] : [];
  let rangeCost = 0;
  let rangeCount = 0;
  let activeDays = 0;
  let maxCount = 0;
  const peak = { cost: 0, day: '' };
  for (const d of daily) {
    rangeCost += d.cost;
    rangeCount += d.count;
    if (d.count > 0) activeDays++;
    if (d.count > maxCount) maxCount = d.count;
    if (d.cost > peak.cost) {
      peak.cost = d.cost;
      peak.day = d.day;
    }
  }
  const span = days;
  const avgCost = activeDays > 0 ? rangeCost / activeDays : 0;
  const total = sum ? sum.total : { count: 0, cost: 0, firstDay: null, lastDay: null };
  const hasData = rangeCost > 0 || rangeCount > 0;

  /* 模型性能：按 tps 降序，条长 = 相对最快（最快行 = 基准 100%）。 */
  const tpsRows = models
    .filter((m) => m.tps != null && m.tps > 0)
    .sort((a, b) => (b.tps ?? 0) - (a.tps ?? 0))
    .slice(0, 6);
  const maxTps = tpsRows.length ? (tpsRows[0].tps ?? 0) : 0;
  const bulletItems: BulletItem[] = tpsRows.map((m) => ({
    title: m.modelKey,
    actual: maxTps > 0 ? Math.round(((m.tps ?? 0) / maxTps) * 1000) / 10 : 0,
    target: 100,
    valueText: `${(m.tps ?? 0).toFixed(1)} tok/s`,
  }));

  const usd = (v: unknown, name: string) =>
    name === '成本' ? fmtUsd(Number(v)) : `${fmtNum(Number(v))} 笔`;

  return (
    <div
      data-plugin-pane={ctx.id}
      data-omp-tw=""
      ref={rootRef}
      className="flex flex-col gap-2.5 p-2.5 pb-5 sm:p-3"
    >
      {/* Head */}
      <div className="flex flex-wrap items-center gap-2.5 px-0.5 pb-1.5">
        <div className="min-w-[150px] flex-1">
          <div className="text-sm font-semibold text-[var(--fg-primary)]">用量统计</div>
          <div className="pt-0.5 font-mono text-[10px] tabular-nums text-[var(--fg-subtle)]">
            累计 {fmtUsd(total.cost)} · {fmtNum(total.count)} 笔
            {total.lastDay ? ` · 记至 ${fmtDay(total.lastDay)}` : ''} · API 等价口径
          </div>
        </div>
        <Segmented days={days} busy={busy} onPick={onPick} />
      </div>

      {/* Error bar */}
      {err && (
        <div
          onClick={() => setErr(null)}
          className="mx-0.5 mb-1 cursor-pointer whitespace-pre-wrap break-words rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-panel)] p-2 px-3 text-xs text-[var(--fg-secondary)]"
        >
          {'加载失败 · 点击关闭\n' + err}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2.5">
        <MonoRoundedKpiCardChart
          compact
          label="区间成本"
          chip="等价 USD"
          value={fmtUsdShort(rangeCost)}
          unit="区间合计"
          data={daily.map((d) => d.cost)}
          footerL={`${span} 天窗口 · ${activeDays} 天有调用`}
          footerR={`日均 ${fmtUsd(avgCost)}`}
        />
        <MonoRoundedKpiCardChart
          compact
          label="区间调用"
          chip="CALLS"
          value={fmtNum(rangeCount)}
          unit="次"
          data={daily.map((d) => d.count)}
          footerL="逐日调用走势"
          footerR={`峰值 ${fmtNum(maxCount)}/日`}
        />
        <MonoRoundedKpiCardChart
          compact
          label="活跃天数"
          chip={`${span}D`}
          value={String(activeDays)}
          unit={`/ ${span} 天`}
          middle={
            <div className="flex h-24 flex-col justify-center gap-2 px-2">
              <div className="h-3.5 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--bg-soft)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-all duration-700"
                  style={{ width: `${span > 0 ? Math.min(100, (activeDays / span) * 100) : 0}%` }}
                />
              </div>
              <div className="font-mono text-[10px] text-[var(--fg-subtle)]">
                {activeDays} / {span} 天有调用
              </div>
            </div>
          }
          footerL="活跃占比"
          footerR={`${span > 0 ? Math.round((activeDays / span) * 100) : 0}%`}
        />
        <MonoRoundedKpiCardChart
          compact
          label="单日峰值"
          chip="PEAK"
          value={fmtUsdShort(peak.cost)}
          unit={peak.day ? fmtDay(peak.day) : undefined}
          middle={
            <div className="flex h-24 flex-col items-start justify-center gap-1 px-2">
              <div className="font-mono text-lg font-bold tabular-nums text-[var(--fg-primary)]">
                {peak.day ? fmtDay(peak.day) : '—'}
              </div>
              <div className="text-[10px] text-[var(--fg-subtle)]">单日最高消耗</div>
            </div>
          }
          footerL="窗口峰值"
          footerR={`日均 ${fmtUsd(avgCost)}`}
        />
      </div>

      {/* Daily cost bars */}
      {hasData ? (
        <MonoRoundedBarChart
          key={`bars-${days}`}
          data={daily.map((d) => ({ label: d.day.slice(5), primary: d.cost }))}
          label="逐日成本"
          chip="胶囊柱"
          value={fmtUsdShort(rangeCost)}
          unit="区间合计"
          footerL={`${span} 天窗口 · ${activeDays} 天有调用`}
          footerR={`日均 ${fmtUsd(avgCost)}`}
          tooltipFormatter={usd}
        />
      ) : (
        <div className={`${CARD} min-h-[180px]`}>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--fg-subtle)]">
              逐日成本
            </span>
            <span className="rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-primary)]">
              胶囊柱
            </span>
          </div>
          <div className={`${WELL} flex items-center justify-center`}>
            <div className="px-2 py-5 text-center font-mono text-[11px] leading-loose text-[var(--fg-subtle)]">
              <div>区间内无成本记录</div>
              <div className="text-[10px] opacity-85">
                {total.lastDay
                  ? `成本账本最后一条为 ${fmtDay(total.lastDay)} —— 订阅 / token-plan 模型不产生美元成本行`
                  : '暂无任何成本记录'}
              </div>
            </div>
          </div>
          <div className={FOOT}>
            <span className={FOOT_L}>{span} 天窗口</span>
            <span className={FOOT_R}>API 等价口径</span>
          </div>
        </div>
      )}

      {/* 13-week activity heatmap */}
      <GitHubActivity
        key="heat"
        contributions={toContributions((sum90 ? sum90.daily : daily) ?? [])}
        accent="var(--accent)"
        cellSize={12}
        months={13}
        label="活跃分布"
        style={{ maxWidth: '100%' }}
      />

      {/* Quota gauges */}
      {quota.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2.5">
          {quota.map((q) => (
            <MonoRoundedGaugeArc
              key={q.limitId}
              compact
              pct={q.usedFraction * 100}
              label={q.label || q.limitId}
              chip="仪表环"
              centerLabel="已用"
              footerL="按最近一次上报快照"
              footerR={q.resetsAt ? `重置 ${fmtReset(q.resetsAt)}` : '—'}
            />
          ))}
        </div>
      )}

      {/* Provider donut */}
      {sum && sum.providers && sum.providers.length >= 2 && (
        <MonoRoundedDonutChart
          data={sum.providers.map((p) => ({ name: p.provider, value: p.count }))}
          label="供应商构成"
          chip="分段环"
          headerValue={fmtNum(sum.providers.reduce((a, p) => a + p.count, 0))}
          headerUnit="笔"
          centerNote="按调用"
          footerL={`${sum.providers.length} 个供应商`}
          footerR="按调用量分档"
          tooltipFormatter={(v) => `${fmtNum(Number(v))} 笔`}
        />
      )}

      {/* Model bullet rows */}
      {bulletItems.length > 0 && (
        <MonoRoundedBulletChart
          items={bulletItems}
          label="模型性能"
          chip="子弹条"
          value={maxTps.toFixed(1)}
          unit="tok/s 最快"
          footerL="条长 = 相对最快 · 竖标 = 最快基准"
          footerR={`${tpsRows.length} 个模型 · ${models.reduce((a, m) => a + m.samples, 0)} 样本`}
        />
      )}
    </div>
  );
}
