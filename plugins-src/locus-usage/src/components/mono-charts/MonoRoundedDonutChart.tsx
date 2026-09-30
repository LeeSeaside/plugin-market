/**
 * amicro MonoRoundedDonutChart —— 参数化适配版（保持原组件结构）。
 * 适配点：硬编码色 → 宿主 CSS 变量（色梯 = accent 透明度阶梯，沿用旧版
 * 单色相语言）；segments/文案走 props；>5 段时透明度收敛到底档。
 */
import React, { useState } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { DitherChartTooltipContent } from '../../lib/recharts-tooltip';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { CARD, WELL, LABEL, CHIP, FOOT, FOOT_L, FOOT_R, BIG_VALUE } from './shell';

export interface DonutSegment {
  name: string;
  value: number;
}

const LADDER = [1, 0.72, 0.5, 0.32, 0.2];

export interface MonoRoundedDonutChartProps {
  data: DonutSegment[];
  label: string;
  chip?: string;
  headerValue: string;
  headerUnit?: string;
  centerNote?: string;
  compact?: boolean;
  footerL?: string;
  footerR?: string;
  tooltipFormatter?: (value: any, name: string) => any;
}

export function MonoRoundedDonutChart({
  data,
  label,
  chip,
  headerValue,
  headerUnit,
  centerNote = 'Mono Arc',
  compact = false,
  footerL,
  footerR,
  tooltipFormatter,
}: MonoRoundedDonutChartProps) {
  const reduced = useReducedMotion();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const total = data.reduce((acc, item) => acc + item.value, 0);

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
            {headerValue}
            {headerUnit && (
              <span className="text-xs font-normal text-[var(--fg-muted)] font-mono">
                {' '}
                {headerUnit}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Recharts Stage */}
      <div className={`${WELL} flex items-center justify-center touch-pan-y`}>
        <ResponsiveContainer width="100%" height={compact ? 130 : 160}>
          <PieChart>
            <Tooltip
              content={
                <DitherChartTooltipContent indicator="dot" formatter={tooltipFormatter} />
              }
            />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={compact ? 38 : 46}
              outerRadius={compact ? 58 : 68}
              paddingAngle={6}
              cornerRadius={8}
              strokeLinecap="round"
              onMouseEnter={(_: unknown, idx: number) => setHoverIndex(idx)}
              onMouseLeave={() => setHoverIndex(null)}
              isAnimationActive={!reduced}
              animationDuration={900}
            >
              {data.map((entry, index) => {
                const isHovered = hoverIndex === index;
                return (
                  <Cell
                    key={`mono-cell-${index}`}
                    fill="var(--accent)"
                    fillOpacity={LADDER[Math.min(index, LADDER.length - 1)]}
                    stroke="var(--bg-panel)"
                    strokeWidth={2}
                    style={{
                      transform: isHovered ? 'scale(1.05)' : 'scale(1)',
                      transformOrigin: 'center center',
                      transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                      cursor: 'pointer',
                    }}
                  />
                );
              })}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Center Stat Callout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-sm font-bold tabular-nums font-sans">
            {hoverIndex !== null
              ? `${Math.round(((data[hoverIndex]?.value ?? 0) / (total || 1)) * 100)}%`
              : '100%'}
          </span>
          <span className="text-[10px] text-[var(--fg-subtle)]">
            {hoverIndex !== null ? data[hoverIndex]?.name : centerNote}
          </span>
        </div>
      </div>

      {/* Segment Legend Footer */}
      <div className="flex items-center justify-around mt-3 pt-1 border-t border-[var(--border)] text-[10px]">
        {data.map((seg, idx) => (
          <div key={idx} className="flex items-center gap-1">
            <span
              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"
              style={{ opacity: LADDER[Math.min(idx, LADDER.length - 1)] }}
            />
            <span className="text-[var(--fg-muted)]">{seg.name}</span>
          </div>
        ))}
      </div>
      {(footerL || footerR) && (
        <div className={`${FOOT} mt-1.5`}>
          <span className={FOOT_L}>{footerL}</span>
          <span className={FOOT_R}>{footerR}</span>
        </div>
      )}
    </div>
  );
}
