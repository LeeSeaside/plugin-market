/**
 * `react/jsx-runtime`（及 dev 版）的替身（esbuild alias 目标）。
 *
 * 优先用宿主 React 自带的 jsx 运行时（19 的 `react` 主入口同样导出 jsx）；
 * 没有就退化到 createElement —— 两者对本项目的组件语义等价。
 * Fragment 必须是**宿主实例**的那个值（React 内部按引用比较元素类型），
 * 从 react-core 的活绑定转发。
 */
import { __impl } from './react-core';

export { Fragment, StrictMode, Suspense, Profiler } from './react-core';

type JsxFactory = (type: unknown, props: unknown, key?: unknown) => unknown;

function make(type: unknown, props: Record<string, unknown> | null, key: unknown): unknown {
  const impl = __impl();
  if (typeof impl.jsx === 'function') {
    return (impl.jsx as JsxFactory)(type, props, key);
  }
  if (typeof impl.createElement !== 'function') {
    throw new Error('[locus-plugin] 宿主 React 缺少 jsx 与 createElement');
  }
  const p = props || {};
  const cfg = key !== undefined && key !== null ? { ...p, key } : p;
  return (impl.createElement as JsxFactory)(type, cfg);
}

export const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown =>
  make(type, props, key);
export const jsxs = jsx;
export const jsxDEV = (type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown =>
  make(type, props, key);
