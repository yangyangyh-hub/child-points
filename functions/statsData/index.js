/* 云函数 · statsData —— 成长数据统计(原型稿页面5)

   ★ 按文字原型稿实现。三个交付物:
     1) 每日得分趋势(7 日,给前端自绘 canvas 折线图)
     2) 高频加分 TOP3 / 高频扣分 TOP3
     3) 每周成长总结(模板拼装,见 _shared/report.js)

   ★ 为什么全部在服务端聚合
     流水可能上千条。全拉到前端算,单次 setData 载荷会远超 64KB 的舒适区,
     且首次打开会明显卡。云函数的 aggregate 是数据库侧计算,只回结果。

   ★ 口径说明(容易混,先写清楚)
     「得分趋势」用 point_records 按天 sum,不是用 checkins 计数 ——
     因为家长手动加减分不产生 checkin,只用 checkins 会漏掉这块。
     「完成率」用 checkins 的 done 条数 / 当日可勾选任务数。
     两者是不同来源,数字不必能对上。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const R = require('./_shared/report');
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  tasks: 'tasks',
  checkins: 'checkins',
  records: 'point_records'
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId, range, mode, anchorDate } = event || {};
  const isChildMode = mode === 'child';

  /* range: week(近 7 天) | month(近 30 天)
     ★ 孩子模式一律只给 week,且不给扣分维度 */
  const days = (range === 'month' && !isChildMode) ? 30 : 7;

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: true, empty: true, needInit: true };

    const cid = childId || child._id;

    /* 以 anchorDate(或今天)为最后一天,倒推 days 天 */
    const today = (/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) ? anchorDate : S.dayKey(new Date());
    const startKey = S.addDays(today, -(days - 1));

    /* 本周 / 上周(周报对比用,固定 7 天) */
    const lastWeekEnd = S.addDays(startKey, -1);
    const lastWeekStart = S.addDays(lastWeekEnd, -6);

    /* ---------- 并行取数 ---------- */
    const [recRes, ckRes, lastRecRes, taskRes] = await Promise.all([
      /* 本期流水(要 kind/change/date/refName/category 全拿来做聚合) */
      db.collection(COLL.records)
        .where({ _openid: OPENID, childId: cid, date: _.gte(startKey).and(_.lte(today)) })
        .field({ date: true, kind: true, change: true, refKind: true, refName: true })
        .limit(1000).get(),

      /* 本期打卡记录(算完成率 + 按任务统计天数) */
      db.collection(COLL.checkins)
        .where({ _openid: OPENID, childId: cid, date: _.gte(startKey).and(_.lte(today)), status: 'done' })
        .field({ date: true, taskId: true, taskName: true, score: true, category: true, status: true })
        .limit(1000).get(),

      /* 上周流水(周报环比) */
      db.collection(COLL.records)
        .where({ _openid: OPENID, childId: cid, date: _.gte(lastWeekStart).and(_.lte(lastWeekEnd)) })
        .field({ date: true, kind: true, change: true, refKind: true, refName: true })
        .limit(1000).get(),

      /* 当前有效任务数(算完成率的分母) */
      db.collection(COLL.tasks)
        .where({ _openid: OPENID, childId: cid, active: true })
        .field({ score: true }).limit(100).get()
    ]);

    const recs = recRes.data || [];
    const cks  = ckRes.data || [];
    const lastRecs = lastRecRes.data || [];
    const tasks = taskRes.data || [];

    /* ---------- 1. 每日趋势 ---------- */
    const trend = [];
    for (let i = 0; i < days; i++) {
      const d = S.addDays(startKey, i);
      let bonus = 0, penalty = 0;
      recs.forEach(function (r) {
        if (r.date !== d) return;
        const v = Math.abs(Number(r.change) || 0);
        if (r.kind === 'bonus') bonus += v;
        else if (r.kind === 'penalty') penalty += v;
        else if (r.kind === 'revoke') {
          if (r.refKind === 'bonus') bonus -= v;
          else if (r.refKind === 'penalty') penalty -= v;
        }
      });
      bonus = Math.max(0, bonus);
      penalty = Math.max(0, penalty);
      trend.push({
        date: d,
        label: Number(d.slice(8, 10)) + '日',
        bonus: bonus,
        penalty: isChildMode ? null : penalty,
        /* 孩子模式:净得分 = 加分(不体现扣分) */
        net: isChildMode ? bonus : (bonus - penalty),
        count: cks.filter(function (c) { return c.date === d; }).length
      });
    }

    /* ---------- 2. 高频加分 / 扣分 TOP3 ---------- */
    const byName = {};
    function bump(name, category, score, dateKey) {
      if (!name) return;
      if (!byName[name]) byName[name] = { name: name, category: category || '', score: score, days: {}, count: 0 };
      byName[name].days[dateKey] = true;
      byName[name].count += 1;
    }

    cks.forEach(function (c) {
      bump(c.taskName, c.category, Number(c.score) || 0, c.date);
    });

    const rows = Object.keys(byName).map(function (k) {
      const o = byName[k];
      o.dayCount = Object.keys(o.days).length;
      return o;
    });

    const topBonus = rows.filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.dayCount - a.dayCount || b.count - a.count; })
      .slice(0, 3)
      .map(function (r) {
        return { name: r.name, categoryLabel: C.CAT_LABEL[r.category] || '未分类',
                 days: r.dayCount, count: r.count, score: r.score };
      });

    const topPenaltyRaw = rows.filter(function (r) { return r.score < 0; })
      .sort(function (a, b) { return b.dayCount - a.dayCount || b.count - a.count; })
      .slice(0, 3)
      .map(function (r) {
        return { name: r.name, categoryLabel: C.CAT_LABEL[r.category] || '未分类',
                 days: r.dayCount, count: r.count, score: r.score };
      });

    /* ---------- 3. 完成率 ---------- */
    const activeTaskCount = tasks.length;
    const checkinDays = new Set(cks.map(function (c) { return c.date; })).size;
    /* 完成率 = 本期 done 条数 /(有效任务数 × 有记录的天数)
       ★ 不按"本期所有天"当分母 —— 那样一放假就暴跌,数据没意义 */
    const denom = activeTaskCount * Math.max(1, checkinDays);
    const completionRate = denom > 0 ? Math.round(cks.length / denom * 100) : 0;

    /* ---------- 4. 净得分合计 ---------- */
    let totalBonus = 0, totalPenalty = 0;
    recs.forEach(function (r) {
      const v = Math.abs(Number(r.change) || 0);
      if (r.kind === 'bonus') totalBonus += v;
      else if (r.kind === 'penalty') totalPenalty += v;
      else if (r.kind === 'revoke') {
        if (r.refKind === 'bonus') totalBonus -= v;
        else if (r.refKind === 'penalty') totalPenalty -= v;
      }
    });
    totalBonus = Math.max(0, totalBonus);
    totalPenalty = Math.max(0, totalPenalty);

    /* ---------- 5. 周报(模板拼装) ---------- */
    /* 本期 = 近 7 天;上周 = 更早的 7 天 */
    const thisWindow = windowStats(recs, 0);
    const lastWindow = windowStats(lastRecs, 0);

    let report = null;
    if (days === 7) {
      report = R.buildWeeklyReport({
        thisWeek: thisWindow.byTask,
        lastWeek: lastWindow.byTask,
        netPoints: thisWindow.net,
        bonusTotal: thisWindow.bonus,
        penaltyTotal: thisWindow.penalty,
        checkinDays: checkinDays,
        weekLabel: startKey + ' 至 ' + today
      });
      if (isChildMode) {
        /* 孩子模式:去掉"要注意的地方",只留正面内容 */
        report = {
          headline: report.headline,
          empty: report.empty,
          lines: report.lines.filter(function (l) { return l.kind !== 'watch'; })
        };
      }
    }

    /* ---------- 6. 失败态兜底 ---------- */
    const isEmpty = recs.length === 0 && cks.length === 0;

    return {
      ok: true,
      empty: isEmpty,
      range: days === 7 ? 'week' : 'month',
      startDate: startKey,
      endDate: today,
      trend: trend,

      /* ★ 折线图的 Y 轴范围由服务端给,前端不用自己算(避免两端算法不一致) */
      axis: buildAxis(trend),

      topBonus: topBonus,
      /* 孩子模式不返回扣分 TOP(原型稿 §四.3 双模式隔离) */
      topPenalty: isChildMode ? [] : topPenaltyRaw,

      completionRate: completionRate,
      checkinDays: checkinDays,
      activeTaskCount: activeTaskCount,
      totalCheckins: cks.length,

      totalBonus: totalBonus,
      totalPenalty: isChildMode ? null : totalPenalty,
      netPoints: isChildMode ? totalBonus : (totalBonus - totalPenalty),

      report: report,
      mode: isChildMode ? 'child' : 'parent'
    };

  } catch (err) {
    console.error('[statsData] failed', err);
    return { ok: false, code: 'LOAD_FAILED', message: '数据加载失败,请重试。' };
  }
};

/* 把一批流水按"任务名 → 天数"聚合,给周报做环比 */
function windowStats(recs, offsetDays) {
  const byTask = {};
  let bonus = 0, penalty = 0;

  (recs || []).forEach(function (r) {
    const v = Math.abs(Number(r.change) || 0);
    let effSign = 0;

    if (r.kind === 'bonus') { bonus += v; effSign = 1; }
    else if (r.kind === 'penalty') { penalty += v; effSign = -1; }
    else if (r.kind === 'revoke') {
      if (r.refKind === 'bonus') { bonus -= v; effSign = -1; }
      else if (r.refKind === 'penalty') { penalty -= v; effSign = 1; }
    }
    /* 兑换不参与任务维度统计 */
    if (effSign === 0 || !r.refName) return;

    const key = r.refName;
    if (!byTask[key]) byTask[key] = { days: 0, score: effSign > 0 ? v : -v, _dates: {} };
    if (r.date) byTask[key]._dates[r.date] = true;
  });

  Object.keys(byTask).forEach(function (k) {
    byTask[k].days = Object.keys(byTask[k]._dates).length;
    delete byTask[k]._dates;
  });

  return {
    byTask: byTask,
    bonus: Math.max(0, bonus),
    penalty: Math.max(0, penalty),
    net: Math.max(0, bonus) - Math.max(0, penalty)
  };
}

/* Y 轴范围:留出上下 20% 余量,并保证 0 在范围内 */
function buildAxis(trend) {
  let min = 0, max = 0;
  (trend || []).forEach(function (t) {
    const lo = Math.min(t.net, 0);
    const hi = Math.max(t.net, 0);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  });
  if (max === min) { max = 5; min = Math.min(0, min); }
  const span = max - min;
  const pad = Math.max(1, Math.ceil(span * 0.2));
  return {
    min: Math.floor(min - pad),
    max: Math.ceil(max + pad),
    zero: 0
  };
}
