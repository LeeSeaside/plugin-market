/**
 * 模板示例入口 —— 一个最小但完整的 Locus 插件（打包式）。
 *
 * 规矩只有三条：
 *   1. apply 第一行必须 `__injectReact(ctx.React)`（hooks 依赖宿主实例）；
 *   2. 所有颜色消费宿主 CSS 变量（var(--fg-primary) / var(--bg-panel) /
 *      var(--accent) …），三主题自动跟随，不要写死色值；
 *   3. 根元素带 data-omp-tw 属性（Tailwind theme 变量的作用域，见 build.mjs）。
 *
 * Tailwind 类随便用（bg-panel 这种是本插件 tw.css @theme 自定义的示例），
 * npm 组件（recharts 等）直接 import —— 构建期全部解析打进单文件产物。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { __injectReact } from './impl/react-core';
import twCss from 'virtual:tailwind.css';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-2 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest opacity-60">
        Template Pane
      </div>
      <div className="font-mono text-3xl font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
        {now.toLocaleTimeString()}
      </div>
      <div className="text-xs" style={{ color: 'var(--fg-muted)' }}>
        打包式插件模板：React(宿主实例) + Tailwind + esbuild 单文件产物
      </div>
    </div>
  );
}

window.__OMP_PLUGIN__({
  apply(ctx) {
    __injectReact(ctx.React);

    // 动效 / Tailwind 样式一次性注入（幂等，重载安全）。
    const id = 'omp-tw-template';
    if (typeof document !== 'undefined' && !document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.textContent = twCss;
      document.head.appendChild(el);
    }

    ctx.ui.registerPane('example.template', Clock);
    ctx.logger.info('template 插件已就绪');
  },
});
