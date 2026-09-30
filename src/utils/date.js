/* 日期工具 —— 前端侧

   ★ 唯一的硬坑:禁止用 toISOString() 取日期
     toISOString() 输出 UTC。中国是 UTC+8,所以**每天 08:00 之前**,
     它拿到的还是前一天。早上 7 点孩子打了卡,系统会记到昨天去。
     这不是"最佳实践",是必须绕开的错误。

   ★ 这里有多份副本(每个云函数的 _shared/streak.js 里也有一份)
     因为云函数是独立部署单元,不能 require 主包的 src/。
     两边实现必须一致 —— tests/dateParity.test.js 会校验关键输出相等。 */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* Date → 'YYYY-MM-DD'(本地时区) */
function dayKey(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* 'YYYY-MM-DD' → Date(本地 0 点) */
function parseKey(key) {
  const p = String(key || '').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function today() { return dayKey(new Date()); }

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/* to - from,单位天 */
function diffDays(fromKey, toKey) {
  const a = parseKey(fromKey), b = parseKey(toKey);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/* 本周一 */
function mondayOf(date) {
  const d = date || new Date();
  const day = d.getDay();                    /* 0 = 周日 */
  const offset = day === 0 ? 6 : day - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function weekdayCn(key) {
  return WEEK_CN[parseKey(key).getDay()];
}

/* '2026-09-22' → '9月22日' */
function monthDayText(key) {
  if (!key || key.length < 10) return key || '';
  return Number(key.slice(5, 7)) + '月' + Number(key.slice(8, 10)) + '日';
}

/* 相对今天的说法,用于日志列表 */
function relativeText(key) {
  if (!key) return '';
  const t = today();
  const d = diffDays(key, t);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d === 2) return '前天';
  if (d > 0 && d < 7) return d + ' 天前';
  return monthDayText(key);
}

/**
 * 生成一排日期(以 center 为中心,前后各 span 天)
 * 首页日历横排用
 */
function buildDateStrip(centerKey, span) {
  const n = (typeof span === 'number') ? span : 3;
  const out = [];
  const t = today();
  for (let i = -n; i <= n; i++) {
    const k = addDays(centerKey, i);
    out.push({
      key: k,
      day: Number(k.slice(8, 10)),
      month: Number(k.slice(5, 7)),
      weekday: weekdayCn(k),
      isToday: k === t,
      isCenter: i === 0,
      /* 周末标记,用于弱化/强调 */
      isWeekend: (function () {
        const w = parseKey(k).getDay();
        return w === 0 || w === 6;
      })()
    });
  }
  return out;
}

/**
 * 最近 n 天的 key 列表(含今天),升序。统计页横轴用
 */
function recentDays(n, endKey) {
  const end = endKey || today();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

module.exports = {
  pad2, dayKey, parseKey, today, addDays, diffDays,
  mondayOf, weekdayCn, monthDayText, relativeText,
  buildDateStrip, recentDays, WEEK_CN
};
