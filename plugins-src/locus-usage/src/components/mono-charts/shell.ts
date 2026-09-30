/**
 * mono-charts 卡片壳共享类（amicro 原版每卡重复同一串 Tailwind）。
 * 颜色适配：原版 isDark 双写硬编码色 → 宿主 CSS 变量（三主题自动跟随）。
 */
export const CARD =
  'relative w-full rounded-[24px] transition-all duration-300 group flex flex-col justify-between overflow-hidden p-4 sm:p-5 ' +
  'bg-[var(--bg-panel)] hover:bg-[var(--bg-elev)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] text-[var(--fg-primary)]';

export const WELL =
  'relative w-full flex-1 rounded-[14px] overflow-hidden p-2 transition-colors duration-300 bg-[var(--bg-base)]';

export const LABEL = 'text-xs font-semibold tracking-wider uppercase text-[var(--fg-subtle)]';

export const CHIP =
  'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-[var(--accent-soft)] text-[var(--fg-primary)] border border-[var(--border-strong)]';

export const FOOT =
  'flex items-center justify-between mt-3 pt-1 border-t border-[var(--border)] text-[11px] font-mono';

export const FOOT_L = 'text-[var(--fg-muted)]';
export const FOOT_R = 'text-[var(--fg-primary)] font-medium';

export const BIG_VALUE = 'text-xl font-bold tracking-tight tabular-nums mt-0.5 font-sans';
