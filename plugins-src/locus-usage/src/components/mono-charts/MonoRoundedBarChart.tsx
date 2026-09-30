/**
 * amicro MonoRoundedBarChart —— 参数化适配版（保持原组件结构）。
 * 适配点：硬编码色 → 宿主 CSS 变量；数据/文案走 props；secondary 系列
 * 可关（成本与调用量纲差太大时不共轴）；barSize 自适应上限。
 */
import React, { useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { DitherChartTooltipContent } from '../../lib/recharts-tooltip';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { CARD, WELL, LABEL, CHIP, FOOT, FOOT_L, FOOT_R, BIG_VALUE } from './shell';

export interface BarPoint {
  label: string;
  primary: number;
  secondary?: number;
}

export interface MonoRoundedBarChartProps {
  data: BarPoint[];
  label: string;
  chip?: string;
  value: string;
  unit?: string;
  secondary?: boolean;
  footerL?: string;
  footerR?: string;
  tooltipFormatter?: (value: any, name: string) => any;
}

export function MonoRoundedBarChart({
  data,
  label,
  chip,
  value,
  unit,
  secondary = false,
  footerL,
  footerR,
  tooltipFormatter,
}: MonoRoundedBarChartProps) {
  const reduced = useReducedMotion();
  const [layout, setLayout] = useState<'vertical' | 'horizontal'>('vertical');
  const isHorizontal = layout === 'horizontal';

  return (
    <div className={`${CARD} min-h-[290px]`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className={LABEL}>{label}</span>
            {chip && <span className={CHIP}>{chip}</span>}
          </div>
          <div className={BIG_VALUE}>
            {value}
            {unit && (
              <span className="text-xs font-normal text-[var(--fg-muted)] font-mono">
                {' '}
                {unit}
              </span>
            )}
          </div>
        </div>

        {/* Layout Switcher */}
        <div className="p-0.5 rounded-full border flex items-center gap-0.5 bg-[var(--bg-soft)] border-[var(--border)]">
          {(['vertical', 'horizontal'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-all cursor-pointer ${
                layout === l
                  ? 'bg-[var(--accent-soft)] text-[var(--fg-primary)] font-semibold border border-[var(--border-strong)]'
                  : 'text-[var(--fg-muted)] hover:text-[var(--fg-primary)] border border-transparent'
              }`}
            >
              {l === 'vertical' ? '列' : '行'}
            </button>
          ))}
        </div>
      </div>

      {/* Main Recharts Stage */}
      <div className={`${WELL} touch-pan-y`}>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart
            data={data}
            layout={isHorizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 12, right: 12, left: isHorizontal ? 0 : -22, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="2 2"
              vertical={false}
              stroke="var(--border)"
            />
            {isHorizontal ? (
              <>
                <XAxis type="number" hide />
                <YAxis
                  dataKey="label"
                  type="category"
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tick={{ fontSize: 10, fill: 'var(--fg-subtle)' }}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'var(--fg-subtle)' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'var(--fg-subtle)' }}
                />
              </>
            )}
            <Tooltip
              cursor={{ fill: 'var(--bg-hover)' }}
              content={
                <DitherChartTooltipContent
                  indicator="dot"
                  formatter={tooltipFormatter}
                />
              }
            />

            {/* Primary Rounded Pill Column */}
            <Bar
              dataKey="primary"
              name="成本"
              fill="var(--accent)"
              radius={isHorizontal ? [0, 8, 8, 0] : [8, 8, 8, 8]}
              maxBarSize={16}
              isAnimationActive={!reduced}
              animationDuration={800}
            />

            {/* Muted Secondary Column */}
            {secondary && (
              <Bar
                dataKey="secondary"
                name="调用"
                fill="var(--accent)"
                fillOpacity={0.18}
                radius={isHorizontal ? [0, 8, 8, 0] : [8, 8, 8, 8]}
                maxBarSize={16}
                isAnimationActive={!reduced}
                animationDuration={1000}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Footer Details */}
      {(footerL || footerR) && (
        <div className={FOOT}>
          <span className={FOOT_L}>{footerL}</span>
          <span className={FOOT_R}>{footerR}</span>
        </div>
      )}
    </div>
  );
}
