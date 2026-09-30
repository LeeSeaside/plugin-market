/**
 * amicro MonoRoundedKpiCardChart —— 参数化适配版（保持原组件结构）。
 * 适配点：硬编码色 → 宿主 CSS 变量；渐变 id 加 useId（多卡同页冲突修复）；
 * 数据/文案全部走 props；middle 槽允许替换走势段。
 */
import React, { useId } from 'react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { CARD, WELL, LABEL, CHIP, FOOT, FOOT_L, FOOT_R } from './shell';

export interface MonoRoundedKpiCardChartProps {
  label: string;
  chip?: string;
  value: string;
  unit?: string;
  delta?: string | null;
  data?: number[];
  middle?: React.ReactNode;
  compact?: boolean;
  footerL?: string;
  footerR?: string;
}

export function MonoRoundedKpiCardChart({
  label,
  chip,
  value,
  unit,
  delta = null,
  data,
  middle,
  compact = false,
  footerL,
  footerR,
}: MonoRoundedKpiCardChartProps) {
  const reduced = useReducedMotion();
  const gid = useId();
  const rows = (data ?? []).map((v, i) => ({ i, v }));
  const hasSeries = rows.length >= 2;

  return (
    <div className={`${CARD} ${compact ? 'h-[220px] sm:h-[236px]' : 'min-h-[290px]'}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <div className="flex items-center gap-2">
            <span className={LABEL}>{label}</span>
            {chip && <span className={CHIP}>{chip}</span>}
          </div>
          <div className="text-2xl font-extrabold tracking-tight tabular-nums mt-1 font-sans">
            {value}
            {unit && (
              <span className="text-xs font-normal text-[var(--fg-muted)] font-mono">
                {' '}
                {unit}
              </span>
            )}
            {delta && (
              <span className="text-xs text-[var(--accent)] font-mono"> {delta}</span>
            )}
          </div>
        </div>
      </div>

      {/* Middle: custom slot or rounded sparkline wave */}
      <div className={`${WELL} flex flex-col justify-end`}>
        {middle ??
          (hasSeries ? (
            <div className="w-full h-24">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={rows}>
                  <defs>
                    <linearGradient id={`kpi-${gid}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    fill={`url(#kpi-${gid})`}
                    isAnimationActive={!reduced}
                    animationDuration={800}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center font-mono text-[10px] text-[var(--fg-subtle)]">
              样本不足
            </div>
          ))}
      </div>

      {/* Footer */}
      {(footerL || footerR) && (
        <div className={FOOT}>
          <span className={FOOT_L}>{footerL}</span>
          <span className={FOOT_R}>{footerR}</span>
        </div>
      )}
    </div>
  );
}
