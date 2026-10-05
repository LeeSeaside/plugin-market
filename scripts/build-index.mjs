#!/usr/bin/env node
/**
 * plugin-market · index.json 生成器（发布脚本）
 *
 * 用法：node scripts/build-index.mjs [repoRoot] [--no-purge]
 *   repoRoot 默认 = 本脚本上两级（仓库根）。
 *   --no-purge：只生成 index.json，不做 jsDelivr purge —— 供「仅重算索引、
 *   尚未 push」的本地重生成用（purge 打在旧内容上毫无意义，发布 = push 后
 *   再跑本脚本不带该标志）。
 *
 * 行为：扫描仓库根下的一级目录（排除 scripts/ 等），每个目录视为一个插件包：
 *   - 必须有 manifest.json（id 需与目录名一致；version 非空）
 *   - 收集包内全部文本文件（UTF-8；二进制不走市场链——安装管线按文本传输）
 *   - 逐文件算 sha256（小写 hex）与 bytes
 * 生成/覆盖仓库根的 index.json（schema:1），plugins[].manifest 为内联全文，
 * 与服务端 plugin-market-service 的 normalizeEntry 严格同形：
 *   id/name/version/apiVersion/description?/author?/path/manifest/files[]
 *
 * 发布 = git add -A && git commit && git push（raw 直读，无独立发布服务）。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const NO_PURGE = argv.includes('--no-purge');
const root = argv.find((a) => !a.startsWith('--')) ?? join(here, '..');

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
/** 与服务端 REPO_PATH_RE 同款：市场 path（=仓库目录名）禁点号，故目录名
 *  不能用带点的插件 id —— id 带点、目录无点（如 com.locus.git → locus-git）。 */
const REPO_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;
// template/ 是官方第三方开发模板（复制起点，不是可安装商品），不进索引。
const SKIP_DIRS = new Set(['scripts', '.git', 'node_modules']);
const SKIP_FILES = new Set(['index.json', 'README.md', '.gitignore', 'LICENSE']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 递归收集目录下全部文件（相对 repo 根的 POSIX 路径）。 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(full));
    } else if (!SKIP_FILES.has(name)) {
      out.push(full);
    }
  }
  return out;
}

const plugins = [];
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (!statSync(dir).isDirectory() || SKIP_DIRS.has(name)) continue;
  if (!REPO_PATH_RE.test(name)) {
    console.error(
      `[skip] ${name}: 目录名非法 —— 市场 path 只允许 [A-Za-z0-9/_-]（禁点号）。` +
        `目录改用无点短名，插件 id 仍可带点（见 manifest.id）。`,
    );
    continue;
  }

  const manifestPath = join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    console.error(`[skip] ${name}: manifest.json 缺失或不是合法 JSON`);
    continue;
  }
  const id = typeof manifest.id === 'string' ? manifest.id : '';
  if (!ID_RE.test(id)) {
    console.error(`[skip] ${name}: manifest.id（${id}）缺失或非法`);
    continue;
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    console.error(`[skip] ${name}: manifest.version 缺失`);
    continue;
  }

  const files = walk(dir).map((full) => {
    // files[].name 相对**插件目录**（不是仓库根）——与服务端两条链严格同形：
    // 下载 URL = `<index目录>/<path>/<name>`；install 落盘 = `<pluginsDir>/<id>/<name>`。
    const rel = relative(dir, full).split(sep).join('/');
    const buf = readFileSync(full);
    return { name: rel, sha256: sha256(buf), bytes: buf.byteLength };
  });
  if (!files.some((f) => f.name === 'manifest.json')) {
    console.error(`[skip] ${name}: 文件清单缺 manifest.json`);
    continue;
  }

  plugins.push({
    id,
    name: typeof manifest.name === 'string' ? manifest.name : id,
    version: manifest.version,
    apiVersion: typeof manifest.apiVersion === 'number' ? manifest.apiVersion : 1,
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    ...(typeof manifest.author === 'string' ? { author: manifest.author } : {}),
    path: name,
    manifest,
    files,
  });
  console.log(`[ok] ${id} v${manifest.version} · ${files.length} files`);
}

if (plugins.length === 0) {
  console.error('没有可用插件条目 —— index.json 不生成（避免把市场清空）');
  process.exit(1);
}

const index = {
  schema: 1,
  updatedAt: new Date().toISOString(),
  plugins,
};
writeFileSync(join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`index.json written · ${plugins.length} plugins`);

// ---- jsDelivr 边缘缓存 purge（@main 分支内容有约 12h 缓存，发布后必须刷）----
// 失败仅警告不阻塞：purge 不通时 jsDelivr 到期也会自行刷新，只是有延迟。
// --no-purge 时整段跳过（见文件头用法）：索引本地重生成、还没 push 时，
// purge 只会打到 CDN 上的旧内容上，属无效操作。
if (NO_PURGE) {
  console.log('skip jsDelivr purge（--no-purge：发布 = push 后重跑本脚本，不带该标志）');
} else {
  const GH_BASE = 'https://cdn.jsdelivr.net/gh/LeeSeaside/plugin-market@main';
  const PURGE_BASE = 'https://purge.jsdelivr.net/gh/LeeSeaside/plugin-market@main';
  const purgeTargets = ['index.json', ...plugins.flatMap((p) => p.files.map((f) => `${p.path}/${f.name}`))];
  for (const t of purgeTargets) {
    try {
      const res = await fetch(`${PURGE_BASE}/${t}`, { signal: AbortSignal.timeout(10_000) });
      console.log(`purge ${t}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`purge ${t} 失败（忽略，等待 jsDelivr 自行刷新）: ${e?.cause?.code ?? e?.message ?? e}`);
    }
  }
  console.log(`jsDelivr 预览: ${GH_BASE}/index.json`);
}
