/* 勋章判定引擎

   ★ 设计要点(R5,2026-09-22 yang 拍板)
     勋章条件靠 tasks.medalTag 这个显式标签挂钩,不靠任务名模糊匹配。
     理由:家长随时可能把「每日阅读20分钟」改成「睡前阅读」,
     按名字匹配一改名就失效,而且会给家长一个"改了名字勋章就没了"的惊吓。

     medalTag 白名单: earlyrise | homework | reading | emotion | sleep | nap

   ★ 五种判定类型的语义
     checkinStreak  连续 N 天有打卡动作(≥1 条 done)
     tagCount       累计 N 天命中指定 tag
     tagStreak      ★ 连续 N 天每天同时命中 tags 里的全部 tag(自律小达人)
     absence        连续 N 天没有该 tag 的**扣分**记录(情绪小勇士)
     (还有 medalTag 为空的任务不参与任何判定)

   ★ 一旦解锁就永久保留
     判定是"累计/连续"性质的,今天满足不代表明天还满足。
     所以解锁的瞬间要落库成一条不可逆的记录(medal_records),
     之后不再重算 —— 否则孩子会因为某天断签而"失去"已得的勋章,
     这是最伤人的设计。 */

const { MEDALS, KIND, STREAK_ALLOW_BREAK } = require('./constants');
const S = require('./streak');

/**
 * 把打卡记录整理成勋章判定需要的两张索引表。
 * @param {Array} checkins 该孩子的全部 checkins(status='done' 的才算有效)
 * @returns {{activeDays:string[], tagsByDay:Object, badTagsByDay:Object}}
 */
function buildIndex(checkins) {
  const activeSet = new Set();       /* 有打卡动作的日子 */
  const tagsByDay = {};              /* 日期 → [medalTag]  仅加分任务的 done */
  const badTagsByDay = {};           /* 日期 → [medalTag]  仅扣分任务的 done */

  (checkins || []).forEach(function (c) {
    if (c.status !== 'done') return;             /* undone 的不算 */
    const d = c.date;
    if (!d) return;
    activeSet.add(d);

    const tag = c.medalTag;
    if (!tag) return;

    /* 用快照 score 判断方向:>0 是"做到了好事",<0 是"犯了错" */
    const isBad = Number(c.score) < 0;
    const bucket = isBad ? badTagsByDay : tagsByDay;
    if (!bucket[d]) bucket[d] = [];
    if (bucket[d].indexOf(tag) < 0) bucket[d].push(tag);
  });

  return {
    activeDays: Array.from(activeSet).sort(),
    tagsByDay: tagsByDay,
    badTagsByDay: badTagsByDay
  };
}

/**
 * 计算所有勋章的当前进度。
 * @param {Array} checkins 全部打卡记录
 * @param {string} today  YYYY-MM-DD
 * @param {Object} earned 已解锁的 { medalKey: true }(由 medal_records 得来)
 * @returns {Array} [{ key,name,icon,desc, unlocked, progress, target, progressText }]
 */
function evaluate(checkins, today, earned) {
  const idx = buildIndex(checkins);
  const got = earned || {};

  return MEDALS.map(function (m) {
    const already = !!got[m.key];
    let progress = 0;

    if (m.type === 'checkinStreak') {
      progress = S.streakOf(idx.activeDays, today, m.allowBreak).current;

    } else if (m.type === 'tagCount') {
      /* 累计"天数"而不是"次数":一天勾两次同名任务不该算两天 */
      progress = Object.keys(idx.tagsByDay).filter(function (d) {
        return idx.tagsByDay[d].indexOf(m.tag) >= 0;
      }).length;

    } else if (m.type === 'tagStreak') {
      progress = S.tagStreak(idx.tagsByDay, m.tags, today, m.allowBreak).current;

    } else if (m.type === 'absence') {
      progress = S.absenceStreak(
        idx.badTagsByDay, m.tag, today, idx.activeDays, m.allowBreak
      ).current;
    }

    /* 已解锁的进度直接显示为"已达成",不显示可能已经跌回去的实时值 */
    const reached = already || progress >= m.threshold;
    const shown = already ? m.threshold : Math.min(progress, m.threshold);

    return {
      key: m.key,
      name: m.name,
      icon: m.icon,
      desc: m.desc,
      type: m.type,
      unlocked: reached,
      progress: shown,
      target: m.threshold,
      progressText: already
        ? '已获得'
        : (shown === 0 ? '还没开始' : (m.type === 'tagCount' ? '累计 ' + shown + '/' + m.threshold + ' 天'
                                                           : '连续 ' + shown + '/' + m.threshold + ' 天')),
      /* 进度百分比,列表里画进度条用 */
      percent: m.threshold > 0 ? Math.min(100, Math.round(shown / m.threshold * 100)) : 0
    };
  });
}

/**
 * 找出这一轮**新解锁**的勋章 key 列表。
 */
function newlyUnlocked(checkins, today, earned) {
  const all = evaluate(checkins, today, earned);
  return all.filter(function (m) { return m.unlocked && !(earned || {})[m.key]; })
            .map(function (m) { return m.key; });
}

module.exports = { evaluate, newlyUnlocked, buildIndex };
