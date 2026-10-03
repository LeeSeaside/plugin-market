/*!
 * Git 工作台 · 渲染半（com.locus.git）
 *
 * 契约与「关于 Locus」活模板一致：window.__OMP_PLUGIN__({ apply(ctx) })，
 * ctx.beui + ctx.api.invoke。与 Host 半的通信走 omp:plugin-host:invoke 桥
 * （workspace 由服务端注入，client 不传）。样式复用 omp.css 全局
 * set-* 类 + CSS 变量内联（与宿主主题单源联动）。
 *
 * 1.1.0 新增：
 *   - diff 按行染色（+/−/@@/文件头四类，色取 --success/--danger/--accent，
 *     color-mix 低透明度底色随三主题联动）；
 *   - 提交图车道（log 带 %P parents → O(n) 车道分配，SVG 圆点 + 贝塞尔连
 *     线 + refs 徽标：HEAD/本地/远端/tag 分色）；
 *   - 分支下拉（beui Select 切换 + 内联输入新建）与 stash 一对按钮；
 *   - 文件监听自动刷新：2s 轮询 git.version（host 半 fs.watch 版本计数器，
 *     零 git 调用），版本变了才拉全量；document.hidden 与加载中跳过。
 */
window.__OMP_PLUGIN__({
  apply: function (ctx) {
    var R = ctx.React;
    var h = R.createElement;
    var PLUGIN_ID = ctx.id;

    function rpc(method, params) {
      return ctx.api.invoke('omp:plugin-host:invoke', {
        pluginId: PLUGIN_ID,
        method: method,
        params: params || {},
      });
    }

    var mono = { fontFamily: 'var(--font-mono)', fontSize: '11px' };
    var muted = { color: 'var(--fg-muted)', fontSize: '12px' };
    var badge = function (ch) {
      return h(
        'span',
        {
          style: {
            flexShrink: 0,
            display: 'inline-block',
            minWidth: '16px',
            textAlign: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            lineHeight: '16px',
            borderRadius: '4px',
            color: 'var(--fg-secondary)',
            backgroundColor: 'var(--border-strong)',
          },
        },
        ch,
      );
    };
    var rowBtn = function (label, title, onClick, disabled) {
      return h(
        ctx.beui.Button,
        {
          size: 'sm',
          variant: 'ghost',
          disabled: !!disabled,
          onClick: onClick,
          title: title,
        },
        label,
      );
    };

    function FileRow(p) {
      var f = p.file;
      var ch = f.untracked ? 'U' : f.staged && f.unstaged ? 'MM' : f.staged ? f.x : f.y;
      return h('div', { className: 'set-row', key: p.key }, [
        h(
          'div',
          {
            className: 'set-row-main',
            style: { cursor: 'pointer', minWidth: 0 },
            onClick: p.onDiff,
            title: '查看 diff',
          },
          [
            h('div', { style: Object.assign({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, mono) }, f.label),
          ],
        ),
        badge(ch),
        rowBtn(f.staged ? '−' : '+', f.staged ? '取消暂存' : '暂存', p.onToggle, p.busy),
      ]);
    }

    /* ---- 提交图车道 ------------------------------------------------------- */
    // 车道色板：装饰性固定色相（与 useThreadUsage 的 USAGE_DOT 同策略，三主题
    // 通用），首车道用 --accent 让主线视觉可跟。
    var LANE_COLORS = [
      'var(--accent)',
      '#6f9bff',
      '#3ecf8e',
      '#f5a500',
      '#a78bfa',
      '#f472b6',
    ];
    var ROW_H = 22;
    var LANE_W = 12;

    /**
     * O(n) 车道分配：lanes[i] = 占用第 i 车道的 commit hash（或 null 空位）。
     * 每行先认领自己的车道（已在 lanes 里就位，否则取最左空位），腾空后把
     * parents 落位（已有车道或最左空位）。输出每行的 { lane, parentLanes }。
     */
    function layoutLanes(commits) {
      var lanes = [];
      var laneCount = 1;
      var rows = [];
      for (var i = 0; i < commits.length; i++) {
        var c = commits[i];
        var lane = lanes.indexOf(c.hash);
        if (lane === -1) {
          lane = lanes.indexOf(null);
          if (lane === -1) lane = lanes.length;
        }
        lanes[lane] = null;
        var parentLanes = [];
        var parents = Array.isArray(c.parents) ? c.parents : [];
        for (var k = 0; k < parents.length; k++) {
          var ph = parents[k];
          var pl = lanes.indexOf(ph);
          if (pl === -1) {
            pl = lanes.indexOf(null);
            if (pl === -1) pl = lanes.length;
          }
          lanes[pl] = ph;
          parentLanes.push(pl);
        }
        if (lanes.length > laneCount) laneCount = lanes.length;
        rows.push({ c: c, lane: lane, parentLanes: parentLanes });
      }
      return { rows: rows, laneCount: laneCount };
    }

    function laneX(lane) {
      return LANE_W * (lane + 1);
    }

    function laneColor(lane) {
      return LANE_COLORS[lane % LANE_COLORS.length];
    }

    /** 单行 SVG：占用车道竖线 + 节点圆 + 到各 parent 车道的贝塞尔下沿。 */
    function GraphSvg(p) {
      var row = p.row;
      var laneCount = p.laneCount;
      var width = LANE_W * (laneCount + 1);
      var paths = [];
      var nodeX = laneX(row.lane);
      var i, x;
      for (i = 0; i < laneCount; i++) {
        if (i === row.lane) continue;
        // 该车道本行之后仍有占用（parent 或延续）才画竖线。parentLanes 已由
        // 节点曲线覆盖；其余占位 = 直线贯通。
        var occupied = p.nextLanes[i] != null && row.parentLanes.indexOf(i) === -1;
        if (!occupied) continue;
        x = laneX(i);
        paths.push({ d: 'M ' + x + ' 0 L ' + x + ' ' + ROW_H, color: laneColor(i), w: 1.5 });
      }
      for (i = 0; i < row.parentLanes.length; i++) {
        var px = laneX(row.parentLanes[i]);
        var color = laneColor(row.parentLanes[i]);
        if (px === nodeX) {
          paths.push({ d: 'M ' + nodeX + ' ' + ROW_H / 2 + ' L ' + px + ' ' + ROW_H, color: color, w: 1.5 });
        } else {
          var mid = ROW_H / 2;
          paths.push({
            d:
              'M ' + nodeX + ' ' + mid +
              ' C ' + nodeX + ' ' + (mid + 6) + ', ' + px + ' ' + (mid + 4) + ', ' + px + ' ' + ROW_H,
            color: color,
            w: 1.5,
          });
        }
      }
      var circles = [{ cx: nodeX, cy: ROW_H / 2, r: 3.2, fill: laneColor(row.lane) }];
      return h(
        'svg',
        {
          width: width,
          height: ROW_H,
          'aria-hidden': 'true',
          style: { flexShrink: 0, display: 'block' },
        },
        paths.map(function (pp, idx) {
          return h('path', {
            key: 'p' + idx,
            d: pp.d,
            fill: 'none',
            stroke: pp.color,
            strokeWidth: pp.w,
            strokeLinecap: 'round',
          });
        }).concat(
          circles.map(function (cc, idx) {
            return h('circle', {
              key: 'c' + idx,
              cx: cc.cx,
              cy: cc.cy,
              r: cc.r,
              fill: cc.fill,
            });
          }),
        ),
      );
    }

    /** refs 徽标（%D）：HEAD → accent 实底；tag: → 紫调；远端 origin/* → 描边。 */
    function refPills(refs) {
      if (!refs || refs.length === 0) return null;
      return h(
        'span',
        { style: { display: 'inline-flex', gap: '4px', marginLeft: '6px', flexWrap: 'wrap', verticalAlign: 'middle' } },
        refs.slice(0, 4).map(function (r, i) {
          var isHead = r === 'HEAD' || r.indexOf('HEAD ->') === 0;
          var isTag = r.indexOf('tag: ') === 0;
          var label = isHead && r.indexOf('HEAD ->') === 0 ? r.slice(8) : isTag ? r.slice(5) : r;
          var style;
          if (isHead) {
            style = { color: 'var(--accent-contrast, #fff)', backgroundColor: 'var(--accent)' };
          } else if (isTag) {
            style = { color: '#a78bfa', backgroundColor: 'transparent', border: '1px solid #a78bfa' };
          } else {
            style = { color: 'var(--fg-secondary)', backgroundColor: 'var(--border-strong)' };
          }
          return h(
            'span',
            {
              key: r + ':' + i,
              style: Object.assign(
                {
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9px',
                  lineHeight: '14px',
                  padding: '0 5px',
                  borderRadius: '999px',
                  whiteSpace: 'nowrap',
                },
                style,
              ),
            },
            label,
          );
        }),
      );
    }

    function CommitRow(p) {
      var row = p.row;
      var c = row.c;
      return h(
        'div',
        { className: 'set-row', key: c.hash, style: { alignItems: 'center' } },
        [
          h(GraphSvg, { row: row, laneCount: p.laneCount, nextLanes: p.nextLanes }),
          h('div', { className: 'set-row-main', style: { minWidth: 0 } }, [
            h(
              'div',
              { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-secondary)' } },
              [
                c.subject,
                refPills(c.refs),
              ],
            ),
            h('div', { style: Object.assign({}, muted, { fontSize: '11px' }) }, c.short + ' · ' + c.author + ' · ' + c.date),
          ]),
        ],
      );
    }

    /* ---- diff 染色 --------------------------------------------------------- */
    var DIFF_MAX_LINES = 800;

    function classifyDiffLine(line) {
      if (/^(diff --git|index |old mode|new mode|similarity index|rename from|rename to|--- |\+\+\+ )/.test(line)) return 'meta';
      if (/^@@/.test(line)) return 'hunk';
      if (line.charAt(0) === '+') return 'add';
      if (line.charAt(0) === '-') return 'del';
      return 'ctx';
    }

    var DIFF_LINE_STYLES = {
      meta: { color: 'var(--fg-muted)' },
      hunk: { color: 'var(--accent)', backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
      add: {
        color: 'var(--success)',
        backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)',
      },
      del: {
        color: 'var(--danger)',
        backgroundColor: 'color-mix(in srgb, var(--danger) 12%, transparent)',
      },
      ctx: { color: 'var(--fg-secondary)' },
    };

    function DiffView(p) {
      var all = String(p.text || '').split('\n');
      // 去掉 diff 尾部可能的空行噪音
      while (all.length > 0 && all[all.length - 1] === '') all.pop();
      var overflow = all.length > DIFF_MAX_LINES;
      var lines = overflow ? all.slice(0, DIFF_MAX_LINES) : all;
      return h(
        'div',
        {
          style: Object.assign({}, mono, {
            margin: '0 4px 8px',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid var(--border-strong)',
            backgroundColor: 'transparent',
            whiteSpace: 'pre',
            overflowX: 'auto',
            overflowWrap: 'normal',
            maxHeight: '340px',
            overflowY: 'auto',
            userSelect: 'text',
            lineHeight: '1.55',
          }),
        },
        lines.map(function (line, i) {
          var kind = classifyDiffLine(line);
          return h(
            'div',
            { key: i, style: Object.assign({ minHeight: '14px' }, DIFF_LINE_STYLES[kind]) },
            line || ' ',
          );
        }).concat(
          overflow
            ? [
                h(
                  'div',
                  { key: 'of', style: Object.assign({ paddingTop: '6px' }, muted) },
                  '… 其余 ' + (all.length - DIFF_MAX_LINES) + ' 行省略（在终端查看完整 diff）',
                ),
              ]
            : [],
        ),
      );
    }

    /* ---- 面板 -------------------------------------------------------------- */

    function GitPane(props) {
      var c = props.ctx;
      var st = R.useState(null), data = st[0], setData = st[1];
      var lg = R.useState(null), logRows = lg[0], setLogRows = lg[1];
      var br = R.useState([]), branches = br[0], setBranches = br[1];
      var sh = R.useState([]), stashList = sh[0], setStashList = sh[1];
      var bs = R.useState(false), busy = bs[0], setBusy = bs[1];
      var busyRef = R.useRef(false);
      var er = R.useState(null), err = er[0], setErr = er[1];
      var ms = R.useState(''), msg = ms[0], setMsg = ms[1];
      var df = R.useState(null), diff = df[0], setDiff = df[1];
      var nb = R.useState(false), newBranchOpen = nb[0], setNewBranchOpen = nb[1];
      var nv = R.useState(''), newBranchName = nv[0], setNewBranchName = nv[1];

      var setBusyBoth = R.useCallback(function (v) {
        busyRef.current = v;
        setBusy(v);
      }, []);

      var refreshAll = R.useCallback(
        function () {
          setBusyBoth(true);
          return Promise.all([rpc('git.status'), rpc('git.log', { n: 30 }), rpc('git.branches'), rpc('git.stashList')])
            .then(function (r) {
              setData(r[0]);
              setLogRows(Array.isArray(r[1]) ? r[1] : []);
              setBranches(Array.isArray(r[2]) ? r[2] : []);
              setStashList(Array.isArray(r[3]) ? r[3] : []);
              setErr(null);
            })
            .catch(function (e) {
              setErr(String((e && e.message) || e));
            })
            .finally(function () {
              setBusyBoth(false);
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [setBusyBoth],
      );

      R.useEffect(function () {
        refreshAll();
        // 双订阅：paneOpened（每次切到本面板即重新取数，覆盖「切工作区再
        // 切回来」「重开标签」；应用常发、不依赖事件桥版本）+
        // workspaceChanged（标签关着时工作区变了，后台先刷好）。
        try {
          var offOpen = ctx.api.events.on('paneOpened', function (d) {
            if (d && d.pane === 'plugin:' + ctx.id + ':locus.git') refreshAll();
          });
          var offWs = ctx.api.events.on('workspaceChanged', function () {
            refreshAll();
          });
          return function () {
            offOpen.dispose();
            offWs.dispose();
          };
        } catch (e) {
          return undefined;
        }
      }, [refreshAll]);

      // 文件监听自动刷新：host 半 fs.watch 维护版本号，这里 2s 轮询零 git
      // 调用的 git.version；版本变了才拉全量。加载中 / 页面隐藏时跳过。
      R.useEffect(function () {
        var lastV = null;
        var timer = setInterval(function () {
          if (document.hidden || busyRef.current) return;
          rpc('git.version')
            .then(function (r) {
              if (!r || typeof r.v !== 'number') return;
              if (lastV !== null && r.v !== lastV) {
                refreshAll();
              }
              lastV = r.v;
            })
            .catch(function () {
              /* host 未升级（无 git.version）→ 静默，保持手动刷新 */
            });
        }, 2000);
        return function () {
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refreshAll]);

      function act(promise, done) {
        setBusyBoth(true);
        promise
          .then(function () {
            setErr(null);
            return refreshAll().then(function () {
              if (done) done();
            });
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
            // 写操作失败后状态可能已部分变化（如 stash pop 冲突）——仍刷一次
            return refreshAll().catch(function () {});
          })
          .finally(function () {
            setBusyBoth(false);
          });
      }

      function showDiff(f) {
        setBusyBoth(true);
        rpc('git.diff', { path: f.path, cached: f.staged && !f.unstaged })
          .then(function (r) {
            setDiff({ path: f.label || f.path, text: String(r.text || '') });
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .finally(function () {
            setBusyBoth(false);
          });
      }

      var files = (data && data.files) || [];
      var stagedFiles = files.filter(function (f) { return f.staged; });
      var unstagedFiles = files.filter(function (f) { return !f.staged; });
      var layout = R.useMemo(
        function () {
          return layoutLanes(logRows || []);
        },
        [logRows],
      );

      if (!data && !err) {
        return h('div', { 'data-plugin-pane': c.id, style: { padding: '12px' } }, [
          h(ctx.beui.Loader, { variant: 'spinner', size: 14, label: '读取 Git 状态' }),
        ]);
      }

      var currentBranch = branches.find(function (b) { return b.current; });
      var branchOptions = branches.map(function (b) {
        return { value: b.name, label: (b.current ? '● ' : '') + b.name };
      });

      var head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 2px' } }, [
        branchOptions.length > 0
          ? h(ctx.beui.Select, {
              key: 'branch-sel',
              value: currentBranch ? currentBranch.name : branchOptions[0].value,
              options: branchOptions,
              disabled: busy,
              ariaLabel: '切换分支',
              style: { maxWidth: '180px' },
              onChange: function (v) {
                act(rpc('git.branchSwitch', { name: v }));
              },
            })
          : h('div', { style: Object.assign({}, mono, { color: 'var(--fg-secondary)' }) },
              (data && data.branch ? data.branch : '（无分支)') +
                (data && data.ahead ? ' ↑' + data.ahead : '') +
                (data && data.behind ? ' ↓' + data.behind : '')),
        rowBtn('＋', '新建分支', function () { setNewBranchName(''); setNewBranchOpen(!newBranchOpen); }, busy),
        h('div', { style: { flex: 1 } }),
        rowBtn('⟳', '刷新', refreshAll, busy),
        rowBtn('stash', '贮藏全部变更（含未跟踪）', function () { act(rpc('git.stash', {})); }, busy || files.length === 0),
        rowBtn('pop', '弹出最近一次贮藏', function () { act(rpc('git.stashPop')); }, busy || stashList.length === 0),
        rowBtn('pull', '拉取（--ff-only）', function () { act(rpc('git.pull')); }, busy),
        rowBtn('push', '推送到远端', function () { act(rpc('git.push')); }, busy),
      ]);

      var newBranchBar = newBranchOpen
        ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '0 2px 6px' } }, [
            h('input', {
              autoFocus: true,
              value: newBranchName,
              placeholder: '新分支名（回车确认，Esc 取消）',
              disabled: busy,
              onChange: function (e) { setNewBranchName(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === 'Escape') setNewBranchOpen(false);
                if (e.key === 'Enter' && newBranchName.trim()) {
                  setNewBranchOpen(false);
                  act(rpc('git.branchCreate', { name: newBranchName.trim() }));
                }
              },
              style: {
                flex: 1, minWidth: 0, padding: '4px 8px', borderRadius: '6px',
                border: '1px solid var(--border-strong)',
                backgroundColor: 'transparent', color: 'var(--fg-primary)',
                fontFamily: 'var(--font-mono)', fontSize: '12px',
              },
            }),
            rowBtn('创建', '基于当前 HEAD 新建并切换', function () {
              setNewBranchOpen(false);
              act(rpc('git.branchCreate', { name: newBranchName.trim() }));
            }, busy || !newBranchName.trim()),
          ])
        : null;

      var errBar = err
        ? h(
            'div',
            {
              style: {
                margin: '4px 2px', padding: '6px 8px', borderRadius: '6px',
                fontSize: '12px', color: 'var(--fg-primary)',
                backgroundColor: 'var(--border-strong)', whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              },
              onClick: function () { setErr(null); },
              title: '点击关闭',
            },
            err,
          )
        : null;

      var fileSection = function (title, sectionFiles, emptyHint) {
        return h('div', { className: 'set-block', key: title }, [
          h('div', { className: 'set-legend' }, title + '（' + sectionFiles.length + '）'),
          h('div', { className: 'set-card' },
            sectionFiles.length === 0
              ? [h('div', { style: Object.assign({ padding: '6px 8px' }, muted) }, emptyHint)]
              : sectionFiles.map(function (f, i) {
                  return h(FileRow, {
                    key: f.path + ':' + i,
                    file: f,
                    busy: busy,
                    onDiff: function () { showDiff(f); },
                    onToggle: function () {
                      act(
                        f.staged
                          ? rpc('git.unstage', { paths: [f.prevPath || f.path] })
                          : rpc('git.stage', { paths: [f.path] }),
                      );
                    },
                  });
                })),
        ]);
      };

      var commitArea = h('div', { className: 'set-block' }, [
        h('div', { className: 'set-legend' }, '提交'),
        h('div', { className: 'set-card' }, [
          h('textarea', {
            value: msg,
            placeholder: stagedFiles.length > 0 ? '提交信息…' : '先暂存文件',
            disabled: busy,
            rows: 2,
            onChange: function (e) { setMsg(e.target.value); },
            style: {
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              minHeight: '48px', padding: '6px 8px', borderRadius: '6px',
              border: '1px solid var(--border-strong)',
              backgroundColor: 'transparent', color: 'var(--fg-primary)',
              fontFamily: 'var(--font-mono)', fontSize: '12px',
            },
          }),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', paddingTop: '6px' } }, [
            rowBtn('全部暂存 +', '暂存全部变更', function () { act(rpc('git.stage', { paths: ['.'] })); }, busy || unstagedFiles.length === 0),
            rowBtn('取消全部 −', '取消全部暂存', function () {
              act(rpc('git.unstage', { paths: stagedFiles.map(function (f) { return f.prevPath || f.path; }) }));
            }, busy || stagedFiles.length === 0),
            h('div', { style: { flex: 1 } }),
            rowBtn('commit', '提交已暂存的变更', function () {
              act(rpc('git.commit', { message: msg }), function () { setMsg(''); });
            }, busy || stagedFiles.length === 0 || !msg.trim()),
          ]),
        ]),
      ]);

      // 提交历史：车道图 + refs 徽标。nextLanes = layout 后下一行的占位
      // （由 layoutLanes 在行内递推；这里按行重放取出）。
      var logSection = h('div', { className: 'set-block' }, [
        h('div', { className: 'set-legend' }, '提交历史（' + layout.rows.length + '）'),
        h('div', { className: 'set-card' },
          layout.rows.length === 0
            ? [h('div', { style: Object.assign({ padding: '6px 8px' }, muted) }, '暂无提交')]
            : layout.rows.map(function (row, i) {
                return h(CommitRow, {
                  key: row.c.hash + ':' + i,
                  row: row,
                  laneCount: layout.laneCount,
                  // 下一行起各车道的占用（供竖线贯通判断）：简化为「该车道在
                  // 剩余提交中仍被 parent 链引用」——直接用 lanes 状态重放。
                  nextLanes: p_nextLanes(layout.rows, i),
                });
              })),
      ]);

      var diffView = diff
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'diff · ' + diff.path),
              rowBtn('✕', '关闭 diff', function () { setDiff(null); }, false),
            ]),
            h(DiffView, { text: diff.text }),
          ])
        : null;

      return h('div', { 'data-plugin-pane': c.id, style: { padding: '4px 2px' } }, [
        head,
        newBranchBar,
        errBar,
        diffView,
        fileSection('未暂存', unstagedFiles, '工作区干净'),
        fileSection('已暂存', stagedFiles, '没有已暂存的文件'),
        commitArea,
        logSection,
      ]);
    }

    /** 第 i 行之后各车道的占用快照：重放 layout 的 lanes 状态到第 i 行处理完。 */
    function p_nextLanes(rows, i) {
      var lanes = [];
      for (var k = 0; k <= i; k++) {
        var r = rows[k];
        var lane = lanes.indexOf(r.c.hash);
        if (lane === -1) {
          lane = lanes.indexOf(null);
          if (lane === -1) lane = lanes.length;
        }
        lanes[lane] = null;
        var parents = Array.isArray(r.c.parents) ? r.c.parents : [];
        for (var m = 0; m < parents.length; m++) {
          var pl = lanes.indexOf(parents[m]);
          if (pl === -1) {
            pl = lanes.indexOf(null);
            if (pl === -1) pl = lanes.length;
          }
          lanes[pl] = parents[m];
        }
      }
      return lanes;
    }

    ctx.ui.registerPane('locus.git', GitPane);
    ctx.logger.info('内置 Git 工作台面板已就绪（v1.1.0：图车道/diff 染色/分支/stash/监听刷新）');
  },
});
