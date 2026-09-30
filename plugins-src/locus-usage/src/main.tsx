/**
 * 用量统计（com.locus.usage）· 渲染半 —— 打包式工程版（瘦入口）。
 *
 * 这个文件刻意只做三件事：注入宿主 React、注入 Tailwind 产物 CSS、
 * **在 apply 内动态 import 面板实现**（src/pane.tsx）。recharts / motion
 * 的模块初始化（forwardRef / createContext）发生在模块求值期，静态
 * import 会让它跑到 __injectReact 之前 —— 这是打包式插件接重组件库的
 * 硬约束，详见 pane.tsx 头注。
 */
import { __injectReact } from './impl/react-core';
import twCss from 'virtual:tailwind.css';

const STYLE_ID = 'locus-usage-tw';

window.__OMP_PLUGIN__({
  apply(ctx) {
    __injectReact(ctx.React);

    // Tailwind 产物 CSS（theme 变量已收进 [data-omp-tw] 作用域）一次性注入。
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = twCss;
      document.head.appendChild(el);
    }

    // 重模块图延迟初始化（esbuild 内联动态 import = 首次调用才执行模块 init）。
    import('./pane')
      .then(({ UsagePane }) => {
        ctx.ui.registerPane('locus.usage', UsagePane);
        ctx.logger.info('用量统计面板（amicro mono-charts 组件版）已就绪');
      })
      .catch((e: unknown) => ctx.logger.error('面板加载失败: ' + String((e as Error)?.stack ?? e)));
  },
});
