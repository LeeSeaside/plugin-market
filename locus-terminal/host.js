/**
 * com.locus.terminal · Host 半（hostEntry runner，全权 Node）
 *
 * 职责：真实终端进程的生命周期。经 host.require('@lydell/node-pty')（宿主
 * node_modules 的预编译 PTY）spawn 会话，输出缓冲由 renderer 轮询取走
 * （`term.read`）—— desk 事件总线 v1 无渲染器通道，invoke 桥（req-resp）是
 * 当前唯一的数据回程；50ms 轮询 + host 端聚合缓冲在本地延迟下足够顺滑。
 *
 * 方法（经 omp:plugin-host:invoke 桥，params 自带服务端注入的 workspace）：
 *   shells.list            → { shells: [{id,name,exe,args,kind,available}], notes? }
 *   term.open  {shellId,cwd,utf8} → { terminalId, profile }
 *   term.read  {terminalId}       → { data, exited, exitCode }   取走增量缓冲
 *   term.attach{terminalId}       → { replay, exited, exitCode } 面板重挂载回放
 *   term.write {terminalId,data}  → {}
 *   term.resize{terminalId,cols,rows} → {}
 *   term.close {terminalId}       → {}
 *
 * 设计边界：
 *   - 会话与面板解耦：面板卸载只停轮询，PTY 存活（attach 回放重连）；
 *     插件撤销 → runner 进程被杀 → 会话随之终结（进程即边界）。
 *   - 输出缓冲上限（1MB 环形丢弃头部）：`dir /s` 之类洪峰不会 OOM。
 *   - 编码：xterm 侧统一 UTF-8 解码，因此 PowerShell/CMD 在 auto 模式下经
 *     启动参数注入 chcp 65001；Git Bash / WSL 原生即 UTF-8，无需注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TERM_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 4;
const REPLAY_CAP = 256 * 1024; // attach 回放缓冲上限
const PENDING_CAP = 1024 * 1024; // 未读增量缓冲上限（超出丢头部）

/** @type {Map<string, {pty:any, buf:string, replay:string, exited:boolean, exitCode:number|null, shellId:string}>} */
const sessions = new Map();
let seq = 0;
let ptyMod = null;

function loadPty(host) {
  if (!ptyMod) {
    if (typeof host.require !== 'function') {
      throw new Error('runner 未提供 host.require（宿主过旧）——终端插件需要它加载 @lydell/node-pty');
    }
    ptyMod = host.require('@lydell/node-pty');
  }
  return ptyMod;
}

function exists(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 同步探测单个可执行文件（PATH + 固定位置）。 */
function findExe(candidates) {
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

function regQueryGitPath() {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'],
      { encoding: 'utf8', timeout: TERM_TIMEOUT_MS, windowsHide: true },
    );
    const m = /InstallPath\s+REG_SZ\s+(.+)/.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** wsl -l -q 的输出是 UTF-16LE（含 BOM/空行/进度回车），手动解码。 */
function listWslDistros(wslExe) {
  try {
    const buf = execFileSync(wslExe, ['-l', '-q'], {
      encoding: 'buffer',
      timeout: TERM_TIMEOUT_MS,
      windowsHide: true,
    });
    const text = buf.toString('utf16le').replace(/\0/g, '');
    const names = text
      .split(/\r?\n/)
      .map((s) => s.replace(/[\u0000-\u001f]/g, '').trim())
      .filter((s) => s.length > 0 && !s.includes('没有') && !/no .*install/i.test(s));
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/**
 * 组装 shell 候选。args 按 utf8 模式预置；真正 spawn 时 utf8 由 open 参数决定
 * （open 会按 profile 的 utf8Args/nativeArgs 选择），所以这里同时给两组。
 */
function buildProfiles() {
  const profiles = [];
  const windir = process.env.SystemRoot || 'C:\\Windows';
  const system32 = path.join(windir, 'System32');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const comspec = process.env.ComSpec || path.join(system32, 'cmd.exe');

  // ---- Windows PowerShell（恒存在）----
  const psExe = findExe([
    path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]);
  if (psExe) {
    profiles.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      exe: psExe,
      kind: 'ps',
      utf8Args: ['-NoLogo', '-NoExit', '-Command', 'chcp 65001 >nul'],
      nativeArgs: ['-NoLogo'],
    });
  }

  // ---- PowerShell 7+ ----
  const pwshExe = findExe([
    path.join(pf, 'PowerShell', '7', 'pwsh.exe'),
    path.join(pf, 'PowerShell', '8', 'pwsh.exe'),
  ]);
  if (pwshExe) {
    profiles.push({
      id: 'pwsh',
      name: 'PowerShell (pwsh)',
      exe: pwshExe,
      kind: 'ps',
      utf8Args: ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'],
      nativeArgs: ['-NoLogo'],
    });
  }

  // ---- CMD ----
  if (exists(comspec)) {
    profiles.push({
      id: 'cmd',
      name: '命令提示符',
      exe: comspec,
      kind: 'cmd',
      utf8Args: ['/k', 'chcp 65001 >nul'],
      nativeArgs: [],
    });
  }

  // ---- Git Bash ----
  const gitRoot = regQueryGitPath() || path.join(pf, 'Git');
  const bashExe = findExe([path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')]);
  if (bashExe) {
    profiles.push({
      id: 'gitbash',
      name: 'Git Bash',
      exe: bashExe,
      kind: 'bash',
      utf8Args: ['--login', '-i'],
      nativeArgs: ['--login', '-i'],
    });
  }

  // ---- WSL（每个发行版一条 profile）----
  const wslExe = findExe([path.join(system32, 'wsl.exe')]);
  if (wslExe) {
    for (const distro of listWslDistros(wslExe)) {
      profiles.push({
        id: `wsl:${distro}`,
        name: `WSL · ${distro}`,
        exe: wslExe,
        kind: 'wsl',
        utf8Args: ['-d', distro],
        nativeArgs: ['-d', distro],
      });
    }
  }
  return profiles;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(`终端会话不存在（可能已随插件重启清空）：${id}`);
  return s;
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.pty.kill();
  } catch {
    /* 已死 */
  }
}

export function activate(host) {
  const pty = loadPty(host);
  host.log('info', 'terminal host ready');

  return {
    async request(method, params = {}) {
      switch (method) {
        case 'shells.list': {
          const profiles = buildProfiles();
          return {
            shells: profiles.map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
              available: true,
            })),
          };
        }

        case 'term.open': {
          const profiles = buildProfiles();
          const wanted = String(params.shellId ?? 'auto');
          const utf8 = params.utf8 !== 'native';
          const profile =
            (wanted !== 'auto' ? profiles.find((p) => p.id === wanted) : null) ?? profiles[0];
          if (!profile) throw new Error('没有可用终端（未找到任何 shell）');
          if (sessions.size >= MAX_SESSIONS) {
            // 最旧的会话让位（面板层通常只挂一个；防失控兜底）。
            const oldest = sessions.keys().next().value;
            closeSession(oldest);
          }
          const cwd = exists(params.cwd) ? params.cwd : process.env.USERPROFILE || 'C:\\';
          const terminalId = `t${++seq}`;
          const args = utf8 ? profile.utf8Args : profile.nativeArgs;
          const ptySession = pty.spawn(profile.exe, args, {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
          const session = {
            pty: ptySession,
            buf: '',
            replay: '',
            exited: false,
            exitCode: null,
            shellId: profile.id,
          };
          sessions.set(terminalId, session);
          ptySession.onData((d) => {
            session.buf += d;
            session.replay += d;
            if (session.buf.length > PENDING_CAP) session.buf = session.buf.slice(-PENDING_CAP);
            if (session.replay.length > REPLAY_CAP) session.replay = session.replay.slice(-REPLAY_CAP);
          });
          ptySession.onExit(({ exitCode }) => {
            session.exited = true;
            session.exitCode = exitCode;
          });
          host.log('info', `term.open ${profile.id} → ${terminalId}`, { cwd });
          return { terminalId, profile: { id: profile.id, name: profile.name, kind: profile.kind } };
        }

        case 'term.read': {
          const s = getSession(String(params.terminalId));
          const data = s.buf;
          s.buf = '';
          return { data, exited: s.exited, exitCode: s.exitCode };
        }

        case 'term.attach': {
          const s = getSession(String(params.terminalId));
          return { replay: s.replay, exited: s.exited, exitCode: s.exitCode };
        }

        case 'term.write': {
          const s = getSession(String(params.terminalId));
          if (s.exited) return { ok: false };
          s.pty.write(String(params.data ?? ''));
          return { ok: true };
        }

        case 'term.resize': {
          const s = getSession(String(params.terminalId));
          const cols = Math.max(2, Math.min(500, Number(params.cols) || 80));
          const rows = Math.max(2, Math.min(300, Number(params.rows) || 24));
          try {
            s.pty.resize(cols, rows);
          } catch {
            /* 已死进程的 resize 是无害竞态 */
          }
          return { ok: true };
        }

        case 'term.close': {
          closeSession(String(params.terminalId));
          return { ok: true };
        }

        default:
          throw new Error(`未知方法：${method}`);
      }
    },
  };
}
