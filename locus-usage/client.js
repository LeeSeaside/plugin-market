/*!
 * 用量统计 · 渲染半（com.locus.usage）—— mono-charts 重制版（2026-09-29）
 *
 * 视觉基准：amicro mono-charts（单色系图表视觉器）——单一色相做明暗阶梯、
 * 圆角几何（胶囊柱 / 圆帽弧线 / 圆角热力格 / 仪表环）、大数字 + 微等宽标注。
 * 单色相 = 宿主 --accent，经透明度阶梯分层；全部配色消费 CSS 变量，
 * 亮 / 暗 / 高对比三主题自适应。
 *
 * 数据经 omp:plugin-host:invoke 桥取自 Host 半（只读内核 agent.db），
 * 图表全部手写 SVG（无图表库）。宽度自适应：主要图表用 ResizeObserver
 * 实测容器宽后 1:1 绘制，面板拉到多宽都跟随（配合工作台「窗口一半」上限）。
 * 交互提示一律自绘浮层 —— 不用原生 title（项目禁原生控件样式）。
 */
window.__OMP_PLUGIN__({
  apply: function (ctx) {
    var R = ctx.React;
    var h = R.createElement;
    var PLUGIN_ID = ctx.id;

    /* ── 动效样式表（mono-charts 观感：柱生长 / 弧线描绘 / 格子弹入）。
       插件不走 StyleX 构建线，注入一次共享 <style>；类名 lu-* 自带命名空间。
       全部 fill: backwards —— 动画结束后交还自然态，hover 过渡不被锁死。
       prefers-reduced-motion 下一律禁用。 ── */
    var MOTION_STYLE_ID = 'locus-usage-motion';
    var MOTION_CSS = [
      '@keyframes lu-draw { from { stroke-dashoffset: var(--lu-len, 1); } }',
      '@keyframes lu-grow { from { transform: scaleY(0); } }',
      '@keyframes lu-pop { from { transform: scale(.4); opacity: 0; } }',
      '@keyframes lu-fade { from { opacity: 0; } }',
      '@keyframes lu-rise { from { opacity: 0; transform: translateY(7px); } }',
      '.lu-bar { transform-box: fill-box; transform-origin: 50% 100%;',
      '  animation: lu-grow .55s cubic-bezier(.22,1,.36,1) backwards;',
      '  transition: opacity .16s ease, transform .16s ease; }',
      '.lu-bar:hover { transform: scaleY(1.045); }',
      '.lu-dot { animation: lu-fade .4s ease backwards; }',
      '.lu-line { stroke-dasharray: 1; animation: lu-draw 1s cubic-bezier(.4,0,.2,1) .1s backwards; }',
      '.lu-area { animation: lu-fade .7s ease .5s backwards; }',
      '.lu-arc { animation: lu-draw .9s cubic-bezier(.4,0,.2,1) backwards; }',
      '.lu-cell { transform-box: fill-box; transform-origin: 50% 50%;',
      '  animation: lu-pop .32s cubic-bezier(.22,1,.36,1) backwards;',
      '  transition: transform .15s ease; }',
      '.lu-cell:hover { transform: scale(1.22); }',
      '.lu-rise { animation: lu-rise .4s cubic-bezier(.22,1,.36,1) backwards; }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .lu-bar,.lu-dot,.lu-line,.lu-area,.lu-arc,.lu-cell,.lu-rise { animation: none; }',
      '  .lu-bar,.lu-cell { transition: none; }',
      '}',
    ].join('\n');
    if (typeof document !== 'undefined' && !document.getElementById(MOTION_STYLE_ID)) {
      var motionEl = document.createElement('style');
      motionEl.id = MOTION_STYLE_ID;
      motionEl.textContent = MOTION_CSS;
      document.head.appendChild(motionEl);
    }

    function rpc(method, params) {
      return ctx.api.invoke('omp:plugin-host:invoke', {
        pluginId: PLUGIN_ID,
        method: method,
        params: params || {},
      });
    }

    /* ────────────────────────── 格式化 ────────────────────────── */

    function fmtUsd(v) {
      if (!isFinite(v)) return '$0';
      if (v >= 100) return '$' + v.toFixed(0);
      if (v >= 1) return '$' + v.toFixed(2);
      return '$' + v.toFixed(4);
    }
    function fmtUsdShort(v) {
      if (!isFinite(v) || v <= 0) return '0';
      if (v >= 100) return '$' + Math.round(v);
      if (v >= 1) return '$' + v.toFixed(1);
      if (v >= 0.01) return '$' + v.toFixed(2);
      return '<1¢';
    }
    function fmtNum(v) {
      if (!isFinite(v)) return '0';
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      return String(Math.round(v));
    }
    function fmtDay(iso) {
      return typeof iso === 'string' && iso.length >= 10 ? iso.slice(5) : '';
    }
    function fmtReset(ms) {
      if (!ms) return '';
      var d = new Date(Number(ms));
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /* 单色明暗阶梯：同一 --accent，按序位取档（mono-charts 的 tone ladder）。 */
    var TONES = [1, 0.72, 0.5, 0.32, 0.18];
    function tone(i, n) {
      if (n <= 1) return TONES[0];
      var t = i / (n - 1);
      return TONES[Math.round(t * (TONES.length - 1))];
    }

    /* Catmull-Rom → 贝塞尔平滑折线；y 钳在 [lo, hi] 防过冲出格。 */
    function smoothPath(pts, lo, hi) {
      if (pts.length < 2) return '';
      var cl = function (y) { return Math.max(lo, Math.min(hi, y)); };
      var d = 'M' + pts[0][0].toFixed(2) + ',' + cl(pts[0][1]).toFixed(2);
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[Math.max(0, i - 1)];
        var p1 = pts[i];
        var p2 = pts[i + 1];
        var p3 = pts[Math.min(pts.length - 1, i + 2)];
        var c1x = p1[0] + (p2[0] - p0[0]) / 6;
        var c1y = cl(p1[1] + (p2[1] - p0[1]) / 6);
        var c2x = p2[0] - (p3[0] - p1[0]) / 6;
        var c2y = cl(p2[1] - (p3[1] - p1[1]) / 6);
        d += 'C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) +
          ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) +
          ' ' + p2[0].toFixed(2) + ',' + cl(p2[1]).toFixed(2);
      }
      return d;
    }

    /* ─────────────────────── 容器宽度实测 ─────────────────────── */

    function useWidth() {
      var ref = R.useRef(null);
      var st = R.useState(0);
      var w = st[0], setW = st[1];
      R.useEffect(function () {
        var el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        var ro = new ResizeObserver(function (entries) {
          var cr = entries[entries.length - 1].contentRect;
          if (cr.width > 0) setW(Math.round(cr.width));
        });
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, []);
      return [ref, w];
    }

    /* ─────────────────────────── 骨架 ─────────────────────────── */

    var S = {
      card: {
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border)',
        borderRadius: '16px',
        padding: '14px 16px 12px',
        minWidth: 0,
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        paddingBottom: '10px',
      },
      cardLabel: {
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '1.4px',
        color: 'var(--fg-secondary)',
        whiteSpace: 'nowrap',
      },
      chip: {
        fontFamily: 'var(--font-mono)',
        fontSize: '9.5px',
        letterSpacing: '0.6px',
        color: 'var(--accent)',
        backgroundColor: 'var(--accent-soft)',
        border: '1px solid var(--accent)',
        borderRadius: '999px',
        padding: '1px 8px',
        whiteSpace: 'nowrap',
        opacity: 0.9,
      },
      cardFoot: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '8px',
        paddingTop: '8px',
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
        color: 'var(--fg-subtle)',
      },
      well: {
        backgroundColor: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '10px 8px 6px',
        position: 'relative',
        overflow: 'hidden',
      },
      bigValue: {
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        fontSize: '24px',
        fontWeight: 700,
        lineHeight: 1.1,
        color: 'var(--fg-primary)',
      },
      unit: {
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        color: 'var(--fg-muted)',
      },
      axis: {
        fontFamily: 'var(--font-mono)',
        fontSize: '9px',
        fill: 'var(--fg-subtle)',
      },
      tip: {
        position: 'absolute',
        transform: 'translate(-50%, -100%)',
        backgroundColor: 'var(--bg-elev)',
        border: '1px solid var(--border-strong)',
        borderRadius: '8px',
        padding: '5px 9px',
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        fontSize: '11px',
        color: 'var(--fg-primary)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 6,
        boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
      },
    };

    /* 卡片 = 微标签 + 角标 chip + 右侧注记 + 内容 + 双等宽脚注。 */
    function Card(props) {
      var kids = [
        h('header', { key: 'head', style: S.cardHead }, [
          h('span', { key: 'l', style: S.cardLabel }, props.label),
          props.chip ? h('span', { key: 'c', style: S.chip }, props.chip) : null,
          h('span', { key: 'sp', style: { flex: 1 } }),
          props.right || null,
        ]),
        h('div', { key: 'body' }, props.children),
      ];
      if (props.footL || props.footR) {
        kids.push(
          h('footer', { key: 'foot', style: S.cardFoot }, [
            h('span', { key: 'fl', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.footL || ''),
            h('span', { key: 'fr', style: { whiteSpace: 'nowrap' } }, props.footR || ''),
          ]),
        );
      }
      return h('section', { style: Object.assign({}, S.card, props.style) }, kids);
    }

    /* KPI 卡：微标签 + 大数字 + 迷你走势（mono stat KPI card）。 */
    function KpiCard(props) {
      var style = props.style ? Object.assign({}, S.card, props.style) : S.card;
      return h('div', { className: props.className, style: style }, [
        h('div', { style: S.cardHead }, [
          h('span', { style: S.cardLabel }, props.label),
          h('span', { style: { flex: 1 } }),
          props.chip ? h('span', { style: S.chip }, props.chip) : null,
        ]),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } }, [
          h('span', { style: S.bigValue }, props.value),
          props.unit ? h('span', { style: S.unit }, props.unit) : null,
        ]),
        h('div', { style: { paddingTop: '8px', minHeight: '34px' } }, props.children),
      ]);
    }

    /* 迷你走势（rounded sparkline wave）：横向拉伸 + non-scaling-stroke，
       渐隐面积（mono hue 渐变淡出），任意卡宽都不变形、线宽恒定。 */
    function Spark(props) {
      var series = props.series || [];
      var max = 0;
      for (var i = 0; i < series.length; i++) if (series[i] > max) max = series[i];
      var W = 100, H = 34, top = 4, bot = 30;
      var pts = series.map(function (v, i) {
        return [
          series.length <= 1 ? W / 2 : (i / (series.length - 1)) * W,
          bot - (v / (max || 1)) * (bot - top),
        ];
      });
      var gid = 'kpi-fade-' + props.uid;
      var line = smoothPath(pts, top, bot);
      var area = line
        ? line + 'L' + W + ',' + bot + ' L0,' + bot + ' Z'
        : null;
      return h('svg', {
        viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'none',
        style: { width: '100%', height: '34px', display: 'block' },
        role: 'img',
        'aria-label': props.label || '走势',
      }, [
        h('defs', { key: 'd' }, h('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, [
          h('stop', { key: 'a', offset: '0%', stopColor: 'var(--accent)', stopOpacity: 0.32 }),
          h('stop', { key: 'b', offset: '100%', stopColor: 'var(--accent)', stopOpacity: 0 }),
        ])),
        area ? h('path', {
          key: 'a', d: area, fill: 'url(#' + gid + ')', className: 'lu-area',
        }) : null,
        line ? h('path', {
          key: 'l', d: line, fill: 'none', stroke: 'var(--accent)',
          strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          pathLength: 1, className: 'lu-line',
          style: { '--lu-len': 1 },
          vectorEffect: 'non-scaling-stroke', opacity: 0.95,
        }) : null,
      ]);
    }

    /* 区间占比胶囊（活跃天数等无序列数据时的卡内容）。 */
    function SharePill(props) {
      var pct = Math.max(0, Math.min(100, Math.round(props.frac * 100)));
      return h('div', null, [
        h('div', {
          style: {
            height: '6px', borderRadius: '3px', overflow: 'hidden',
            backgroundColor: 'var(--border)', width: '100%',
          },
        }, h('div', {
          style: {
            height: '100%', width: pct + '%', borderRadius: '3px',
            backgroundColor: 'var(--accent)', opacity: 0.9,
          },
        })),
        h('div', {
          style: {
            paddingTop: '6px', fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums', fontSize: '10px',
            color: 'var(--fg-subtle)',
          },
        }, props.note || pct + '%'),
      ]);
    }

    /* ──────── 逐日成本 · 胶囊柱（mono rounded pill pillars） ──────── */

    var BAR_H = 196;
    var BAR_PAD = { l: 40, r: 8, t: 14, b: 22 };

    function PillBars(props) {
      var daily = props.daily;
      var wrap = useWidth();
      var ref = wrap[0], w = wrap[1];
      var hv = R.useState(-1);
      var hov = hv[0], setHov = hv[1];

      var plotW = Math.max(w - BAR_PAD.l - BAR_PAD.r, 10);
      var plotH = BAR_H - BAR_PAD.t - BAR_PAD.b;
      var max = 0;
      for (var i = 0; i < daily.length; i++) if (daily[i].cost > max) max = daily[i].cost;
      var n = daily.length;
      var slot = n > 0 ? plotW / n : plotW;
      var bw = Math.max(Math.min(Math.round(slot * 0.56), 16), 2);
      var yOf = function (v) { return BAR_PAD.t + (1 - v / (max || 1)) * plotH; };

      var ticks = [1, 0.5, 0].map(function (t) {
        var y = yOf(max * t);
        return h('g', { key: 't' + t }, [
          h('line', {
            x1: BAR_PAD.l, x2: BAR_PAD.l + plotW, y1: y, y2: y,
            stroke: 'var(--border)', strokeWidth: 1,
            strokeDasharray: t === 0 ? 'none' : '2 4', opacity: t === 0 ? 1 : 0.7,
          }),
          h('text', { x: BAR_PAD.l - 6, y: y + 3, textAnchor: 'end', style: S.axis }, fmtUsdShort(max * t)),
        ]);
      });

      var bars = daily.map(function (d, i) {
        var x = BAR_PAD.l + i * slot + (slot - bw) / 2;
        var y = yOf(d.cost);
        if (d.cost <= 0) {
          /* 零成本日：基线上一枚 3px 圆点，保留节奏感（mono 风格的静默拍）。 */
          return h('rect', {
            key: d.day, x: x, y: BAR_PAD.t + plotH - 3, width: bw, height: 3,
            rx: 1.5, fill: 'var(--accent)',
            className: 'lu-dot', style: { animationDelay: (i * 10) + 'ms' },
            opacity: hov === -1 ? 0.16 : 0.08,
          });
        }
        var dimmed = hov !== -1 && hov !== i;
        return h('rect', {
          key: d.day, x: x, y: y, width: bw,
          height: Math.max(BAR_PAD.t + plotH - y, bw),
          rx: bw / 2, fill: 'var(--accent)',
          className: 'lu-bar',
          style: {
            animationDelay: (i * 10) + 'ms',
            /* 捕获区盖在柱上，:hover 落不到柱身 —— 伸长由 hover 状态驱动 */
            transform: hov === i ? 'scaleY(1.045)' : 'none',
          },
          opacity: dimmed ? 0.35 : hov === i ? 1 : 0.78,
        });
      });

      /* 悬停捕获区：整列命中，浮层自绘（禁原生 title）。 */
      var hits = daily.map(function (d, i) {
        return h('rect', {
          key: 'h' + d.day,
          x: BAR_PAD.l + i * slot, y: 0, width: Math.max(slot, 1), height: BAR_H,
          fill: 'transparent',
          onMouseEnter: function () { setHov(i); },
          onMouseLeave: function () { setHov(-1); },
        });
      });

      var first = daily[0] || { day: '' };
      var last = daily[n - 1] || { day: '' };
      var mid = daily[Math.floor((n - 1) / 2)] || { day: '' };

      var tip = null;
      if (hov >= 0 && daily[hov]) {
        var d = daily[hov];
        var bx = BAR_PAD.l + hov * slot + slot / 2;
        tip = h('div', {
          key: 'tip',
          style: Object.assign({}, S.tip, {
            left: Math.min(Math.max(bx, 54), Math.max(w - 54, 54)) + 'px',
            top: (yOf(d.cost) - 8) + 'px',
          }),
        }, fmtDay(d.day) + ' · ' + fmtUsd(d.cost) + ' · ' + d.count + ' 笔');
      }

      return h('div', { ref: ref, style: { position: 'relative', width: '100%' } }, [
        w > 0 ? h('svg', {
          key: 'svg' + w,
          width: w, height: BAR_H,
          viewBox: '0 0 ' + w + ' ' + BAR_H,
          style: { display: 'block' },
          role: 'img', 'aria-label': '逐日成本胶囊柱图',
        }, [ticks, bars, hits]) : null,
        w > 0 ? h('div', {
          key: 'xl',
          style: {
            display: 'flex', justifyContent: 'space-between',
            padding: '4px 8px 0 ' + (BAR_PAD.l - 8) + 'px',
            fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--fg-subtle)',
          },
        }, [
          h('span', { key: 'f' }, fmtDay(first.day)),
          h('span', { key: 'm' }, n > 2 ? fmtDay(mid.day) : ''),
          h('span', { key: 'l' }, fmtDay(last.day)),
        ]) : null,
        tip,
      ]);
    }

    /* ──────── 活跃分布 · 圆角热力格（activity heatmap, 13 周 × 7 天） ──────── */

    function HeatGrid(props) {
      var daily = props.daily;
      var wrap = useWidth();
      var ref = wrap[0], w = wrap[1];
      var hv = R.useState(null);
      var hov = hv[0], setHov = hv[1];

      var byDay = {};
      var max = 0;
      daily.forEach(function (d) {
        byDay[d.day] = d;
        if (d.cost > max) max = d.cost;
      });

      var weeks = 13;
      var pitch = Math.max(Math.min(Math.floor(w / weeks) || 14, 22), 10);
      var cell = pitch - 3;
      var gridW = weeks * pitch;
      var gridH = 7 * pitch;

      var today = new Date();
      var start = new Date(today);
      start.setDate(start.getDate() - (weeks * 7 - 1));
      var dow = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - dow);
      var pad = function (x) { return String(x).padStart(2, '0'); };
      var key = function (d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      };

      var cells = [];
      for (var wk = 0; wk < weeks; wk++) {
        for (var row = 0; row < 7; row++) {
          var d = new Date(start);
          d.setDate(start.getDate() + wk * 7 + row);
          var k = key(d);
          var rec = byDay[k];
          var v = rec ? rec.cost : 0;
          var t = v / (max || 1);
          var op = 0;
          if (v > 0) op = t <= 0.25 ? 0.32 : t <= 0.5 ? 0.55 : t <= 0.75 ? 0.78 : 1;
          var hovK = hov && hov.k === k;
          cells.push(
            h('rect', {
              key: k,
              x: wk * pitch, y: row * pitch, width: cell, height: cell, rx: Math.max(cell * 0.28, 2),
              fill: v > 0 ? 'var(--accent)' : 'var(--border)',
              opacity: v > 0 ? op : 0.55,
              className: 'lu-cell',
              style: {
                animationDelay: ((wk * 7 + row) * 5) + 'ms',
                transform: hovK ? 'scale(1.22)' : 'none',
              },
            }),
          );
        }
      }

      /* 悬停命名（React 合成事件拿不到循环变量，逐格包一层带捕获的 g）。 */
      var hitCells = [];
      for (var wk2 = 0; wk2 < weeks; wk2++) {
        for (var row2 = 0; row2 < 7; row2++) {
          (function (wk2, row2) {
            var d = new Date(start);
            d.setDate(start.getDate() + wk2 * 7 + row2);
            var k = key(d);
            var rec = byDay[k];
            hitCells.push(
              h('rect', {
                key: 'hit' + k,
                x: wk2 * pitch, y: row2 * pitch, width: pitch, height: pitch,
                fill: 'transparent',
                onMouseEnter: function () { setHov({ k: k, rec: rec || null, cx: wk2 * pitch + pitch / 2, cy: row2 * pitch }); },
                onMouseLeave: function () { setHov(null); },
              }),
            );
          })(wk2, row2);
        }
      }

      var tip = null;
      if (hov) {
        tip = h('div', {
          key: 'tip',
          style: Object.assign({}, S.tip, {
            left: Math.min(Math.max(hov.cx, 60), Math.max(gridW - 60, 60)) + 'px',
            top: (hov.cy - 6) + 'px',
          }),
        }, hov.rec
          ? fmtDay(hov.k) + ' · ' + fmtUsd(hov.rec.cost) + ' · ' + hov.rec.count + ' 笔'
          : fmtDay(hov.k) + ' · 无记录');
      }

      /* 图例：少 □□□□ 多（四档明暗）。 */
      var legendOps = [0.32, 0.55, 0.78, 1];
      var legend = h('div', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
      }, [
        h('span', { key: 'l', style: { paddingRight: '2px' } }, '少'),
        legendOps.map(function (op, i) {
          return h('span', {
            key: i,
            style: {
              width: '8px', height: '8px', borderRadius: '2.5px',
              backgroundColor: 'var(--accent)', opacity: op, display: 'inline-block',
            },
          });
        }),
        h('span', { key: 'r', style: { paddingLeft: '2px' } }, '多'),
      ]);

      return h('div', { ref: ref, style: { position: 'relative', width: '100%' } }, [
        w > 0 ? h('svg', {
          key: 'svg' + w,
          width: gridW, height: gridH,
          viewBox: '0 0 ' + gridW + ' ' + gridH,
          style: { display: 'block', margin: '0 auto' },
          role: 'img', 'aria-label': '逐日成本热力格',
        }, [cells, hitCells]) : null,
        tip,
        w > 0 ? h('div', {
          key: 'legend',
          style: {
            display: 'flex', justifyContent: 'center', paddingTop: '8px',
            fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--fg-subtle)',
          },
        }, legend) : null,
      ]);
    }

    /* ──────── 限额窗口 · 仪表环（speedometer arc, 240° 圆帽） ──────── */

    function Gauge(props) {
      var q = props.q;
      var pct = Math.max(0, Math.min(1, Number(q.usedFraction) || 0));
      var size = 112;
      var cx = size / 2, cy = size / 2, r = 41, sw = 10;
      var A0 = 150, SWEEP = 240;
      var pt = function (aDeg) {
        var a = (aDeg * Math.PI) / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      };
      var arc = function (a0, a1) {
        var p0 = pt(a0);
        var p1 = pt(a1);
        var large = a1 - a0 > 180 ? 1 : 0;
        return 'M' + p0[0].toFixed(2) + ',' + p0[1].toFixed(2) +
          ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' +
          p1[0].toFixed(2) + ',' + p1[1].toFixed(2);
      };
      var hue = pct >= 0.9 ? 'var(--danger)' : pct >= 0.75 ? 'var(--warn)' : 'var(--accent)';
      var vEnd = A0 + SWEEP * Math.max(pct, 0.004);
      var vLen = Math.max(pct, 0.004) * 100; // pathLength=100 归一后的弧长
      var pctText = Math.round(pct * 100) + '%';
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: '6px', minWidth: '128px', flex: '1 1 128px', maxWidth: '190px',
        },
      }, [
        h('div', { style: { position: 'relative', width: size + 'px', height: size * 0.78 + 'px', overflow: 'hidden' } }, [
          h('svg', {
            width: size, height: size,
            viewBox: '0 0 ' + size + ' ' + size,
            style: { display: 'block' },
            role: 'img', 'aria-label': q.label + ' ' + pctText,
          }, [
            h('path', {
              d: arc(A0, A0 + SWEEP), fill: 'none',
              stroke: 'var(--accent)', opacity: 0.14,
              strokeWidth: sw, strokeLinecap: 'round',
            }),
            h('path', {
              d: arc(A0, vEnd), fill: 'none',
              stroke: hue, strokeWidth: sw, strokeLinecap: 'round',
              pathLength: 100, className: 'lu-arc',
              style: { '--lu-len': vLen, animationDelay: '150ms' },
              strokeDasharray: vLen + ' 1000',
            }),
          ]),
          h('div', {
            style: {
              position: 'absolute', left: 0, right: 0, top: '38%',
              textAlign: 'center',
            },
          }, [
            h('div', {
              style: {
                fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: '19px', fontWeight: 700, color: 'var(--fg-primary)',
                lineHeight: 1.05,
              },
            }, pctText),
            h('div', { style: { fontSize: '9px', color: 'var(--fg-subtle)', letterSpacing: '1px' } }, '已用'),
          ]),
        ]),
        h('div', { style: { fontSize: '12px', color: 'var(--fg-secondary)', textAlign: 'center' } }, q.label),
        q.resetsAt
          ? h('div', {
              style: {
                fontFamily: 'var(--font-mono)', fontSize: '10px',
                color: 'var(--fg-subtle)',
              },
            }, '重置 ' + fmtReset(q.resetsAt))
          : null,
      ]);
    }

    /* ──────── 供应商构成 · 分段环（rounded donut, 软圆帽 + 明暗阶梯） ──────── */

    function Donut(props) {
      var providers = props.providers;
      var total = 0;
      providers.forEach(function (p) { total += p.count; });
      var top = providers.slice(0, 5);
      var restCount = providers.slice(5).reduce(function (a, p) { return a + p.count; }, 0);
      if (restCount > 0) top = top.concat([{ provider: '其他', count: restCount, cost: 0 }]);
      var segs = top.filter(function (p) { return p.count > 0; });

      var size = 148;
      var cx = size / 2, cy = size / 2, r = 56, sw = 14;
      var gapDeg = segs.length > 1 ? 9 : 0;
      var acc = -90;
      var arcs = segs.map(function (p, i) {
        var sweep = (p.count / (total || 1)) * 360;
        var a0 = acc + gapDeg / 2;
        var a1 = acc + sweep - gapDeg / 2;
        acc += sweep;
        if (a1 <= a0) return null;
        var rad0 = (a0 * Math.PI) / 180;
        var rad1 = (a1 * Math.PI) / 180;
        var x0 = cx + r * Math.cos(rad0), y0 = cy + r * Math.sin(rad0);
        var x1 = cx + r * Math.cos(rad1), y1 = cy + r * Math.sin(rad1);
        var large = a1 - a0 > 180 ? 1 : 0;
        var segLen = Math.max(((a1 - a0) / 360) * 100, 0.5);
        return h('path', {
          key: p.provider + i,
          d: 'M' + x0.toFixed(2) + ',' + y0.toFixed(2) +
            ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ',' + y1.toFixed(2),
          fill: 'none', stroke: 'var(--accent)', opacity: tone(i, segs.length),
          strokeWidth: sw, strokeLinecap: 'round',
          pathLength: 100, className: 'lu-arc',
          style: { '--lu-len': segLen, animationDelay: (150 + i * 120) + 'ms' },
          strokeDasharray: segLen + ' 1000',
        });
      });

      var legend = segs.map(function (p, i) {
        var share = Math.round((p.count / (total || 1)) * 100);
        return h('div', {
          key: p.provider + i,
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' },
        }, [
          h('span', {
            style: {
              width: '7px', height: '7px', borderRadius: '999px',
              backgroundColor: 'var(--accent)', opacity: tone(i, segs.length),
              flexShrink: 0,
            },
          }),
          h('span', {
            style: {
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)',
              fontSize: '11px', color: 'var(--fg-secondary)',
            },
          }, p.provider),
          h('span', {
            style: {
              fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
              fontSize: '11px', color: 'var(--fg-primary)',
            },
          }, p.cost > 0 ? fmtUsd(p.cost) : ''),
          h('span', {
            style: {
              fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
              fontSize: '10px', color: 'var(--fg-subtle)', width: '38px',
              textAlign: 'right',
            },
          }, share + '%'),
        ]);
      });

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '16px',
          flexWrap: 'wrap', paddingTop: '2px',
        },
      }, [
        h('div', { key: 'ring', style: { position: 'relative', width: size + 'px', height: size + 'px', flexShrink: 0 } }, [
          h('svg', {
            width: size, height: size, viewBox: '0 0 ' + size + ' ' + size,
            style: { display: 'block' },
            role: 'img', 'aria-label': '供应商调用构成',
          }, arcs),
          h('div', {
            style: {
              position: 'absolute', inset: 0, display: 'flex',
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            },
          }, [
            h('div', {
              style: {
                fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: '20px', fontWeight: 700, color: 'var(--fg-primary)',
              },
            }, fmtNum(total)),
            h('div', { style: { fontSize: '9px', color: 'var(--fg-subtle)', letterSpacing: '1px' } }, '笔调用'),
          ]),
        ]),
        h('div', { key: 'legend', style: { flex: 1, minWidth: '150px' } }, legend),
      ]);
    }

    /* ──────── 模型性能 · 子弹条（performance bullet bars） ──────── */

    function ModelRows(props) {
      var models = props.models.slice(0, 12);
      var maxTps = 0;
      models.forEach(function (m) { if (m.tps && m.tps > maxTps) maxTps = m.tps; });
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '2px' } },
        models.map(function (m, i) {
          var wPct = m.tps && maxTps > 0 ? Math.max((m.tps / maxTps) * 100, 2) : 0;
          return h('div', { key: m.modelKey + ':' + i }, [
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', paddingBottom: '5px' } }, [
              h('span', {
                style: {
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)',
                  fontSize: '11.5px', color: 'var(--fg-secondary)',
                },
              }, m.modelKey),
              m.ttftS != null
                ? h('span', {
                    style: {
                      fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                      fontSize: '10px', color: 'var(--fg-subtle)',
                    },
                  }, 'TTFT ' + m.ttftS.toFixed(1) + 's')
                : null,
              h('span', {
                style: {
                  fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                  fontSize: '12.5px', fontWeight: 600, color: 'var(--fg-primary)',
                  minWidth: '74px', textAlign: 'right',
                },
              }, m.tps != null ? m.tps.toFixed(1) : '—'),
              h('span', { style: Object.assign({}, S.unit, { fontSize: '10px' }) }, 'tok/s'),
            ]),
            h('div', {
              style: {
                height: '6px', borderRadius: '3px', overflow: 'hidden',
                backgroundColor: 'var(--border)',
              },
            }, h('div', {
              style: {
                height: '100%', width: wPct + '%', borderRadius: '3px',
                backgroundColor: 'var(--accent)', opacity: 0.9,
              },
            })),
            h('div', {
              style: {
                paddingTop: '3px', fontFamily: 'var(--font-mono)',
                fontSize: '9.5px', color: 'var(--fg-subtle)',
              },
            }, '样本 ' + fmtNum(m.samples)),
          ]);
        }),
      );
    }

    /* ─────────────────────────── 面板 ─────────────────────────── */

    var RANGES = [
      { days: 7, label: '7 天' },
      { days: 30, label: '30 天' },
      { days: 90, label: '90 天' },
      { days: 365, label: '1 年' },
    ];

    function Segmented(props) {
      return h('div', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '2px',
          backgroundColor: 'var(--bg-soft)', border: '1px solid var(--border)',
          borderRadius: '999px', padding: '2px',
        },
      }, RANGES.map(function (r) {
        var active = props.days === r.days;
        return h('button', {
          key: r.days,
          onClick: function () { props.onPick(r.days); },
          disabled: props.busy,
          style: {
            fontFamily: 'var(--font-mono)', fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            padding: '3px 11px', borderRadius: '999px',
            border: active ? '1px solid var(--accent)' : '1px solid transparent',
            backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
            color: active ? 'var(--fg-primary)' : 'var(--fg-muted)',
            cursor: 'pointer', lineHeight: 1.4,
          },
        }, r.label);
      }));
    }

    function UsagePane(props) {
      var c = props.ctx;
      var sm = R.useState(null), sum = sm[0], setSum = sm[1];
      /* 热力格独立数据源：固定 90 天窗口，不随范围切换清空（13 周视图）。 */
      var sh = R.useState(null), sum90 = sh[0], setSum90 = sh[1];
      var md = R.useState([]), models = md[0], setModels = md[1];
      var qt = R.useState([]), quota = qt[0], setQuota = qt[1];
      var er = R.useState(null), err = er[0], setErr = er[1];
      var bs = R.useState(false), busy = bs[0], setBusy = bs[1];
      var dy = R.useState(90), days = dy[0], setDays = dy[1];
      var rootRef = R.useRef(null);
      var lastLoadAt = R.useRef(0);
      var daysRef = R.useRef(days);
      daysRef.current = days;

      var load = R.useCallback(function (d) {
        lastLoadAt.current = Date.now();
        setBusy(true);
        Promise.all([
          rpc('usage.summary', { days: d }),
          rpc('usage.summary', { days: 90 }),
          rpc('usage.models'),
          rpc('usage.quota'),
        ])
          .then(function (r) {
            setSum(r[0]);
            setSum90(r[1]);
            setModels(Array.isArray(r[2]) ? r[2] : []);
            setQuota(Array.isArray(r[3]) ? r[3] : []);
            setErr(null);
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .finally(function () { setBusy(false); });
      }, []);

      R.useEffect(function () { load(90); }, [load]); // 首载固定 90 天；切窗口走 onPick

      /* 面板重新可见（隐藏的 tab 是 display:none，IO 能感知）→ 数据超过
         60s 就自动重同步。这样就不需要手动刷新按钮了。 */
      var paneReady = !!sum || !!err;
      R.useEffect(function () {
        var el = rootRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return undefined;
        var io = new IntersectionObserver(function (entries) {
          var vis = entries[entries.length - 1].isIntersecting;
          if (!vis) return;
          if (Date.now() - lastLoadAt.current < 60_000) return;
          load(daysRef.current);
        }, { threshold: 0.05 });
        io.observe(el);
        return function () { io.disconnect(); };
      }, [load, paneReady]); // 就绪后根节点换人，重挂观察

      if (!sum && !err) {
        return h('div', { 'data-plugin-pane': c.id, ref: rootRef, style: { padding: '16px 4px' } }, [
          h(ctx.beui.Loader, { variant: 'spinner', size: 14, label: '读取内核用量账本' }),
        ]);
      }

      var daily = sum ? sum.daily || [] : [];
      var rangeCost = 0;
      var rangeCount = 0;
      var activeDays = 0;
      var peak = { cost: 0, day: '' };
      daily.forEach(function (d) {
        rangeCost += d.cost;
        rangeCount += d.count;
        /* 活跃 = 有调用的天（有 token 流水即算，成本可为 0 的无价调用也算） */
        if (d.count > 0) activeDays++;
        if (d.cost > peak.cost) peak = { cost: d.cost, day: d.day };
      });
      /* 分母用选中的窗口天数（GROUP BY 只返回有记录的日子，daily.length 会少算） */
      var span = days;
      var avgCost = activeDays > 0 ? rangeCost / activeDays : 0;
      var total = sum ? sum.total : { cost: 0, count: 0 };

      /* 切窗口即重查（先于 head 引用） */
      var onPick = function (d) { setDays(d); load(d); };

      var head = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          flexWrap: 'wrap', padding: '2px 2px 12px',
        },
      }, [
        h('div', { key: 't', style: { flex: 1, minWidth: '150px' } }, [
          h('div', { style: { fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)' } }, '用量统计'),
          h('div', {
            style: {
              fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
              fontSize: '10px', color: 'var(--fg-subtle)', paddingTop: '2px',
            },
          }, '累计 ' + fmtUsd(total.cost) + ' · ' + fmtNum(total.count) + ' 笔' +
            (total.lastDay ? ' · 记至 ' + fmtDay(total.lastDay) : '') +
            ' · API 等价口径'),
        ]),
        h(Segmented, { key: 'seg', days: days, busy: busy, onPick: onPick }),
      ]);

      var errBar = err
        ? h('div', {
            key: 'err',
            onClick: function () { setErr(null); },
            style: {
              margin: '0 2px 12px', padding: '8px 12px',
              border: '1px solid var(--border-strong)', borderRadius: '10px',
              backgroundColor: 'var(--bg-panel)', fontSize: '12px',
              color: 'var(--fg-secondary)', cursor: 'pointer',
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            },
          }, '加载失败 · 点击关闭\n' + err)
        : null;

      var hasData = rangeCost > 0;

      /* KPI 行：区间成本 / 区间调用 / 活跃天数 / 单日峰值（key 带窗口 → 切范围重放 rise） */
      var kpis = h('div', {
        key: 'kpis-' + days,
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '10px',
          paddingBottom: '10px',
        },
      }, [
        h(KpiCard, { key: 'cost', label: '区间成本', chip: '等价USD', className: 'lu-rise' },
          h(Spark, { series: daily.map(function (d) { return d.cost; }), uid: 'c' + days, label: '逐日成本走势' })),
        h(KpiCard, { key: 'calls', label: '区间调用', chip: 'CALLS', className: 'lu-rise', style: { animationDelay: '50ms' } },
          h(Spark, { series: daily.map(function (d) { return d.count; }), uid: 'n' + days, label: '逐日调用走势' })),
        h(KpiCard, { key: 'act', label: '活跃天数', chip: span + 'D', className: 'lu-rise', style: { animationDelay: '100ms' } },
          h(SharePill, {
            frac: span > 0 ? activeDays / span : 0,
            note: activeDays + ' / ' + (span || 0) + ' 天有调用',
          })),
        h(KpiCard, { key: 'peak', label: '单日峰值', chip: 'PEAK', className: 'lu-rise', style: { animationDelay: '150ms' } },
          h('div', { style: { paddingTop: '9px' } }, [
            h('div', {
              style: {
                fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: '11px', color: 'var(--fg-muted)',
              },
            }, peak.day ? fmtDay(peak.day) : '—'),
            h('div', { style: { fontSize: '10px', color: 'var(--fg-subtle)', paddingTop: '3px' } }, '单日最高消耗'),
          ])),
      ]);

      var barCard = h(Card, {
        key: 'bars',
        label: '逐日成本',
        chip: '胶囊柱',
        right: h('span', {
          style: {
            fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
            fontSize: '10px', color: 'var(--fg-subtle)',
          },
        }, '日均 ' + fmtUsd(avgCost)),
        footL: span + ' 天窗口 · ' + activeDays + ' 天有调用',
        footR: '峰值 ' + fmtUsd(peak.cost),
      },
        hasData
          ? h(PillBars, { key: 'bars-' + days, daily: daily })
          : h('div', {
              style: {
                padding: '22px 8px', textAlign: 'center',
                fontFamily: 'var(--font-mono)', fontSize: '11px',
                color: 'var(--fg-subtle)', lineHeight: 1.9,
              },
            }, [
              h('div', { key: 'a' }, '区间内无成本记录'),
              h('div', { key: 'b', style: { fontSize: '10px', opacity: 0.85 } },
                total.lastDay
                  ? '成本账本最后一条为 ' + fmtDay(total.lastDay) + ' —— 订阅 / token-plan 模型不产生美元成本行'
                  : '暂无任何成本记录'),
            ]),
      );

      var heatDaily = (sum90 && sum90.daily) || daily;
      var heatCard = h(Card, {
        key: 'heat',
        label: '活跃分布',
        chip: '热力格',
        footL: '近 13 周 · 固定窗口',
        footR: '悬停查看当日明细',
      }, h(HeatGrid, { daily: heatDaily }));

      var quotaCard = quota.length > 0
        ? h(Card, {
            key: 'quota',
            label: '限额窗口',
            chip: '仪表环',
            footL: '按最近一次上报快照',
            footR: '≥75% 转黄 · ≥90% 转红',
          }, h('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' },
          }, quota.map(function (q) { return h(Gauge, { key: q.limitId, q: q }); })))
        : null;

      var provCard = sum && sum.providers && sum.providers.length >= 2
        ? h(Card, {
            key: 'prov',
            label: '供应商构成',
            chip: '分段环',
            footL: segNote(sum.providers),
            footR: '按调用量分档',
          }, h(Donut, { providers: sum.providers }))
        : null;

      var modelsCard = models.length > 0
        ? h(Card, {
            key: 'models',
            label: '模型性能',
            chip: '子弹条',
            right: h('span', {
              style: {
                fontFamily: 'var(--font-mono)', fontSize: '10px',
                color: 'var(--fg-subtle)',
              },
            }, '输出速度 tok/s'),
            footL: '条长 = 相对最快模型',
            footR: models.length + ' 个模型',
          }, h(ModelRows, { models: models }))
        : null;

      return h('div', {
        'data-plugin-pane': c.id,
        style: {
          padding: '10px 12px 16px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        },
      }, [head, errBar, kpis, barCard, heatCard, quotaCard, provCard, modelsCard]);
    }

    function segNote(providers) {
      return providers.length + ' 个供应商 · 共 ' +
        fmtNum(providers.reduce(function (a, p) { return a + p.count; }, 0)) + ' 笔';
    }

    ctx.ui.registerPane('locus.usage', UsagePane);
    ctx.logger.info('用量统计面板（mono-charts 版）已就绪');
  },
});
