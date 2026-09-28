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
import { execFile } from 'node:child_process';

const LOCAL_TIMEOUT_MS = 15_000;
const NET_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 512 * 1024;
const DEFAULT_LOG_N = 30;

/** 执行 git（argv 数组传参，无 shell，无注入面）。stderr 摘要进 Error.message。 */
function git(args, opts = {}) {
  const cwd = opts.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return Promise.reject(new Error('未打开工作区（workspace 未注入）'));
  }
  const fullArgs = ['-c', 'core.quotepath=false', ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
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
