/**
 * amicro DitherChartTooltipContent —— 参数化适配版。
 * 原版按 theme prop 双写暗/亮色；本插件颜色一律消费宿主 CSS 变量
 * （三主题自动跟随），theme prop 保留但不使用。
 */
import React from 'react';

export interface ChartTooltipContentProps {
  active?: boolean;
  payload?: any[];
  label?: string;
  theme?: 'dark' | 'light';
  indicator?: 'dot' | 'line' | 'dashed';
  formatter?: (value: any, name: string) => React.ReactNode;
}

export function DitherChartTooltipContent({
  active,
  payload,
  label,
  indicator = 'dot',
  formatter,
}: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="px-3 py-2 rounded-xl text-xs shadow-2xl backdrop-blur-md border transition-all pointer-events-none font-sans z-50 bg-[var(--bg-elev)]/95 border-[var(--border-strong)] text-[var(--fg-primary)]">
      {label && (
        <div className="font-medium mb-1.5 pb-1 border-b tracking-tight border-[var(--border)] text-[var(--fg-muted)]">
          {label}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((item, idx) => {
          const color = item.color || item.fill || 'var(--fg-primary)';
          const valueDisplay = formatter
            ? formatter(item.value, item.name)
            : typeof item.value === 'number'
            ? item.value.toLocaleString()
            : item.value;

          return (
            <div key={idx} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                {indicator === 'dot' && (
                  <span
                    className="w-2 h-2 rounded-full ring-1 ring-[var(--border-strong)]"
                    style={{ backgroundColor: color }}
                  />
                )}
                {indicator === 'line' && (
                  <span
                    className="w-2.5 h-0.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                )}
                <span className="font-normal text-[var(--fg-muted)]">
                  {item.name || item.dataKey}:
                </span>
              </div>
              <span className="font-semibold tabular-nums font-mono">{valueDisplay}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
