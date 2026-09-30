/**
 * Locus 打包式插件构建器（模板共享，项目内 `npm run build`）。
 *
 * 产物 = 单文件 client.js（IIFE 文本），仍是宿主 `new Function` 求值的合法
 * 形态 —— 市场合约不变。链路：
 *
 *   1. @tailwindcss/cli 编译 src/tw.css → dist/tw.css（内容扫描 src/）
 *      ⚠️ theme 层默认发射到 `:root`，会与宿主 token 撞名（--font-mono 等）。
 *      构建后处理：把 `:root, :host` 选择器改写为 [data-omp-tw]，主题变量
 *      只在插件根子树内解析，宿主零污染。插件根元素必须带该属性。
 *   2. esbuild 打包 src/main.tsx：
 *      - `react` / `react/jsx-runtime` 别名到 src/impl/（运行期委托宿主
 *        ctx.React，bundle 里不进第二份 React —— 否则 hooks 直接炸）；
 *      - `virtual:tailwind.css` 以 text 内联进产物，apply 时注入 <style>；
 *      - 默认不压缩（保可审计性），`--minify` 才压缩。
 *   3. 产物写到 package.json `locusPlugin.out` 指定的路径（缺省 dist/client.js）。
 *
 * 用法：node scripts/build.mjs [--watch] [--minify] [--out <path>]
 */

import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url)); // scripts/
const proj = resolve(root, '..');
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'));
const conf = pkg.locusPlugin ?? {};
const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const MINIFY = args.includes('--minify');
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const OUT = resolve(proj, outArg ?? conf.out ?? 'dist/client.js');

const SCOPE = conf.scopeAttr ?? '[data-omp-tw]';
const TW_IN = join(proj, 'src/tw.css');
const TW_OUT = join(proj, 'dist/tw.css');

function runTailwind() {
  const cliPkgPath = require.resolve('@tailwindcss/cli/package.json');
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'));
  const bin = cliPkg.bin?.['tailwindcss'] ?? cliPkg.bin;
  const cliJs = join(dirname(cliPkgPath), bin);
  const r = spawnSync(process.execPath, [cliJs, '-i', TW_IN, '-o', TW_OUT], {
    stdio: WATCH ? 'pipe' : 'inherit',
    cwd: proj,
  });
  if (r.status !== 0) throw new Error(`tailwind 编译失败（exit ${r.status}）${r.stderr?.toString() ?? ''}`);
}

/** theme 层的 `:root, :host` → 插件作用域（见文件头 ⚠️）。 */
function scopeTheme(css) {
  return css
    .replace(/:root\s*,\s*:host\s*\{/g, `${SCOPE}{`)
    .replace(/:root\s*\{/g, `${SCOPE}{`)
    .replace(/:host\s*\{/g, `${SCOPE}{`);
}

/** esbuild 虚拟模块：`import twCss from 'virtual:tailwind.css'`。 */
const twCssPlugin = {
  name: 'locus-tw-css',
  setup(b) {
    b.onResolve({ filter: /^virtual:tailwind\.css$/ }, () => ({
      path: 'virtual:tailwind.css',
      namespace: 'locus-tw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'locus-tw' }, () => {
      const css = readFileSync(TW_OUT, 'utf8');
      return { contents: scopeTheme(css), loader: 'text', watchFiles: [TW_OUT] };
    });
  },
};

const esbuildOpts = {
  entryPoints: [join(proj, conf.entry ?? 'src/main.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  alias: {
    react: join(proj, 'src/impl/react.ts'),
    'react/jsx-runtime': join(proj, 'src/impl/jsx-runtime.ts'),
    'react/jsx-dev-runtime': join(proj, 'src/impl/jsx-runtime.ts'),
  },
  define: { 'process.env.NODE_ENV': '"production"', 'global': 'globalThis' },
  plugins: [twCssPlugin],
  minify: MINIFY,
  sourcemap: false,
  legalComments: 'inline',
  outfile: join(proj, 'dist/bundle.js'),
  logLevel: 'info',
};

function emit() {
  const js = readFileSync(join(proj, 'dist/bundle.js'), 'utf8');
  if (!js.includes('__OMP_PLUGIN__')) {
    throw new Error('产物缺少 window.__OMP_PLUGIN__ 注册调用 —— 检查入口文件');
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, js);
  const kb = (Buffer.byteLength(js) / 1024).toFixed(1);
  console.log(`[locus-plugin] ${pkg.name} → ${OUT} (${kb} KB${MINIFY ? '' : ', unminified'})`);
}

async function once() {
  rmSync(join(proj, 'dist'), { recursive: true, force: true });
  runTailwind();
  await build(esbuildOpts);
  emit();
}

if (!WATCH) {
  await once();
} else {
  // watch：esbuild context 常驻；产物落盘挂在 onEnd 插件里。
  // .css 变更 → 重跑 tailwind → dist/tw.css 变化（watchFiles 里）→ esbuild 自动重建。
  const emitPlugin = {
    name: 'locus-emit',
    setup(b) {
      b.onEnd(() => {
        try {
          emit();
        } catch (e) {
          console.error(String(e));
        }
      });
    },
  };
  runTailwind();
  const ctx = await context({ ...esbuildOpts, plugins: [...esbuildOpts.plugins, emitPlugin] });
  await ctx.watch();
  const { watch } = await import('node:fs');
  watch(join(proj, 'src'), { recursive: true }, (_ev, file) => {
    if (String(file).endsWith('.css')) {
      try {
        runTailwind();
      } catch (e) {
        console.error(String(e));
      }
    }
  });
  console.log('[locus-plugin] watch 中 —— 改 src 下任意文件自动重建到 OUT');
}
