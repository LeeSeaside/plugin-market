# Locus 打包式插件模板

把「源码工程 → 单文件 client.js 产物」的完整链路装进一个可拷贝的目录。
宿主与市场合约**不变**：产物仍是 `window.__OMP_PLUGIN__({ apply(ctx) })` 的
单文件文本。

## 起步

```bash
# 1. 整目录拷成你的工程（目录名任意，manifest.id 决定插件身份）
cp -r plugins-src/_template plugins-src/my-plugin
cd plugins-src/my-plugin

# 2. 装依赖（全是构建期依赖，用户机器零安装）
npm i

# 3. 写 src/main.tsx（组件随便用 npm 库 / Tailwind 类）

# 4. 构建 → 产物直写 dist/client.js
npm run build          # 或 npm run watch（改码自动重建）

# 5. 部署：把 dist/client.js 连同 manifest.json 放进插件目录
#    （Windows: %APPDATA%/omp-desk/plugins/my-plugin/）
```

`package.json` 的 `locusPlugin.out` 支持直接指到插件目录
（如 `"out": "../../../locus-usage/client.js"`），build 后免拷贝。

## 硬规矩（违反即运行期报错）

1. **apply 第一行 `__injectReact(ctx.React)`** —— bundle 里没有第二份 React，
   `react` 的 import 全部委托宿主实例（`src/impl/`）。
2. **根元素带 `data-omp-tw`** —— Tailwind theme 变量被 build 后处理收进该
   作用域（防与宿主 token 撞名，如 `--font-mono`）。
3. **颜色一律消费宿主 CSS 变量**（`var(--fg-primary)` / `var(--bg-panel)` /
   `var(--accent)` …），三主题（亮/暗/高对比）自动跟随。

## 产物与审计

- 默认**不压缩**：`dist/client.js` 保持可读（转译但保留命名），人审友好。
- `npm run build -- --minify` 才压缩；市场提交建议带未压缩版。
- `--out <path>` 覆盖输出路径。

## 架构速记

```
src/main.tsx            入口：__OMP_PLUGIN__ 注册 + 样式注入
src/impl/react.ts       react 替身 → 宿主 ctx.React（esbuild alias）
src/impl/jsx-runtime.ts jsx 运行时替身（同上）
src/impl/react-core.ts  注入核心（__injectReact / __impl）
src/tw.css              Tailwind 入口（只 theme+utilities，无 preflight）
scripts/build.mjs       tailwind → 作用域改写 → esbuild 单文件
```
