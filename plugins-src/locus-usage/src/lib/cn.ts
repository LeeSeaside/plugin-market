/** 极简 className 组合（amicro 用 clsx + tailwind-merge；本插件只做 join）。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
