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
 *   git.status  {}                        → { branch, upstream, ahead, behind, files[] }
 *   git.log     { n? }                    → [{ hash, short, author, date, subject }]
 *   git.diff    { path?, cached? }        → { text }
 *   git.stage   { paths: string[] }       → { ok: true }（'.' = 全部）
 *   git.unstage { paths: string[] }       → { ok: true }
 *   git.commit  { message }               → { ok: true, output }
 *   git.push    {}                        → { ok: true, output }
 *   git.pull    {}                        → { ok: true, output }
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOCAL_TIMEOUT_MS = 15_000;
const NET_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 512 * 1024;
const DEFAULT_LOG_N = 30;

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

/** %H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e 解析。 */
function parseLog(text) {
  return text
    .split('\x1e')
    .map((s) => s.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''))
    .filter((s) => s.length > 0)
    .map((s) => {
      const [hash, short, author, date, ...subject] = s.split('\x1f');
      return { hash, short, author, date, subject: subject.join('\x1f') };
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
      ['log', `-n`, String(n), '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'],
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

export async function activate(host) {
  host.log('info', 'git 工作台 host 半已激活');

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
          const output = await git(['push'], { cwd: params.workspace, timeoutMs: NET_TIMEOUT_MS });
          return { ok: true, output: output.trim() };
        }
        case 'git.pull': {
          const output = await git(['pull', '--ff-only'], {
            cwd: params.workspace,
            timeoutMs: NET_TIMEOUT_MS,
          });
          return { ok: true, output: output.trim() };
        }
        default:
          throw new Error(`未知方法：${method}`);
      }
    },
  };
}

export default { activate };
