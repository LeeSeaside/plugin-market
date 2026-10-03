/**
 * com.locus.terminal · Client 半（同页求值工厂）—— 多终端标签版（2026-09-30）
 *
 * 交互模型（用户拍板，对标 VS Code 集成终端）：
 *   - 面板内多终端标签：每标签一个独立 xterm + 独立 PTY（宿主 MAX_SESSIONS=4）；
 *   - 打开面板：没有终端就新建一个，有就只是隐藏/显示 —— 会话全活；
 *   - 关掉面板（工作台标签收走）才把所有终端杀光（paneClosed → 全杀）；
 *   - 标签 × 单杀一个；＋ 新建；关到最后一个 → 空态 +「新建终端」按钮。
 *
 * 数据流：击键 → rpc term.write（8ms 合并）；输出 → 单一定时器轮询所有
 * 存活会话的 term.read（50ms）；会话在 host 半存活，面板切走再回来不动它。
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

    // ---- 会话状态（apply 级：面板卸载/重挂载之间存活）------------------------
    // tab = { key, id:terminalId, baseName, name, exited, term, fit, div }
    var tabs = [];
    var activeKey = null; // 当前显示标签的稳定 key（进程退出后 id 会被置空）
    var shellsCache = null; // shells.list 结果缓存（新建标签时用）
    var pollTimer = null;
    var outBufs = {}; // terminalId → 待写缓冲
    var outTimer = null;
    var seq = 0;

    try {
      ctx.api.events.on('paneClosed', function (data) {
        var pane = data && data.pane;
        if (pane === 'plugin:' + ctx.id + ':locus.terminal') killAll();
      });
    } catch (e) {
      // 未声明 events:subscribe 时静默降级：会话保持旧的「关面板不死」语义。
    }
    try {
      ctx.api.events.on('paneOpened', function (data) {
        var pane = data && data.pane;
        if (pane === 'plugin:' + ctx.id + ':locus.terminal') {
          // 打开面板：有终端就只是显示；没有就新建一个（用户拍板的语义）。
          if (!tabs.length) newTerminal();
          else fitRef.current();
        }
      });
    } catch (e) {
      /* 同上：无事件订阅时面板内「＋」兜底。 */
    }

    function rpc(method, params) {
      return ctx.api.invoke('omp:plugin-host:invoke', {
        pluginId: ctx.id,
        method: method,
        params: params || {},
      });
    }

    // ---- 输出合并写回 ---------------------------------------------------------
    function flushOut() {
      var ids = Object.keys(outBufs);
      if (!ids.length) return;
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var data = outBufs[id];
        if (!data) continue;
        delete outBufs[id];
        rpc('term.write', { terminalId: id, data: data }).catch(function () {});
      }
    }
    function queueWrite(terminalId, data) {
      outBufs[terminalId] = (outBufs[terminalId] || '') + data;
      if (outTimer) return;
      outTimer = setTimeout(function () {
        outTimer = null;
        flushOut();
      }, 8);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
    function armPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        for (var i = 0; i < tabs.length; i++) {
          pollOne(tabs[i]);
        }
      }, 50);
    }
    function pollOne(tab) {
      if (tab.exited || !tab.id) return;
      rpc('term.read', { terminalId: tab.id })
        .then(function (resp) {
          if (resp.data && tab.term) tab.term.write(resp.data);
          if (resp.exited) {
            tab.exited = true;
            tab.id = null; // PTY 已终结：标签保留（缓冲可看），可「＋」或点原标签切换
            uiBumpRef.current();
          }
        })
        .catch(function () {
          /* 单次读取失败静默 —— runner 重启后 attach 语义由下次打开接管 */
        });
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

    // ---- 面板（tab 条 + 终端区）----------------------------------------------
    function TerminalPane() {
      var viewRef = R.useRef(null);
      var s5 = R.useState(0), uiTick = s5[0], bumpUi = s5[1];
      function bump() { bumpUi(function (n) { return n + 1; }); }
      uiBumpRef.current = bump;

      var s6 = R.useState('⠋'), spinFrame = s6[0], setSpinFrame = s6[1];
      R.useEffect(function () {
        if (!pendingNew) return undefined;
        var frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        var i = 0;
        var timer = setInterval(function () {
          i = (i + 1) % frames.length;
          setSpinFrame(frames[i]);
        }, 100);
        return function () { clearInterval(timer); };
      }, [uiTick]);

      // 挂载：容器就绪后把已有标签的 DOM 重新挂回来（插件重载会整树重建），
      // 并建首屏首标签（打开面板没有终端就新建一个）。
      R.useEffect(function () {
        var view = viewRef.current;
        if (!view) return undefined;
        viewEl = view;
        for (var i = 0; i < tabs.length; i++) {
          view.appendChild(tabs[i].div);
        }
        showActive();
        if (!tabs.length) newTerminal();
        var ro = new ResizeObserver(function () {
          refitActive();
        });
        ro.observe(view);
        var themeWatch = new MutationObserver(function () {
          var theme = buildTermTheme();
          for (var j = 0; j < tabs.length; j++) {
            if (tabs[j].term) tabs[j].term.options.theme = theme;
          }
        });
        themeWatch.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme'],
        });
        return function () {
          themeWatch.disconnect();
          ro.disconnect();
          viewEl = null;
          // 面板卸载（插件重载）= 渲染层整体重建：杀光会话，状态同步清零。
          killAll();
        };
        // 仅挂载时初始化一次。
      }, []);

      function refitActive() {
        var tab = tabByKey(activeKey);
        if (!tab || !tab.fit) return;
        try {
          tab.fit.fit();
        } catch (e) {
          /* 布局未就绪，ResizeObserver 会补 */
        }
      }
      fitRef.current = refitActive;

      function switchTab(key) {
        if (key === activeKey) return;
        activeKey = key;
        showActive();
        bump();
      }
      switchRef.current = switchTab;

      function showActive() {
        var view = viewRef.current;
        if (!view) return;
        for (var i = 0; i < view.children.length; i++) {
          view.children[i].style.display = 'none';
        }
        var tab = tabByKey(activeKey);
        if (tab && tab.div) {
          tab.div.style.display = 'block';
          // 显示后一帧再 fit（display:none 期间尺寸为 0）
          setTimeout(function () { refitActive(); }, 0);
        }
      }

      function closeTab(key) {
        var tab = tabByKey(key);
        if (!tab) return;
        if (tab.id) rpc('term.close', { terminalId: tab.id }).catch(function () {});
        if (tab.term) tab.term.dispose();
        if (tab.div && tab.div.parentNode) tab.div.parentNode.removeChild(tab.div);
        tabs = tabs.filter(function (t) { return t !== tab; });
        if (activeKey === key) {
          activeKey = tabs.length ? tabs[tabs.length - 1].key : null;
        }
        if (!tabs.length) stopPolling();
        else {
          showActive();
          armPolling();
        }
        bump();
      }
      closeRef.current = closeTab;

      var tabBtns = [];
      tabs.forEach(function (tab) {
        var active = tab.key === activeKey;
        tabBtns.push(h(ctx.beui.Button, {
          key: tab.key,
          size: 'sm',
          variant: active ? 'primary' : 'ghost',
          'data-locus-term-tab': tab.key,
          onClick: function () { switchRef.current(tab.key); },
        }, [
          h('span', { key: 'l' }, tab.name + (tab.exited ? '（已退出）' : '')),
          h('span', {
            key: 'x',
            'data-locus-term-tab-close': tab.key,
            onClick: function (e) {
              e.stopPropagation();
              closeRef.current(tab.key);
            },
            style: {
              marginLeft: '6px', padding: '0 4px', borderRadius: '4px',
              opacity: '0.65', cursor: 'pointer', lineHeight: '1',
            },
            onMouseEnter: function (e) {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.backgroundColor = 'var(--bg-active)';
            },
            onMouseLeave: function (e) {
              e.currentTarget.style.opacity = '0.65';
              e.currentTarget.style.backgroundColor = 'transparent';
            },
          }, '×'),
        ]));
      });

      if (pendingNew > 0) {
        tabBtns.push(h(ctx.beui.Button, {
          key: 'pending', size: 'sm', variant: 'ghost', disabled: true,
          'data-locus-term-pending': '1',
        }, spinFrame + ' 启动中…'));
      }

      var toolbar = h('div', { 'data-locus-term-toolbar': '1', style: {
        display: 'flex', gap: '4px', alignItems: 'center',
        padding: '4px 6px', flexWrap: 'wrap',
      } }, tabBtns.concat([
        h(ctx.beui.Button, {
          key: 'add', size: 'sm', variant: 'ghost', 'data-locus-term-add': '1',
          disabled: tabs.length >= 4 || pendingNew > 0,
          onClick: function () { newRef.current(); },
        }, pendingNew > 0 ? spinFrame : '＋'),
      ]));

      return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column' } }, [
        toolbar,
        h('div', {
          ref: viewRef,
          'data-locus-term-view': '1',
          style: {
            flex: '1 1 auto', minHeight: '0', padding: '6px',
            backgroundColor: 'var(--bg-base)', overflow: 'hidden',
            position: 'relative',
          },
        }, tabs.length
          ? null
          : h('div', { key: 'empty', style: {
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              gap: '8px', alignItems: 'center', justifyContent: 'center',
            } }, [
              pendingNew > 0
                ? h('div', { key: 'loading', 'data-locus-term-starting': '1' }, spinFrame + ' 正在启动终端…')
                : null,
              lastNewError
                ? h('div', { key: 'err', style: { color: 'var(--warn)' } }, '启动失败：' + lastNewError)
                : null,
              pendingNew > 0
                ? null
                : h(ctx.beui.Button, {
                    key: 'new', size: 'sm', variant: 'primary',
                    'data-locus-term-new': '1',
                    onClick: function () { newRef.current(); },
                  }, '新建终端'),
            ])),
      ]);
    }

    // ---- 命令式会话管理（React 树之外，div 由这里直接挂）----------------------
    var pendingNew = 0; // 进行中的 term.open 数（0 或 1；＋ 串行化）
    var lastNewError = null; // 最近一次创建失败原因（空态显示）
    var viewEl = null; // 挂载 effect 回填
    var uiBumpRef = { current: function () {} };
    var fitRef = { current: function () {} };
    var switchRef = { current: function () {} };
    var closeRef = { current: function () {} };
    var newRef = { current: function () {} };

    function tabByKey(key) {
      for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) return tabs[i];
      return null;
    }
    function nextName(profileName) {
      var n = 1;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].baseName === profileName) n++;
      }
      return { base: profileName, label: n > 1 ? profileName + ' ' + n : profileName };
    }

    function newTerminal() {
      newRefApply();
    }
    function newRefApply() {
      var term = null, fit = null, div = null, tab = null;
      pendingNew++;
      lastNewError = null;
      uiBumpRef.current();
      Promise.all([
        shellsCache
          ? Promise.resolve({ shells: shellsCache })
          : rpc('shells.list', {}).then(function (r) {
              shellsCache = r.shells || [];
              return { shells: shellsCache };
            }).catch(function () { return { shells: [] }; }),
        ctx.api.settings.get('default_shell').catch(function () { return 'auto'; }),
        ctx.api.settings.get('utf8_mode').catch(function () { return 'auto'; }),
      ])
        .then(function (r) {
          var utf8 = r[2] === 'native' ? 'native' : 'auto';
          var want = r[1] && r[1] !== 'auto' ? r[1] : 'auto';
          var pick = null;
          var shells = (r[0] && r[0].shells) || [];
          if (want !== 'auto') {
            pick = shells.filter(function (s) { return s.id === want; })[0] || null;
          }
          return rpc('term.open', { shellId: pick ? pick.id : 'auto', utf8: utf8 });
        })
        .then(function (opened) {
          // xterm 实例 + 专属 div（display:none 的兄弟，激活时切换）
          term = new XTerm({
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
            fontSize: 13,
            lineHeight: 1.2,
            cursorBlink: true,
            theme: buildTermTheme(),
          });
          fit = new FitAddon();
          term.loadAddon(fit);
          div = document.createElement('div');
          div.setAttribute('data-locus-term-session', opened.terminalId);
          div.style.width = '100%';
          div.style.height = '100%';
          div.style.display = 'none';
          term.open(div);
          term.onData(function (data) {
            queueWrite(opened.terminalId, data);
          });
          term.onResize(function (size) {
            rpc('term.resize', { terminalId: opened.terminalId, cols: size.cols, rows: size.rows }).catch(function () {});
          });
          var named = nextName(opened.profile.name);
          tab = {
            key: 'k' + ++seq,
            id: opened.terminalId,
            baseName: named.base,
            name: named.label,
            exited: false,
            term: term,
            fit: fit,
            div: div,
          };
          tabs.push(tab);
          activeKey = tab.key;
          if (viewEl) {
            viewEl.appendChild(div);
            div.style.display = 'block';
          }
          try {
            fit.fit();
          } catch (e) {
            /* 布局未就绪，ResizeObserver 会补 */
          }
          armPolling();
          pendingNew = Math.max(0, pendingNew - 1);
          uiBumpRef.current();
        })
        .catch(function (e) {
          // 没有可用标签承载错误 —— 写进当前激活终端；连标签都没有时落在
          // 视图容器的诊断属性上（面板为空态，用户至少能看到 ＋ 仍可重试）。
          var cur = tabByKey(activeKey);
          if (cur && cur.term) {
            cur.term.write('\r\n[启动失败：' + ((e && e.message) || e) + ']\r\n');
          } else if (viewEl) {
            viewEl.setAttribute('data-locus-term-error', String((e && e.message) || e));
          }
          lastNewError = String((e && e.message) || e);
          pendingNew = Math.max(0, pendingNew - 1);
          uiBumpRef.current();
        });
    }
    newRef.current = newRefApply;

    function killAll() {
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        if (t.id) rpc('term.close', { terminalId: t.id }).catch(function () {});
        if (t.term) t.term.dispose();
      }
      tabs = [];
      activeKey = null;
      pendingNew = 0;
      stopPolling();
      uiBumpRef.current();
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
            if (alive) {
              setShells(r.shells || []);
              shellsCache = r.shells || [];
            }
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
    ctx.logger.info('终端插件已就绪（多终端标签版）');
    return function () {
      // 插件撤销：runner 进程随之被杀，PTY 会话自动终结；这里只清本地轮询。
      stopPolling();
    };
  },
});
