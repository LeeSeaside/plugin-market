/**
 * amicro MonoRoundedBulletChart —— 参数化适配版（保持原组件结构）。
 * 适配点：硬编码色 → 宿主 CSS 变量；items/文案走 props；target 标线加
 * 端点钳制（我们的基准=最快模型=100%，原版 left:100% 会被裁没）。
 */
import React from 'react';
import { CARD, WELL, LABEL, CHIP, FOOT, FOOT_L, FOOT_R, BIG_VALUE } from './shell';

export interface BulletItem {
  title: string;
  /** 0-100（已按比例折算） */
  actual: number;
  /** 0-100 基准线位置 */
  target: number;
  /** 右侧值文本（缺省 `actual / target`） */
  valueText?: string;
}

export interface MonoRoundedBulletChartProps {
  items: BulletItem[];
  label: string;
  chip?: string;
  value: string;
  unit?: string;
  compact?: boolean;
  footerL?: string;
  footerR?: string;
}

export function MonoRoundedBulletChart({
  items,
  label,
  chip,
  value,
  unit,
  compact = false,
  footerL,
  footerR,
}: MonoRoundedBulletChartProps) {
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
            {value}
            {unit && (
              <span className="text-xs font-normal text-[var(--fg-muted)] font-mono">
                {' '}
                {unit}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Stage */}
      <div className={`${WELL} p-3 flex flex-col justify-around gap-2`}>
        {items.map((item, idx) => {
          // 端点钳制：标线永远完整落在轨道内（原版 100% 处会被 overflow 裁掉）。
          const markerLeft = Math.min(Math.max(item.target, 0), 100);
          return (
            <div key={idx} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-[var(--fg-primary)] font-medium truncate max-w-[60%]">
                  {item.title}
                </span>
                <span className="text-[var(--fg-muted)] tabular-nums">
                  {item.valueText ?? `${item.actual}% / ${item.target}%`}
                </span>
              </div>
              <div className="relative w-full h-3.5 rounded-full overflow-hidden bg-[var(--bg-soft)] border border-[var(--border)]">
                {/* Actual Bar */}
                <div
                  className="h-full rounded-full transition-all bg-[var(--accent)]"
                  style={{ width: `${Math.min(Math.max(item.actual, 0), 100)}%` }}
                />
                {/* Target Marker */}
                <div
                  className="absolute top-0 bottom-0 w-1 rounded-full bg-[var(--warn)] shadow-sm"
                  style={{ left: `calc(${markerLeft}% - ${markerLeft > 96 ? 4 : 2}px)` }}
                />
              </div>
            </div>
          );
        })}
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
