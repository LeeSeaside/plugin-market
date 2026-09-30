/**
 * `react` 的替身（esbuild alias 目标）。
 *
 * - 函数型导出（hooks / createElement / forwardRef …）→ 调用期委托宿主实例；
 * - 值型导出（Fragment / StrictMode / Suspense / Profiler）→ `export let`
 *   在注入时重绑（esbuild 的活绑定语义保证 import 方拿到新值）；
 * - 默认导出 → Proxy，`React.useState` 这类成员访问全部动态转发。
 *
 * 新增依赖库用了这里没列出的 hook？在下面补一行同名委托即可。
 */
import { __impl, __injectReact } from './react-core';

export { __injectReact };

/* ── 值型导出（注入时重绑；单源在 react-core） ── */
export { Fragment, StrictMode, Suspense, Profiler } from './react-core';

/* ── 元素工厂 ── */
export const createElement = (...a: unknown[]) => (__impl().createElement as (..._: unknown[]) => unknown)(...a);
export const cloneElement = (...a: unknown[]) => (__impl().cloneElement as (..._: unknown[]) => unknown)(...a);
export const createRef = () => (__impl().createRef as () => unknown)();
export const isValidElement = (o: unknown) => (__impl().isValidElement as (o: unknown) => boolean)(o);

/* ── hooks（调用期委托） ── */
export const useState = (...a: unknown[]) => (__impl().useState as (..._: unknown[]) => unknown)(...a);
export const useEffect = (...a: unknown[]) => (__impl().useEffect as (..._: unknown[]) => unknown)(...a);
export const useLayoutEffect = (...a: unknown[]) => (__impl().useLayoutEffect as (..._: unknown[]) => unknown)(...a);
export const useInsertionEffect = (...a: unknown[]) => (__impl().useInsertionEffect as (..._: unknown[]) => unknown)(...a);
export const useCallback = (...a: unknown[]) => (__impl().useCallback as (..._: unknown[]) => unknown)(...a);
export const useRef = (...a: unknown[]) => (__impl().useRef as (..._: unknown[]) => unknown)(...a);
export const useMemo = (...a: unknown[]) => (__impl().useMemo as (..._: unknown[]) => unknown)(...a);
export const useReducer = (...a: unknown[]) => (__impl().useReducer as (..._: unknown[]) => unknown)(...a);
export const useContext = (...a: unknown[]) => (__impl().useContext as (..._: unknown[]) => unknown)(...a);
export const useId = () => (__impl().useId as () => string)();
export const useImperativeHandle = (...a: unknown[]) => (__impl().useImperativeHandle as (..._: unknown[]) => unknown)(...a);
export const useDebugValue = (...a: unknown[]) => (__impl().useDebugValue as (..._: unknown[]) => unknown)(...a);
export const useTransition = () => (__impl().useTransition as () => unknown)();
export const useDeferredValue = (...a: unknown[]) => (__impl().useDeferredValue as (..._: unknown[]) => unknown)(...a);
export const useSyncExternalStore = (...a: unknown[]) => (__impl().useSyncExternalStore as (..._: unknown[]) => unknown)(...a);
export const useOptimistic = (...a: unknown[]) => (__impl().useOptimistic as (..._: unknown[]) => unknown)(...a);
export const useActionState = (...a: unknown[]) => (__impl().useActionState as (..._: unknown[]) => unknown)(...a);
export const use = (...a: unknown[]) => (__impl().use as (..._: unknown[]) => unknown)(...a);

/* ── 组件工具 ── */
export const forwardRef = (...a: unknown[]) => (__impl().forwardRef as (..._: unknown[]) => unknown)(...a);
export const memo = (...a: unknown[]) => (__impl().memo as (..._: unknown[]) => unknown)(...a);
export const lazy = (...a: unknown[]) => (__impl().lazy as (..._: unknown[]) => unknown)(...a);
export const startTransition = (...a: unknown[]) => (__impl().startTransition as (..._: unknown[]) => unknown)(...a);
export const createContext = (...a: unknown[]) => (__impl().createContext as (..._: unknown[]) => unknown)(...a);
export const createFactory = (...a: unknown[]) => (__impl().createFactory as (..._: unknown[]) => unknown)(...a);
export const version = 'host-injected';

/* Children 是命名空间对象：按属性动态转发（React.Children.map 等）。 */
export const Children = new Proxy({}, {
  get: (_, k: string) => (__impl().Children as Record<string, unknown>)[k],
});

/* 默认导出：`import React from 'react'` 的所有成员访问动态转发。 */
export default new Proxy({}, {
  get: (_, k: string) => (__impl() as Record<string, unknown>)[k],
});
