/* 自绘 canvas 折线图(R9,2026-09-22 yang 拍板:不用第三方图表库)

   ★ 为什么不用 ec-canvas / ECharts
     1) 体积:ECharts 精简版打进小程序也要 200KB+。主包上限 2MB,
        为了一个 7 点的折线图花掉 1/10 配额不划算。
     2) 场景简单:固定 7 个点 + 一条零轴 + 一个折线,不需要交互缩放、
        图例开关、tooltip 跟随。用不到的能力就是负债。
     3) 可控:配色、字号要贴合"卡通柔和"的产品调性,现成库改样式比自绘还费劲。

   ★ canvas 2d 的坑(都踩过)
     - 必须用 type="2d" 的新接口,老接口 createCanvasContext 已废弃且不清晰
     - 要按 dpr 放大 canvas 再 setTransform,否则高清屏发虚
     - 每次 setData 换数据后要**重新获取 node**,旧 node 会失效
     - 圆点在 canvas 里要自己画,没有现成 API

   ★ 用法:页面 wxml 放 <canvas type="2d" id="trendChart" class="chart"/>
     页面 js 里 require 本模块,onReady 时 init,数据到了调 draw */

const COLOR = {
  line: '#3D8BFD',          /* 主色,折线 */
  lineSoft: 'rgba(61,139,253,0.12)',   /* 区域填充 */
  zero: '#D8E3F0',          /* 零轴 */
  grid: '#EEF3F9',          /* 横向网格 */
  text: '#8A97A6',          /* 轴标签 */
  point: '#FFFFFF',
  good: '#3D8BFD',
  bad: '#FF8A7A'
};

/**
 * 初始化 canvas,返回一个 draw 函数。
 * @param {Object} page    页面实例(this)
 * @param {string} canvasId canvas 的 id
 * @param {Function} cb    回调 (drawFn) => void
 */
function initChart(page, canvasId, cb) {
  const query = wx.createSelectorQuery().in(page);
  query.select('#' + canvasId)
    .fields({ node: true, size: true })
    .exec(function (res) {
      if (!res || !res[0] || !res[0].node) {
        console.warn('[chart] 找不到 canvas 节点:', canvasId);
        cb(null);
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 2;

      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);

      /* 缓存尺寸,draw 时按 CSS 像素坐标画 */
      const w = res[0].width;
      const h = res[0].height;

      cb(function draw(trend, axis) {
        drawTrend(ctx, w, h, trend || [], axis || {});
      });
    });
}

/**
 * 画折线。
 * @param {Array} trend [{ label, net, bonus, penalty }]
 * @param {Object} axis { min, max }
 */
function drawTrend(ctx, w, h, trend, axis) {
  ctx.clearRect(0, 0, w, h);

  if (!trend.length) {
    ctx.fillStyle = COLOR.text;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('还没有数据', w / 2, h / 2);
    return;
  }

  /* ---------- 布局 ---------- */
  const padL = 34, padR = 12, padT = 16, padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  let min = Number(axis.min);
  let max = Number(axis.max);
  if (!isFinite(min) || !isFinite(max) || max <= min) {
    min = -5; max = 5;
  }
  const span = max - min;

  /* 值 → y 坐标 */
  function yOf(v) {
    return padT + plotH - ((v - min) / span) * plotH;
  }
  /* 下标 → x 坐标 */
  const n = trend.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  function xOf(i) { return padL + (n > 1 ? i * stepX : plotW / 2); }

  /* ---------- 横向网格 + Y 轴刻度 ---------- */
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  /* 从 max 往下取 4 条线,并保证 0 轴一定在 */
  const ticks = [];
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    ticks.push(max - (span / tickCount) * i);
  }
  /* 去重后画(避免 0 附近出现两条重合线) */
  const drawn = {};
  ticks.forEach(function (v) {
    const y = yOf(v);
    const key = Math.round(y);
    if (drawn[key]) return;
    drawn[key] = true;

    const isZero = Math.abs(v) < 0.001 || (v > 0 && v - (span / tickCount) < 0);
    ctx.strokeStyle = isZero ? COLOR.zero : COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();

    ctx.fillStyle = COLOR.text;
    ctx.fillText(String(Math.round(v)), padL - 6, y);
  });

  /* ---------- 零轴加粗,让正负一眼可分 ---------- */
  if (min < 0 && max > 0) {
    const zy = yOf(0);
    ctx.strokeStyle = COLOR.zero;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, zy);
    ctx.lineTo(w - padR, zy);
    ctx.stroke();
  }

  /* ---------- 区域填充(折线下方淡色) ---------- */
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(trend[0].net));
  for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(trend[i].net));
  /* 收口到零轴(或底边),形成闭合区域 */
  const baseY = (min < 0 && max > 0) ? yOf(0) : (padT + plotH);
  ctx.lineTo(xOf(n - 1), baseY);
  ctx.lineTo(xOf(0), baseY);
  ctx.closePath();
  ctx.fillStyle = COLOR.lineSoft;
  ctx.fill();

  /* ---------- 折线 ---------- */
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(trend[0].net));
  for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(trend[i].net));
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  /* ---------- 数据点(圆点) ---------- */
  for (let i = 0; i < n; i++) {
    const v = trend[i].net;
    /* 负分用暖色点,和主色区分开,避免孩子看着都是"蓝的" */
    ctx.beginPath();
    ctx.arc(xOf(i), yOf(v), 3, 0, Math.PI * 2);
    ctx.fillStyle = v < 0 ? COLOR.bad : COLOR.line;
    ctx.fill();
    ctx.strokeStyle = COLOR.point;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /* ---------- 横轴标签 ---------- */
  ctx.fillStyle = COLOR.text;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelStep = n > 8 ? Math.ceil(n / 7) : 1;
  for (let i = 0; i < n; i++) {
    if (i % labelStep !== 0 && i !== n - 1) continue;
    ctx.fillText(trend[i].label || '', xOf(i), padT + plotH + 8);
  }
}

module.exports = { initChart, drawTrend, COLOR };
