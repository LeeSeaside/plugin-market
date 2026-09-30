/** 运行环境契约的最小类型面（完整定义见主仓库 frontend/src/plugins/）。 */

declare module 'virtual:tailwind.css' {
  const css: string;
  export default css;
}

declare global {
  interface Window {
    /** Locus 插件注册钩子：bundle 求值时由宿主临时挂载。 */
    __OMP_PLUGIN__(factory: { apply(ctx: LocusPluginCtx): unknown }): void;
  }
}

export interface LocusPluginCtx {
  id: string;
  React: Record<string, unknown>;
  beui: Record<string, unknown>;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  api: {
    invoke(channel: string, payload?: unknown): Promise<unknown>;
    theme: {
      tokens(): Record<string, string>;
      subscribe(cb: () => void): { dispose(): void };
    };
  };
  ui: {
    registerPane(paneId: string, component: unknown): void;
    registerCard?(cardId: string, component: unknown): void;
  };
}

export {};
