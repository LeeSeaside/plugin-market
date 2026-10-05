/*!
 * Git 工作台 · Host 半（com.locus.git）
 *
 * runner 契约（backend/src/plugins-host/runner.mjs）：每插件一进程的全权 Node
 * 子进程，ESM `activate(host)` 入口，返回 `{ request(method, params) }` 供
 * parent→插件 RPC。本插件不用 broker 能力闭集（fs.workspace 等）——直接用
 * node:child_process 执行 git，凭据由 git 自行读取系统 credential helper
 * （与用户在终端操作完全同权）。
 *
 * 注入参数（capability-handlers.ts 的 omp:plugin-host:invoke，服务端事实源）：
 *   params.workspace  活动工作区绝对路径（每次调用注入，防过期）
 *
 * 方法面（全部 cwd=workspace）：
 *   git.status    {}                        → { branch, upstream, ahead, behind, files[] }
 *   git.log       { n? }                    → [{ hash, short, author, date, subject, parents[], refs[] }]
 *   git.diff      { path?, cached? }        → { text }
 *   git.stage     { paths: string[] }       → { ok: true }（'.' = 全部）
 *   git.unstage   { paths: string[] }       → { ok: true }
 *   git.commit    { message }               → { ok: true, output }
 *   git.push      {}                        → { ok: true, output }
 *   git.pull      {}                        → { ok: true, output }
 *   git.branches  {}                        → [{ name, current }]
 *   git.branchCreate  { name }              → { ok: true }（新建并切换）
 *   git.branchSwitch  { name }              → { ok: true }
 *   git.stashList {}                        → [{ ref, subject }]
 *   git.stash     { message? }              → { ok: true }（含未跟踪，-u）
 *   git.stashPop  {}                        → { ok: true }
 *   git.version   {}                        → { v, watched }
 *
 * 文件监听（1.1.0）：fs.watch(workspace, recursive) 自盯工作区（忽略 .git/），
 * 800ms 防抖后递增内存版本号；渲染半 2s 轮询 git.version（零 git 调用），
 * 版本变了才拉全量 —— 事件桥不通渲染层（fanoutDeskEvent 只达插件进程），
 * 「计数器 + 轮询」是免核心改动的推送等价物。平台不支持 recursive 时静默
 * 降级（watched=false），客户端回到既有的手动刷新路径。
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_TIMEOUT_MS = 15_000;
const NET_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 512 * 1024;
const DEFAULT_LOG_N = 30;
const WATCH_DEBOUNCE_MS = 800;

/** git.exe 解析缓存（解析一次，进程内复用）。 */
let gitExe = null;

/** 从注册表读 Git for Windows 安装目录（terminal 插件同款手法）。 */
function regQueryGitPath() {
  // reg.exe 用绝对路径调 —— 本插件的宿主进程链 PATH 常常不完整（这正是
  // spawn git ENOENT 的根因），不能指望 'reg.exe' 可解析。
  const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  try {
    const out = execFileSync(
      regExe,
      ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 解析 git 可执行文件。桌面 GUI 进程链（Explorer → cmd → Electron →
 * utilityProcess）继承的 PATH 常常没有 git —— spawn git ENOENT 的根因。
 * 顺序：先常见安装位置与注册表，最后才回落裸 'git'（PATH）。
 */
let resolveDiag = '';
function resolveGitExe() {
  if (gitExe) return gitExe;
  const diag = [];
  const tryPath = (c) => {
    let ok = false;
    try {
      ok = fs.existsSync(c) && fs.statSync(c).isFile();
    } catch {
      ok = false;
    }
    diag.push((ok ? 'HIT ' : 'miss') + ' ' + c);
    return ok;
  };
  const candidates = [];
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const lac = process.env.LOCALAPPDATA;
  diag.push('ProgramFiles=' + (pf || '(unset)') + ' LOCALAPPDATA=' + (lac || '(unset)'));
  if (pf) candidates.push(path.join(pf, 'Git', 'cmd', 'git.exe'));
  if (pf) candidates.push(path.join(pf, 'Git', 'bin', 'git.exe'));
  if (pf86) candidates.push(path.join(pf86, 'Git', 'cmd', 'git.exe'));
  if (lac) candidates.push(path.join(lac, 'Programs', 'Git', 'cmd', 'git.exe'));
  // 便携/自定义盘安装（如 D:\\Git）：逐盘符扫 <drive>:\\Git\\cmd\\git.exe
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(letter + ':\\\\Git\\\\cmd\\\\git.exe');
  }
  const reg = regQueryGitPath();
  diag.push('registry=' + (reg || '(miss)'));
  if (reg) candidates.push(path.join(reg, 'cmd', 'git.exe'));
  for (const c of candidates) {
    if (tryPath(c)) {
      gitExe = c;
      return c;
    }
  }
  resolveDiag = diag.join(' | ');
  gitExe = 'git'; // 回落：交给 PATH（Linux/macOS 或 PATH 完好的场景）
  return gitExe;
}

/** 执行 git（argv 数组传参，无 shell，无注入面）。stderr 摘要进 Error.message。 */
function git(args, opts = {}) {
  const cwd = opts.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return Promise.reject(new Error('未打开工作区（workspace 未注入）'));
  }
  // cwd 不存在时 spawn 会报 **ENOENT** —— 与"exe 找不到"同形，曾被误诊为
  // "找不到 git"。先校验并点名具体目录。
  if (!fs.existsSync(cwd)) {
    return Promise.reject(new Error('工作区目录不存在或不可访问：' + cwd + ' —— 请在设置里切换到有效的工作区'));
  }
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  return new Promise((resolve, reject) => {
    execFile(
      resolveGitExe(),
      fullArgs,
      {
        cwd,
        timeout: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(
              new Error(
                'git spawn ENOENT。环境诊断：' + (resolveDiag || '(解析未运行)') +
                ' ；cwd=' + cwd + '（若 cwd 存在仍 ENOENT，则确为 exe 问题）—— 请安装 Git for Windows 或把其 cmd 目录加入系统 PATH',
              ),
            );
            return;
          }
          const reason = String(stderr || err.message || '').trim().split('\n').slice(-4).join('\n');
          const e = new Error(reason || `git ${args[0]} 失败`);
          e.gitCode = err.code;
          e.gitKilled = err.killed === true;
          reject(e);
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

/** 网络类操作（push/pull）超时被杀时的可行动指引。1.1.1 文案级缓解：本轮
 * 不做 TTY 交互，卡死的常见原因（交互式凭据提示 / 大仓库）只能靠提示用户
 * 去系统终端手动确认。仅对 gitKilled（超时终止）附加，正常失败不掺水。 */
function withNetTimeoutHint(err, op) {
  if (err && err.gitKilled === true) {
    const hint =
      `git ${op} 超时（${NET_TIMEOUT_MS / 1000}s）被终止 —— 交互式凭据输入提示或大仓库都可能卡住。` +
      `若持续失败，请在系统终端手动执行确认凭据状态。`;
    const raw =
      err.message && err.message !== `git ${op} 失败` ? '\n' + err.message : '';
    err.message = hint + raw;
  }
  return err;
}

/** porcelain v1 -b 解析。untracked（??）归入未暂存域。 */
function parseStatus(text) {
  const lines = text.split('\n');
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const bracket = head.match(/\[(.+?)\]\s*$/);
      if (bracket) {
        const aheadM = bracket[1].match(/ahead (\d+)/);
        const behindM = bracket[1].match(/behind (\d+)/);
        if (aheadM) out.ahead = Number(aheadM[1]);
        if (behindM) out.behind = Number(behindM[1]);
      }
      const dots = head.indexOf('...');
      if (dots >= 0) {
        out.branch = head.slice(0, dots);
        const rest = head.slice(dots + 3);
        const upEnd = rest.search(/(\s\[|$)/);
        out.upstream = (upEnd >= 0 ? rest.slice(0, upEnd) : rest).trim() || null;
      } else {
        out.branch = head.replace(/\s*\[.*\]\s*$/, '').trim() || null;
      }
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    let prevPath = null;
    if (path.includes(' -> ')) {
      const idx = path.indexOf(' -> ');
      prevPath = path.slice(0, idx);
      path = path.slice(idx + 4);
    }
    out.files.push({
      path,
      prevPath,
      x,
      y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ',
      untracked: x === '?' && y === '?',
      label: x === 'R' || y === 'R' ? `${prevPath} → ${path}` : path,
    });
  }
  return out;
}

/** %H%x1f…%P%x1f%D%x1e 解析。parents 按 ' ' 拆，refs 按 ', ' 拆（空 → []）。 */
function parseLog(text) {
  return text
    .split('\x1e')
    .map((s) => s.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''))
    .filter((s) => s.length > 0)
    .map((s) => {
      const [hash, short, author, date, subject, parents, refs] = s.split('\x1f');
      return {
        hash,
        short,
        author,
        date,
        subject: typeof subject === 'string' ? subject : '',
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        refs: refs ? refs.split(', ').map((r) => r.trim()).filter(Boolean) : [],
      };
    });
}

/** git stash list 行（%gd%x1f%gs%x1e）解析。 */
function parseStashList(text) {
  return text
    .split('\x1e')
    .map((s) => s.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''))
    .filter((s) => s.length > 0)
    .map((s) => {
      const [ref, subject] = s.split('\x1f');
      return { ref, subject: subject ?? '' };
    });
}

/** git branch --format=%(refname:short)%00%(HEAD) 解析 → [{ name, current }]。 */
function parseBranches(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf('\x00');
      const name = idx >= 0 ? l.slice(0, idx) : l;
      const head = idx >= 0 ? l.slice(idx + 1) : '';
      return { name, current: head.trim() === '*' };
    });
}

async function statusRequest(params) {
  const text = await git(['status', '--porcelain=v1', '-b'], { cwd: params.workspace });
  return parseStatus(text);
}

async function logRequest(params) {
  const n = Math.min(Math.max(Number(params.n) || DEFAULT_LOG_N, 1), 200);
  try {
    const text = await git(
      [
        'log',
        `-n`,
        String(n),
        '--date=format:%Y-%m-%d %H:%M',
        // 1.1.0：追加 %P（parents，提交图车道用）与 %D（refs，徽标用）
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%P%x1f%D%x1e',
      ],
      { cwd: params.workspace },
    );
    return parseLog(text);
  } catch (err) {
    // 空仓库（没有任何提交）：git log 以非零退出 —— 这是合法初始状态，返回空。
    if (/does not have any commits yet|ambiguous argument 'HEAD'/i.test(err.message)) return [];
    throw err;
  }
}

async function pathsOf(params) {
  const p = params.paths;
  if (params.path && typeof params.path === 'string') return [params.path];
  if (Array.isArray(p)) {
    const list = p.filter((v) => typeof v === 'string' && v.length > 0);
    if (list.length === 0) throw new Error('paths 不能为空');
    return list;
  }
  if (p === '.') return ['.'];
  throw new Error('需要 paths（字符串数组或 "."）');
}

/* ---- 文件监听（1.1.0）----------------------------------------------------
 * 一个插件进程同时只盯一个工作区（workspace 注入随每次调用，切换时重挂）。
 * 忽略 .git/ 下的事件：status/add/commit 都写 .git，不过滤会自激。 */
let watcher = null;
let watchedDir = null;
let watchVersion = 0;
let debounceTimer = null;

function bumpVersion() {
  watchVersion += 1;
}

function onWatchEvent(filename) {
  if (typeof filename === 'string' && filename) {
    const norm = filename.replace(/\\/g, '/');
    if (norm === '.git' || norm.startsWith('.git/')) return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(bumpVersion, WATCH_DEBOUNCE_MS);
  // 不阻塞插件进程退出
  debounceTimer.unref?.();
}

function ensureWatcher(workspace) {
  if (watchedDir === workspace && watcher) return;
  teardownWatcher();
  watchedDir = workspace;
  try {
    // recursive 仅 Windows/macOS 支持；Linux 抛错 → 静默降级（watched=false）
    watcher = fs.watch(workspace, { recursive: true }, onWatchEvent);
    watcher.on('error', () => {
      teardownWatcher();
      watchedDir = workspace; // 目录没变，只是不再监听
    });
  } catch {
    watcher = null;
  }
}

function teardownWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 已关 */
    }
  }
  watcher = null;
  watchedDir = null;
}

/** 分支名校验：拒绝空串/前导'-'/'..'与 git 引用非法字符（~:^?*[\\ 与空白）。 */
function validRefName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('-') &&
    !name.includes('..') &&
    !/[\s~:^?*\[\\]/.test(name)
  );
}

export async function activate(host) {
  host.log('info', 'git 工作台 host 半已激活');
  process.on('exit', teardownWatcher);

  return {
    async request(method, params = {}) {
      switch (method) {
        case 'git.status':
          return statusRequest(params);
        case 'git.log':
          return logRequest(params);
        case 'git.diff': {
          const args = ['diff'];
          if (params.cached) args.push('--cached');
          args.push('--');
          if (typeof params.path === 'string' && params.path) args.push(params.path);
          return { text: await git(args, { cwd: params.workspace }) };
        }
        case 'git.stage': {
          const paths = await pathsOf(params);
          await git(['add', '--', ...paths], { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.unstage': {
          const paths = await pathsOf(params);
          await git(['reset', '-q', 'HEAD', '--', ...paths], { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.commit': {
          const message = typeof params.message === 'string' ? params.message.trim() : '';
          if (!message) throw new Error('提交信息不能为空');
          const output = await git(['commit', '-m', message], { cwd: params.workspace });
          return { ok: true, output: output.trim() };
        }
        case 'git.push': {
          try {
            const output = await git(['push'], { cwd: params.workspace, timeoutMs: NET_TIMEOUT_MS });
            return { ok: true, output: output.trim() };
          } catch (err) {
            throw withNetTimeoutHint(err, 'push');
          }
        }
        case 'git.pull': {
          try {
            const output = await git(['pull', '--ff-only'], {
              cwd: params.workspace,
              timeoutMs: NET_TIMEOUT_MS,
            });
            return { ok: true, output: output.trim() };
          } catch (err) {
            throw withNetTimeoutHint(err, 'pull');
          }
        }
        case 'git.branches': {
          const text = await git(['branch', '--list', '--format=%(refname:short)%00%(HEAD)'], {
            cwd: params.workspace,
          });
          return parseBranches(text);
        }
        case 'git.branchCreate': {
          const name = typeof params.name === 'string' ? params.name.trim() : '';
          if (!validRefName(name)) throw new Error('非法分支名：' + (name || '（空）'));
          await git(['checkout', '-b', name], { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.branchSwitch': {
          const name = typeof params.name === 'string' ? params.name.trim() : '';
          if (!validRefName(name)) throw new Error('非法分支名：' + (name || '（空）'));
          await git(['checkout', name], { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.stashList': {
          const text = await git(['stash', 'list', '--format=%gd%x1f%gs%x1e'], {
            cwd: params.workspace,
          });
          return parseStashList(text);
        }
        case 'git.stash': {
          const args = ['stash', 'push', '-u'];
          if (typeof params.message === 'string' && params.message.trim()) {
            args.push('-m', params.message.trim());
          }
          await git(args, { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.stashPop': {
          await git(['stash', 'pop'], { cwd: params.workspace });
          return { ok: true };
        }
        case 'git.version': {
          ensureWatcher(params.workspace);
          return { v: watchVersion, watched: watcher !== null };
        }
        default:
          throw new Error(`未知方法：${method}`);
      }
    },
  };
}

export default { activate };
