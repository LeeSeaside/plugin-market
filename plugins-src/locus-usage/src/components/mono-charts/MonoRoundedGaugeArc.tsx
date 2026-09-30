/**
 * amicro MonoRoundedGaugeArc —— 参数化适配版（保持原组件结构）。
 * 适配点：硬编码色 → 宿主 CSS 变量；pct/文案走 props；≥75% / ≥90% 沿用
 * 宿主 warn / danger 语义色（与旧版仪表盘一致）。
 */
import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { CARD, WELL, LABEL, CHIP, FOOT, FOOT_L, FOOT_R, BIG_VALUE } from './shell';

export interface MonoRoundedGaugeArcProps {
  pct: number;
  label: string;
  chip?: string;
  centerLabel?: string;
  centerTone?: boolean;
  compact?: boolean;
  footerL?: string;
  footerR?: string;
}

export function MonoRoundedGaugeArc({
  pct,
  label,
  chip,
  centerLabel,
  centerTone = true,
  compact = false,
  footerL,
  footerR,
}: MonoRoundedGaugeArcProps) {
  const reduced = useReducedMotion();
  const clamped = Math.min(100, Math.max(0, pct));
  const data = [
    { name: '已用', value: clamped },
    { name: '余量', value: 100 - clamped },
  ];
  const tone =
    centerTone && pct >= 90
      ? 'var(--danger)'
      : centerTone && pct >= 75
      ? 'var(--warn)'
      : 'var(--fg-primary)';

  return (
    <div className={`${CARD} ${compact ? 'h-[220px] sm:h-[236px]' : 'min-h-[290px]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="flex items-center gap-2">
            <span className={LABEL}>{label}</span>
            {chip && <span className={CHIP}>{chip}</span>}
          </div>
          <div className={BIG_VALUE}>
            {pct.toFixed(1)}% <span className="text-xs font-normal text-[var(--fg-muted)] font-mono">已用</span>
          </div>
        </div>
      </div>

      {/* Main Stage */}
      <div className={`${WELL} flex flex-col items-center justify-center`}>
        <ResponsiveContainer width="100%" height={compact ? 120 : 140}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              cx="50%"
              cy="70%"
              startAngle={210}
              endAngle={-30}
              innerRadius={compact ? 44 : 54}
              outerRadius={compact ? 60 : 72}
              cornerRadius={8}
              strokeLinecap="round"
              paddingAngle={4}
              isAnimationActive={!reduced}
              animationDuration={900}
            >
              <Cell fill="var(--accent)" />
              <Cell fill="var(--border)" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        <div className="absolute bottom-4 flex flex-col items-center pointer-events-none">
          <span
            className="text-xl font-extrabold tabular-nums font-sans"
            style={{ color: tone }}
          >
            {clamped.toFixed(1)}
          </span>
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">
            {centerLabel ?? 'Target Met'}
          </span>
        </div>
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
