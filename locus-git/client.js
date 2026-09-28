/*!
 * Git 工作台 · 渲染半（com.locus.git）
 *
 * 契约与「关于 Locus」活模板一致：window.__OMP_PLUGIN__({ apply(ctx) })，
 * ctx.beui + ctx.api.invoke。与 Host 半的通信走 omp:plugin-host:invoke 桥
 * （workspace 由服务端注入，client 不传）。样式复用 omp.css 全局
 * set-* 类 + CSS 变量内联（与宿主主题单源联动）。
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

    function CommitRow(p) {
      var c = p.c;
      return h(
        'div',
        { className: 'set-row', key: c.hash },
        [
          h('div', { className: 'set-row-main', style: { minWidth: 0 } }, [
            h('div', { style: Object.assign({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-secondary)' } }, c.subject)),
            h('div', { style: Object.assign({}, muted, { fontSize: '11px' }) }, c.short + ' · ' + c.author + ' · ' + c.date),
          ]),
        ],
      );
    }

    function GitPane(props) {
      var c = props.ctx;
      var st = R.useState(null), data = st[0], setData = st[1];
      var lg = R.useState([]), log = lg[0], setLog = lg[1];
      var bs = R.useState(false), busy = bs[0], setBusy = bs[1];
      var er = R.useState(null), err = er[0], setErr = er[1];
      var ms = R.useState(''), msg = ms[0], setMsg = ms[1];
      var df = R.useState(null), diff = df[0], setDiff = df[1];

      var load = R.useCallback(
        function () {
          setBusy(true);
          Promise.all([rpc('git.status'), rpc('git.log', { n: 30 })])
            .then(function (r) {
              setData(r[0]);
              setLog(Array.isArray(r[1]) ? r[1] : []);
              setErr(null);
            })
            .catch(function (e) {
              setErr(String((e && e.message) || e));
            })
            .finally(function () {
              setBusy(false);
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
      );

      R.useEffect(function () {
        load();
      }, [load]);

      function act(promise, done) {
        setBusy(true);
        promise
          .then(function () {
            setErr(null);
            return Promise.all([rpc('git.status'), rpc('git.log', { n: 30 })]).then(function (r) {
              setData(r[0]);
              setLog(Array.isArray(r[1]) ? r[1] : []);
              if (done) done();
            });
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      function showDiff(f) {
        setBusy(true);
        rpc('git.diff', { path: f.path, cached: f.staged && !f.unstaged })
          .then(function (r) {
            setDiff({ path: f.label || f.path, text: String(r.text || '') });
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .finally(function () {
            setBusy(false);
          });
      }

      var stagedFiles = (data && data.files ? data.files : []).filter(function (f) { return f.staged; });
      var unstagedFiles = (data && data.files ? data.files : []).filter(function (f) { return !f.staged; });

      if (!data && !err) {
        return h('div', { 'data-plugin-pane': c.id, style: { padding: '12px' } }, [
          h(ctx.beui.Loader, { variant: 'spinner', size: 14, label: '读取 Git 状态' }),
        ]);
      }

      var head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 2px' } }, [
        h('div', { style: Object.assign({}, mono, { color: 'var(--fg-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
          (data && data.branch ? data.branch : '（无分支)') +
            (data && data.ahead ? ' ↑' + data.ahead : '') +
            (data && data.behind ? ' ↓' + data.behind : '')),
        rowBtn('⟳', '刷新', load, busy),
        rowBtn('pull', '拉取（--ff-only）', function () { act(rpc('git.pull')); }, busy),
        rowBtn('push', '推送到远端', function () { act(rpc('git.push')); }, busy),
      ]);

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

      var fileSection = function (title, files, emptyHint) {
        return h('div', { className: 'set-block', key: title }, [
          h('div', { className: 'set-legend' }, title + '（' + files.length + '）'),
          h('div', { className: 'set-card' },
            files.length === 0
              ? [h('div', { style: Object.assign({ padding: '6px 8px' }, muted) }, emptyHint)]
              : files.map(function (f, i) {
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

      var logSection = h('div', { className: 'set-block' }, [
        h('div', { className: 'set-legend' }, '提交历史'),
        h('div', { className: 'set-card' },
          log.length === 0
            ? [h('div', { style: Object.assign({ padding: '6px 8px' }, muted) }, '暂无提交')]
            : log.map(function (cItem) { return h(CommitRow, { c: cItem }); })),
      ]);

      var diffView = diff
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend', style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'diff · ' + diff.path),
              rowBtn('✕', '关闭 diff', function () { setDiff(null); }, false),
            ]),
            h('div', {
              style: Object.assign({}, mono, {
                margin: '0 4px 8px', padding: '8px', borderRadius: '6px',
                border: '1px solid var(--border-strong)',
                backgroundColor: 'transparent',
                color: 'var(--fg-secondary)',
                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                maxHeight: '320px', overflowY: 'auto', userSelect: 'text',
              }),
            }, diff.text || '（无差异）'),
          ])
        : null;

      return h('div', { 'data-plugin-pane': c.id, style: { padding: '4px 2px' } }, [
        head,
        errBar,
        diffView,
        fileSection('未暂存', unstagedFiles, '工作区干净'),
        fileSection('已暂存', stagedFiles, '没有已暂存的文件'),
        commitArea,
        logSection,
      ]);
    }

    ctx.ui.registerPane('locus.git', GitPane);
    ctx.logger.info('内置 Git 工作台面板已就绪');
  },
});
