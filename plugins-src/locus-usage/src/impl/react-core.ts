/**
 * 宿主 React 注入核心 —— 打包式 Locus 插件的生死线。
 *
 * 插件 bundle 里**绝不能**打进第二份 React：面板由宿主的 react-dom 渲染，
 * 组件里的 hooks 必须来自同一个 React 实例，否则运行期直接
 * 「Invalid hook call」。esbuild 把 `react` 与 `react/jsx-runtime` 别名到
 * 本目录的两个模块；apply(ctx) 一进来先 `__injectReact(ctx.React)`，
 * 之后所有导出都委托到宿主实例。
 */

type AnyReact = Record<string, unknown> & {
  Fragment?: unknown;
  StrictMode?: unknown;
  Suspense?: unknown;
  Profiler?: unknown;
};

let impl: AnyReact | null = null;

/* ── 值型导出（注入时重绑；react.ts / jsx-runtime.ts 转发同一绑定） ── */
export let Fragment: unknown;
export let StrictMode: unknown;
export let Suspense: unknown;
export let Profiler: unknown;

/** apply(ctx) 的第一行调用：`__injectReact(ctx.React)`。 */
export function __injectReact(react: unknown): void {
  if (!react || typeof (react as AnyReact).createElement !== 'function') {
    throw new Error('[locus-plugin] ctx.React 缺失或不是 React 实例');
  }
  impl = react as AnyReact;
  const r = react as AnyReact;
  Fragment = r.Fragment;
  StrictMode = r.StrictMode;
  Suspense = r.Suspense;
  Profiler = r.Profiler;
}

/** 委托型导出的取值入口；未注入即抛错（错误信息可诊断，不会静默渲染空白）。 */
export function __impl(): AnyReact {
  if (impl === null) {
    throw new Error('[locus-plugin] React 未注入：模块在 apply(ctx) 之前被执行了');
  }
  return impl;
}
