/* 连续打卡与勋章判定

   ★ 连续打卡口径(R10,2026-09-22 yang 拍板)
     「允许断签 1 次,第 2 次断签从头计算」

     注意这不是「扣掉一天再继续」,而是:
       断第 1 次 → 链条继续,但断签额度用掉,以后不能再断
       断第 2 次 → 从断的那天之后重新从 0 开始数

     例(allowBreak=1):
       9/1 9/2 [9/3 缺] 9/4 9/5 [9/6 缺] 9/7
       → 已用 1 次额度,9/6 是第二次断,链条从 9/7 重新开始,currentStreak = 1

   ★ 为什么不用「总天数 - 断签数」
     那样会得到一个虚高的连续天数:断在很前面和断在昨天,结果一样,
     但两者对孩子的心智含义完全不同。勋章要反映"最近的状态"。

   ★ 只按「有打卡动作」算,不按「得分为正」算
     孩子今天只犯了错、被扣了分,但他确实完成了打卡流程 ——
     这不该算断签。断签只惩罚"忘了做这件事",不惩罚"今天表现不好"。 */

const { STREAK_ALLOW_BREAK } = require('./constants');

/* 日期工具:本地时区手工拼接,禁止 toISOString()(UTC+8 早 8 点前会算成昨天) */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dayKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function parseKey(key) {
  const p = String(key).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

function diffDays(fromKey, toKey) {
  const a = parseKey(fromKey), b = parseKey(toKey);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * 计算「截至 today 的当前连续天数」。
 * @param {Set<string>|Array<string>} activeDays 有记录的日期集合(YYYY-MM-DD)
 * @param {string} today  今天(YYYY-MM-DD)
 * @param {number} [allowBreak] 允许断签次数,默认取常量
 * @returns {{current:number, usedBreaks:number, longest:number}}
 */
function streakOf(activeDays, today, allowBreak) {
  const set = activeDays instanceof Set ? activeDays : new Set(activeDays || []);
  const maxBreak = (typeof allowBreak === 'number') ? allowBreak : STREAK_ALLOW_BREAK;

  if (set.size === 0) return { current: 0, usedBreaks: 0, longest: 0 };

  /* 从最早的一天开始正向扫描,才能正确统计「断了几次」 */
  const keys = Array.from(set).sort();
  const start = keys[0];

  let current = 0;
  let usedBreaks = 0;
  let longest = 0;
  let best = 0;

  /* 最多扫 3660 天(10 年),防止脏数据把循环拖死 */
  const span = diffDays(start, today);
  const end = Math.min(Math.max(span, 0), 3660);

  for (let i = 0; i <= end; i++) {
    const k = addDays(start, i);
    if (set.has(k)) {
      current += 1;
      if (current > best) best = current;
      continue;
    }
    /* 今天是"还没打卡"不算断签 —— 一天还没过完,不能怪孩子 */
    if (k === today) break;

    if (usedBreaks < maxBreak) {
      usedBreaks += 1;      /* 断签额度还有,链条不断,天数也不加 */
    } else {
      /* 额度用完了,再断就从 0 重来 */
      if (best > longest) longest = best;
      current = 0;
    }
  }
  if (best > longest) longest = best;

  return { current: current, usedBreaks: usedBreaks, longest: longest };
}

/**
 * 「连续 N 天每天都满足条件」—— 用于自律小达人(tagStreak)
 * 与 streakOf 的区别:这不是"打卡了就算",而是当天必须**命中指定任务**。
 * @param {Object} daysByTag  { 'YYYY-MM-DD': Set<medalTag> } 每天完成了哪些 tag
 * @param {Array<string>} tags 需要全部命中的 tag 列表
 */
function tagStreak(daysByTag, tags, today, allowBreak) {
  const need = Array.isArray(tags) ? tags : [tags];
  const okDays = Object.keys(daysByTag || {}).filter(function (k) {
    const s = daysByTag[k];
    /* Set / Array 都兼容 */
    const has = function (t) { return s instanceof Set ? s.has(t) : (s || []).indexOf(t) >= 0; };
    return need.every(has);
  });
  return streakOf(okDays, today, allowBreak);
}

/**
 * 「连续 N 天都没有某类扣分记录」—— 用于情绪小勇士(absence)
 * @param {Object} daysByTag 只含**扣分**方向的 tag
 */
function absenceStreak(daysByTag, tag, today, allDays, allowBreak) {
  /* 有扣分记录的日子 = 链条上的"洞" */
  const badDays = new Set();
  Object.keys(daysByTag || {}).forEach(function (k) {
    const s = daysByTag[k];
    const has = function (t) { return s instanceof Set ? s.has(t) : (s || []).indexOf(t) >= 0; };
    if (has(tag)) badDays.add(k);
  });

  /* 从第一次打卡那天到今天,把"没犯错的日子"当作有效日 */
  const days = (allDays && allDays.length) ? allDays.slice().sort() : [];
  if (!days.length) return { current: 0, usedBreaks: 0, longest: 0 };
  const start = days[0];
  const good = [];
  const end = Math.min(Math.max(diffDays(start, today), 0), 3660);
  for (let i = 0; i <= end; i++) {
    const k = addDays(start, i);
    if (!badDays.has(k)) good.push(k);
  }
  return streakOf(good, today, allowBreak);
}

module.exports = { dayKey, parseKey, addDays, diffDays, streakOf, tagStreak, absenceStreak };
