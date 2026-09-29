/**
 * com.locus.terminal · Client 半（同页求值工厂）
 *
 * 面板：工具栏（shell 按钮组 / UTF-8 开关 / 结束会话）+ xterm 终端区。
 * 数据流：击键 → rpc term.write（8ms 合并）；输出 → 50ms 轮询 term.read；
 * 会话在 host 半存活（面板切走再回来 attach 回放，不丢画面/不杀进程）。
 *
 * 终端渲染用宿主共享的 ctx.xterm（与 ctx.React 同理：自带一份会双实例）。
 * 主题：xterm 是 canvas，吃不到 CSS 变量 —— 喂实际色值并监听主题切换重喂
 * （与宿主内置 tool:terminal 同一套口径）。
 */
window.__OMP_PLUGIN__({
  apply: function (ctx) {
    var R = ctx.React;
    var h = R.createElement;
    var XTerm = ctx.xterm.Terminal;
    var FitAddon = ctx.xterm.FitAddon;

    // ---- 会话状态（模块级：面板卸载/重挂载之间存活）------------------------
    var session = { terminalId: null, shellId: null, utf8: 'auto' };
    var pollTimer = null;
    var outBuf = '';
    var outTimer = null;

    function rpc(method, params) {
      return ctx.api.invoke('omp:plugin-host:invoke', {
        pluginId: ctx.id,
        method: method,
        params: params || {},
      });
    }

    function flushOut(terminalId) {
      if (!outBuf) return;
      var data = outBuf;
      outBuf = '';
      rpc('term.write', { terminalId: terminalId, data: data }).catch(function () {});
    }

    function queueWrite(terminalId, data) {
      outBuf += data;
      if (outTimer) return;
      outTimer = setTimeout(function () {
        outTimer = null;
        flushOut(terminalId);
      }, 8);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    // ---- xterm 主题（canvas 不吃 CSS 变量，喂实际值）------------------------
    var ANSI_DARK = {
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
      blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
      brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
      brightCyan: '#29b8db', brightWhite: '#ffffff',
    };
    var ANSI_LIGHT = {
      black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
      blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14',
      brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc',
      brightCyan: '#0598bc', brightWhite: '#a5a5a5',
    };
    function readToken(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }
    function isDarkSurface(color) {
      var hex = color.trim().replace('#', '');
      if (hex.length !== 6) return true;
      var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    }
    function buildTermTheme() {
      var bg = readToken('--bg-base', '#151515');
      var fg = readToken('--fg-primary', '#f2f2f2');
      return {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: bg,
        selectionBackground: readToken('--bg-active', 'rgba(255, 255, 255, 0.08)'),
        ...(isDarkSurface(bg) ? ANSI_DARK : ANSI_LIGHT),
      };
    }

    // ---- 终端面板 ------------------------------------------------------------
    function TerminalPane() {
      var containerRef = R.useRef(null);
      var termRef = R.useRef(null);
      var s2 = R.useState(''), status = s2[0], setStatus = s2[1];

      var startSession = R.useCallback(function (shellId) {
        var term = termRef.current;
        if (!term) return;
        var wantUtf8 = session.utf8 !== 'native';
        stopPolling();
        var openAndPoll = function () {
          rpc('term.open', { shellId: shellId, utf8: session.utf8 })
            .then(function (r) {
              session.terminalId = r.terminalId;
              session.shellId = r.profile.id;
              setStatus('已连接 · ' + r.profile.name);
              pollTimer = setInterval(function () {
                rpc('term.read', { terminalId: session.terminalId })
                  .then(function (resp) {
                    if (resp.data) term.write(resp.data);
                    if (resp.exited) {
                      stopPolling();
                      setStatus('进程已退出（code ' + resp.exitCode + '）—— 点击任一终端按钮重新开启');
                    }
                  })
                  .catch(function (e) {
                    stopPolling();
                    setStatus('读取失败：' + (e && e.message ? e.message : String(e)));
                  });
              }, 50);
            })
            .catch(function (e) {
              setStatus('启动失败：' + (e && e.message ? e.message : String(e)));
            });
        };
        if (session.terminalId) {
          rpc('term.close', { terminalId: session.terminalId })
            .catch(function () {})
            .then(openAndPoll);
        } else {
          openAndPoll();
        }
      }, []);

      // 挂载：建 xterm → shells.list → 首次开会话 / 重挂载 attach 回放。
      R.useEffect(function () {
        var container = containerRef.current;
        if (!container) return undefined;
        var term = new XTerm({
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          theme: buildTermTheme(),
        });
        var fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);
        termRef.current = term;
        try {
          fit.fit();
        } catch (e) {
          /* 布局未就绪，ResizeObserver 会补 */
        }
        term.onData(function (data) {
          if (session.terminalId) queueWrite(session.terminalId, data);
        });
        term.onResize(function (size) {
          if (session.terminalId) {
            rpc('term.resize', { terminalId: session.terminalId, cols: size.cols, rows: size.rows }).catch(function () {});
          }
        });

        var alive = true;
        var boot = Promise.all([
          rpc('shells.list', {}).catch(function () { return { shells: [] }; }),
          ctx.api.settings.get('default_shell').catch(function () { return 'auto'; }),
          ctx.api.settings.get('utf8_mode').catch(function () { return 'auto'; }),
        ]).then(function (r) {
          if (!alive) return;
          session.utf8 = r[2] === 'native' ? 'native' : 'auto';
          var want = r[1] && r[1] !== 'auto' ? r[1] : 'auto';
          var pick = null;
          if (want !== 'auto') {
            pick = (r[0].shells || []).filter(function (s) { return s.id === want; })[0] || null;
          }
          var shellId = pick ? pick.id : 'auto';
          if (session.terminalId) {
            // 面板重挂载：会话还活着 —— attach 回放续轮询，不重开进程。
            rpc('term.attach', { terminalId: session.terminalId })
              .then(function (resp) {
                if (!alive || !termRef.current) return;
                if (resp.replay) term.write(resp.replay);
                setStatus('已恢复会话');
                pollTimer = setInterval(function () {
                  rpc('term.read', { terminalId: session.terminalId })
                    .then(function (x) {
                      if (x.data) term.write(x.data);
                      if (x.exited) {
                        stopPolling();
                        setStatus('进程已退出（code ' + x.exitCode + '）');
                      }
                    })
                    .catch(function () {});
                }, 50);
              })
              .catch(function () {
                // 会话已随插件重启清空 —— 重开。
                session.terminalId = null;
                startSession(shellId);
              });
          } else {
            startSession(shellId);
          }
        });

        var ro = new ResizeObserver(function () {
          try {
            fit.fit();
          } catch (e) {
            /* ignore */
          }
        });
        ro.observe(container);
        var themeWatch = new MutationObserver(function () {
          term.options.theme = buildTermTheme();
        });
        themeWatch.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme'],
        });

        return function () {
          alive = false;
          stopPolling();
          flushOut(session.terminalId);
          themeWatch.disconnect();
          ro.disconnect();
          termRef.current = null;
          term.dispose();
        };
        // 仅挂载时初始化一次。
      }, []);

      function killSession() {
        if (!session.terminalId) return;
        rpc('term.close', { terminalId: session.terminalId }).catch(function () {});
        session.terminalId = null;
        stopPolling();
        if (termRef.current) termRef.current.write('\r\n[会话已结束]\r\n');
        setStatus('会话已结束 —— 点击任一终端按钮重新开启');
      }

      // 面板只留「结束会话 + 状态」一行（shell/编码的选择归扩展设置 —— 面板
      // 不再承担设置职责，2026-09-29）。
      var toolbar = h('div', { 'data-locus-term-toolbar': '1', style: {
        display: 'flex', gap: '6px', alignItems: 'center',
        padding: '4px 6px',
      } }, [
        h(ctx.beui.Button, {
          key: 'kill', size: 'sm', variant: 'ghost', 'data-locus-term-kill': '1',
          onClick: killSession,
        }, '结束会话'),
        h('span', { key: 'st', style: {
          marginLeft: 'auto', fontSize: '12px', color: 'var(--fg-muted)',
        }, 'data-locus-term-status': '1' }, status),
      ]);

      return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column' } }, [
        toolbar,
        h('div', {
          ref: containerRef,
          'data-locus-term-view': '1',
          style: {
            flex: '1 1 auto', minHeight: '0', padding: '6px',
            backgroundColor: 'var(--bg-base)', overflow: 'hidden',
          },
        }),
      ]);
    }

    // ---- 设置卡片：默认终端 + 编码模式 ---------------------------------------
    function SettingsCard() {
      var s1 = R.useState([]), shells = s1[0], setShells = s1[1];
      var s2 = R.useState('auto'), defShell = s2[0], setDefShell = s2[1];
      var s3 = R.useState('auto'), utf8 = s3[0], setUtf8 = s3[1];
      var s4 = R.useState(''), saved = s4[0], setSaved = s4[1];
      // 探测失败必须显形（此前静默吞掉，卡片只剩「自动选择」像坏了）：
      // shellsErr = 可读原因，tick 用于「重试」重新触发 useEffect。
      var s5 = R.useState(''), shellsErr = s5[0], setShellsErr = s5[1];
      var s6 = R.useState(0), tick = s6[0], setTick = s6[1];

      R.useEffect(function () {
        var alive = true;
        setShellsErr('');
        rpc('shells.list', {})
          .then(function (r) {
            if (alive) setShells(r.shells || []);
          })
          .catch(function (e) {
            if (alive) {
              setShells([]);
              setShellsErr(e && e.message ? e.message : String(e));
            }
          });
        ctx.api.settings.get('default_shell').then(function (v) {
          if (alive && typeof v === 'string') setDefShell(v);
        }).catch(function () {});
        ctx.api.settings.get('utf8_mode').then(function (v) {
          if (alive && typeof v === 'string') setUtf8(v);
        }).catch(function () {});
        return function () { alive = false; };
      }, [tick]);

      function save(shell, mode) {
        Promise.all([
          ctx.api.settings.set('default_shell', shell),
          ctx.api.settings.set('utf8_mode', mode),
        ]).then(function () {
          setSaved('已保存（新会话生效）');
        }).catch(function (e) {
          setSaved('保存失败：' + (e && e.message ? e.message : String(e)));
        });
      }

      var shellOptions = [{ id: 'auto', name: '自动选择' }].concat(shells || []);
      return h('div', { className: 'set-block', 'data-locus-term-card': '1' }, [
        h('div', { className: 'set-legend', key: 'lg' }, '终端'),
        h('div', { className: 'set-card', key: 'card' }, [
          h('div', { className: 'set-row', key: 'r1' }, [
            h('div', { className: 'set-row-main', key: 'm' }, [
              h('div', { className: 'set-row-label', key: 'l' }, '默认终端'),
              h('div', { className: 'set-row-desc', key: 'd' }, '自动选择 = 按探测顺序取首个可用（pwsh 优先）'),
              shellsErr
                ? h('div', {
                    key: 'err', className: 'set-row-desc', 'data-locus-shells-error': '1',
                    style: { color: 'var(--warn)' },
                  }, '探测失败：' + shellsErr)
                : null,
              shellsErr
                ? h(ctx.beui.Button, {
                    key: 'retry', size: 'sm', variant: 'ghost',
                    'data-locus-shells-retry': '1',
                    onClick: function () { setTick(function (n) { return n + 1; }); },
                  }, '重试探测')
                : null,
            ]),
            h('div', { key: 'v', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              shellOptions.map(function (s) {
                return h(ctx.beui.Button, {
                  key: s.id, size: 'sm',
                  variant: defShell === s.id ? 'primary' : 'ghost',
                  'data-locus-set-shell': s.id,
                  onClick: function () { setDefShell(s.id); save(s.id, utf8); },
                }, s.name);
              })),
          ]),
          h('div', { className: 'set-row', key: 'r2' }, [
            h('div', { className: 'set-row-main', key: 'm2' }, [
              h('div', { className: 'set-row-label', key: 'l2' }, '终端编码'),
              h('div', { className: 'set-row-desc', key: 'd2' },
                '强制 UTF-8 = PowerShell/CMD 启动时注入 chcp 65001；Git Bash/WSL 原生即 UTF-8'),
            ]),
            h('div', { key: 'v2', style: { display: 'flex', gap: '6px' } }, [
              h(ctx.beui.Button, {
                key: 'a', size: 'sm', variant: utf8 !== 'native' ? 'primary' : 'ghost',
                'data-locus-set-utf8': 'auto',
                onClick: function () { setUtf8('auto'); save(defShell, 'auto'); },
              }, '强制 UTF-8'),
              h(ctx.beui.Button, {
                key: 'n', size: 'sm', variant: utf8 === 'native' ? 'primary' : 'ghost',
                'data-locus-set-utf8': 'native',
                onClick: function () { setUtf8('native'); save(defShell, 'native'); },
              }, '原生'),
            ]),
          ]),
          saved ? h('div', { className: 'set-row', key: 'st', 'data-locus-set-status': '1' }, [
            h('div', { className: 'set-row-main' }, h('div', { className: 'set-row-desc' }, saved)),
          ]) : null,
        ]),
      ]);
    }

    ctx.ui.registerPane('locus.terminal', TerminalPane, { fill: true });
    ctx.ui.registerSettingsCard(SettingsCard);
    ctx.logger.info('终端插件已就绪');
    return function () {
      // 插件撤销：runner 进程随之被杀，PTY 会话自动终结；这里只清本地轮询。
      stopPolling();
    };
  },
});
