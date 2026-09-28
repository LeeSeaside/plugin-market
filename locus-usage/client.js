/*!
 * 用量统计 · 渲染半（com.locus.usage）
 *
 * 契约同「关于 Locus」活模板。数据经 omp:plugin-host:invoke 桥取自 Host 半
 * （只读内核 agent.db）。图表全部手写 SVG（无图表库），配色走宿主 CSS 变量。
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

    var muted = { color: 'var(--fg-muted)', fontSize: '12px' };
    var mono = { fontFamily: 'var(--font-mono)', fontSize: '11px' };

    function fmtUsd(v) {
      if (!isFinite(v)) return '$0';
      if (v >= 100) return '$' + v.toFixed(0);
      if (v >= 1) return '$' + v.toFixed(2);
      return '$' + v.toFixed(4);
    }
    function fmtNum(v) {
      if (!isFinite(v)) return '0';
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      return String(Math.round(v));
    }

    var W = 640;
    var H = 170;
    var PADL = 46;
    var PADR = 10;
    var PADT = 12;
    var PADB = 20;

    function LineChart(props) {
      var daily = props.daily;
      var usable = daily.filter(function (d) { return d.cost > 0; });
      if (usable.length === 0) {
        return h('div', { style: Object.assign({ padding: '10px 8px' }, muted) }, '统计窗口内暂无成本数据');
      }
      var max = Math.max.apply(null, usable.map(function (d) { return d.cost; }));
      var n = daily.length;
      var plotW = W - PADL - PADR;
      var plotH = H - PADT - PADB;
      var xOf = function (i) { return PADL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
      var yOf = function (v) { return PADT + (1 - v / max) * plotH; };
      var pts = daily.map(function (d, i) { return xOf(i).toFixed(1) + ',' + yOf(d.cost).toFixed(1); }).join(' ');
      var area = 'M' + PADL + ',' + (PADT + plotH) + ' L' + pts.split(' ').join(' L') + ' L' + (PADL + plotW) + ',' + (PADT + plotH) + ' Z';
      var gridVals = [max, max / 2, 0];
      var grid = gridVals.map(function (v, i) {
        return h('g', { key: 'g' + i }, [
          h('line', {
            x1: PADL, x2: PADL + plotW, y1: yOf(v), y2: yOf(v),
            stroke: 'var(--border-strong)', strokeWidth: 1, strokeDasharray: v === 0 ? 'none' : '3 3',
          }),
          h('text', { x: PADL - 6, y: yOf(v) + 3, textAnchor: 'end', fontSize: 9, fill: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }, fmtUsd(v)),
        ]);
      });
      var firstDay = daily[0].day;
      var lastDay = daily[daily.length - 1].day;
      return h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', display: 'block' }, role: 'img', 'aria-label': '逐日成本折线图' }, [
        h('g', { key: 'grid' }, grid),
        h('path', { d: area, fill: 'var(--accent)', opacity: 0.12 }),
        h('polyline', { points: pts, fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('text', { x: PADL, y: H - 6, fontSize: 9, fill: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }, firstDay),
        h('text', { x: PADL + plotW, y: H - 6, textAnchor: 'end', fontSize: 9, fill: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }, lastDay),
      ]);
    }

    function Heatmap(props) {
      var daily = props.daily;
      var byDay = {};
      var max = 0;
      daily.forEach(function (d) {
        byDay[d.day] = d.cost;
        if (d.cost > max) max = d.cost;
      });
      var weeks = 13;
      var cells = [];
      var today = new Date();
      // 结束于本周（含今天）的 13×7 网格：列 = 周，行 = 周一..周日
      var start = new Date(today);
      start.setDate(start.getDate() - (weeks * 7 - 1));
      var dow = (start.getDay() + 6) % 7; // 周一=0
      start.setDate(start.getDate() - dow);
      var pad = (x) => String(x).padStart(2, '0');
      var key = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      for (var w = 0; w < weeks; w++) {
        for (var row = 0; row < 7; row++) {
          var d = new Date(start);
          d.setDate(start.getDate() + w * 7 + row);
          var k = key(d);
          var v = byDay[k] || 0;
          var op = 0;
          if (v > 0) op = 0.25 + 0.75 * Math.min(v / (max || 1), 1);
          cells.push(
            h('rect', {
              key: k,
              x: w * 15, y: row * 15, width: 12, height: 12, rx: 3,
              fill: 'var(--accent)', opacity: op === 0 ? 0.06 : op,
              stroke: 'var(--border-strong)', strokeWidth: 0.5,
            }, h('title', null, k + ' · ' + fmtUsd(v))),
          );
        }
      }
      return h('svg', { viewBox: '0 0 ' + weeks * 15 + ' 105', style: { width: '100%', maxWidth: '420px', display: 'block' }, role: 'img', 'aria-label': '逐日成本热力图' }, cells);
    }

    function QuotaBar(props) {
      var q = props.q;
      var pct = Math.round(q.usedFraction * 100);
      var resets = q.resetsAt ? ' · ' + new Date(q.resetsAt).toLocaleDateString() : '';
      return h('div', { key: q.limitId, style: { padding: '6px 8px' } }, [
        h('div', { style: { display: 'flex', justifyContent: 'space-between', paddingBottom: '4px' } }, [
          h('span', { style: { color: 'var(--fg-secondary)', fontSize: '12px' } }, q.label),
          h('span', { style: mono }, pct + '%' + resets),
        ]),
        h('div', {
          style: {
            height: '6px', borderRadius: '3px', overflow: 'hidden',
            backgroundColor: 'var(--border-strong)',
          },
        }, h('div', {
          style: {
            height: '100%', borderRadius: '3px',
            width: Math.min(pct, 100) + '%',
            backgroundColor: 'var(--accent)',
          },
        })),
      ]);
    }

    function UsagePane(props) {
      var c = props.ctx;
      var sm = R.useState(null), sum = sm[0], setSum = sm[1];
      var md = R.useState([]), models = md[0], setModels = md[1];
      var qt = R.useState([]), quota = qt[0], setQuota = qt[1];
      var er = R.useState(null), err = er[0], setErr = er[1];
      var bs = R.useState(false), busy = bs[0], setBusy = bs[1];

      var load = R.useCallback(function () {
        setBusy(true);
        Promise.all([rpc('usage.summary', { days: 90 }), rpc('usage.models'), rpc('usage.quota')])
          .then(function (r) {
            setSum(r[0]);
            setModels(Array.isArray(r[1]) ? r[1] : []);
            setQuota(Array.isArray(r[2]) ? r[2] : []);
            setErr(null);
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .finally(function () { setBusy(false); });
      }, []);

      R.useEffect(function () { load(); }, [load]);

      if (!sum && !err) {
        return h('div', { 'data-plugin-pane': c.id, style: { padding: '12px' } }, [
          h(ctx.beui.Loader, { variant: 'spinner', size: 14, label: '读取内核用量账本' }),
        ]);
      }

      var total = sum ? sum.total : { cost: 0, count: 0, firstDay: null, lastDay: null };
      var head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 2px' } }, [
        h('div', { style: { flex: 1 } }, [
          h('div', { style: Object.assign({}, mono, { fontSize: '15px', color: 'var(--fg-primary)' }) }, fmtUsd(total.cost)),
          h('div', { style: muted },
            total.count + ' 笔调用' + (total.firstDay ? ' · ' + total.firstDay + ' ~ ' + (total.lastDay || '') : '')),
        ]),
        h(ctx.beui.Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: load }, '⟳'),
      ]);

      var errBar = err
        ? h('div', {
            style: {
              margin: '4px 2px', padding: '6px 8px', borderRadius: '6px',
              fontSize: '12px', backgroundColor: 'var(--border-strong)',
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            },
            onClick: function () { setErr(null); },
            title: '点击关闭',
          }, err)
        : null;

      var chartCard = sum
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend' }, '逐日成本（近 90 天）'),
            h('div', { className: 'set-card', style: { padding: '8px 4px 4px' } }, [
              h(LineChart, { daily: sum.daily, key: 'lc' }),
              h(Heatmap, { daily: sum.daily, key: 'hm' }),
            ]),
          ])
        : null;

      var tokensCard = sum
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend' }, 'Token / 缓存'),
            h('div', { className: 'set-card' }, [
              h('div', { style: Object.assign({ padding: '6px 8px' }, muted) },
                sum.tokens
                  ? '缓存命中率数据可用'
                  : '暂无 token 流水 —— 内核 client_usage 表在桌面 RPC 模式下暂未写入，缓存命中率与 token 细分待内核上报后自动显形。'),
            ]),
          ])
        : null;

      var quotaCard = quota.length > 0
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend' }, '限额窗口'),
            h('div', { className: 'set-card' }, quota.map(function (q) { return h(QuotaBar, { q: q }); })),
          ])
        : null;

      var modelRows = models.map(function (m, i) {
        return h('div', { className: 'set-row', key: m.modelKey + ':' + i }, [
          h('div', { className: 'set-row-main' }, [
            h('div', { style: Object.assign({ color: 'var(--fg-secondary)' }, mono) }, m.modelKey),
            h('div', { style: Object.assign({}, muted, { fontSize: '11px' }) },
              '样本 ' + fmtNum(m.samples) + (m.ttftS != null ? ' · TTFT ' + m.ttftS.toFixed(1) + 's' : '')),
          ]),
          h('div', { style: mono }, m.tps != null ? m.tps.toFixed(1) + ' tok/s' : '—'),
        ]);
      });
      var modelsCard = modelRows.length > 0
        ? h('div', { className: 'set-block' }, [
            h('div', { className: 'set-legend' }, '模型性能'),
            h('div', { className: 'set-card' }, modelRows),
          ])
        : null;

      return h('div', { 'data-plugin-pane': c.id, style: { padding: '4px 2px' } }, [
        head,
        errBar,
        chartCard,
        tokensCard,
        quotaCard,
        modelsCard,
      ]);
    }

    ctx.ui.registerPane('locus.usage', UsagePane);
    ctx.logger.info('内置用量统计面板已就绪');
  },
});
