/* 云函数 · homeData —— 首页数据聚合

   ★ 按文字原型稿重构(2026-09-22)。首页要展示的东西变多了:
     双积分卡 + 今日得分(加分/扣分/净得) + 连续打卡 + 两栏任务 + 上限余量

   为什么聚合而不是让前端发多次请求:
   小程序每次 wx.cloud.callFunction 都要一次网络往返。首页需要
   「孩子 + 任务 + 今日打卡 + 今日流水 + 勋章」五份数据,分五次调用在弱网下
   会明显变慢。一次拿全,前端只 setData 一次。

   ★ 双模式隔离(原型稿 §四.3)
     孩子模式下:不返回扣分任务、不返回扣分统计、不返回扣分流水,
     parentPin 一律剥离。**在服务端做,不靠前端隐藏** —— 否则改下前端代码就穿了。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const ledger = require('./_shared/ledger');
const medal = require('./_shared/medal');
const pin = require('./_shared/pin');
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  tasks: 'tasks',
  checkins: 'checkins',
  records: 'point_records',
  medals: 'medal_records',
  logs: 'logs'
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { date, mode, childOnly } = event || {};

  const isChildMode = mode === 'child';

  try {
    /* ---------- 1. 取孩子(单孩子模型,取第一条) ---------- */
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID })
      .limit(1)
      .get();

    const rawChild = childRes.data[0] || null;

    /* 轻量刷新(勾选后只更新积分数字,不重拉整页) */
    if (childOnly) {
      return {
        ok: true,
        child: rawChild ? pin.stripForChildMode(rawChild) : null,
        /* 余额也在 child 里,但单独给一份便于前端直接读 */
        availablePoints: rawChild ? (Number(rawChild.availablePoints) || 0) : 0,
        lifetimePoints: rawChild ? (Number(rawChild.lifetimePoints) || 0) : 0
      };
    }

    /* 没有孩子 = 首次使用,前端显示引导页 */
    if (!rawChild) {
      return { ok: true, child: null, tasks: [], needInit: true };
    }
    const child = pin.stripForChildMode(rawChild);

    /* ---------- 2. 并行取任务 / 今日打卡 / 今日流水 / 勋章 / 最近日志 ---------- */
    const [taskRes, checkinRes, todayRecRes, medalRes, logRes, allCheckinRes] =
      await Promise.all([
        db.collection(COLL.tasks)
          .where({ _openid: OPENID, childId: rawChild._id, active: true })
          .orderBy('sortOrder', 'asc')
          .orderBy('createdAt', 'asc')
          .limit(100)
          .get(),

        date ? db.collection(COLL.checkins)
          .where({ _openid: OPENID, childId: rawChild._id, date: date })
          .limit(200).get()
          : Promise.resolve({ data: [] }),

        date ? db.collection(COLL.records)
          .where({ _openid: OPENID, childId: rawChild._id, date: date })
          .field({ kind: true, change: true, refKind: true })
          .limit(200).get()
          : Promise.resolve({ data: [] }),

        db.collection(COLL.medals)
          .where({ _openid: OPENID, childId: rawChild._id })
          .limit(50).get(),

        db.collection(COLL.logs)
          .where({ _openid: OPENID, childId: rawChild._id })
          .orderBy('date', 'desc')
          .limit(3).get(),

        /* 连续打卡要算历史,但只需 date 字段 */
        db.collection(COLL.checkins)
          .where({ _openid: OPENID, childId: rawChild._id, status: 'done' })
          .field({ date: true, medalTag: true, score: true, status: true })
          .limit(2000).get()
      ]);

    /* ---------- 3. 组装任务(分两栏) ---------- */
    const doneMap = {};
    (checkinRes.data || []).forEach(function (c) {
      if (c.status === 'done') doneMap[c.taskId] = true;
    });

    const allTasks = (taskRes.data || []).map(function (t) {
      const score = Number(t.score) || 0;
      return {
        _id: t._id,
        name: t.name,
        icon: t.icon || '',
        score: score,
        category: t.category || '',
        categoryLabel: C.CAT_LABEL[t.category] || '未分类',
        medalTag: t.medalTag || '',
        preset: !!t.preset,
        isBonus: score > 0,
        done: !!doneMap[t._id]
      };
    });

    /* 孩子模式:把扣分任务整条剔除,不是隐藏而是根本不返回 */
    const visibleTasks = isChildMode
      ? allTasks.filter(function (t) { return t.isBonus; })
      : allTasks;

    const bonusTasks = visibleTasks.filter(function (t) { return t.isBonus; });
    const penaltyTasks = isChildMode ? [] : visibleTasks.filter(function (t) { return !t.isBonus; });

    /* ---------- 4. 今日得分 ---------- */
    const todayRecs = todayRecRes.data || [];
    let bonusTotal = 0, penaltyTotal = 0;
    todayRecs.forEach(function (r) {
      const v = Math.abs(Number(r.change) || 0);
      if (r.kind === 'bonus') bonusTotal += v;
      else if (r.kind === 'penalty') penaltyTotal += v;
      /* 冲正:把额度/合计还回去 */
      else if (r.kind === 'revoke') {
        if (r.refKind === 'bonus') bonusTotal -= v;
        else if (r.refKind === 'penalty') penaltyTotal -= v;
      }
    });
    bonusTotal = Math.max(0, bonusTotal);
    penaltyTotal = Math.max(0, penaltyTotal);

    const limit = Number(rawChild.penaltyLimit);
    const safeLimit = (isFinite(limit) && limit > 0) ? limit : C.PENALTY_LIMIT.def;
    const penaltyRemain = ledger.remainingPenaltyBudget(todayRecs, safeLimit);

    /* ---------- 5. 连续打卡(R10 口径) ---------- */
    const allCheckins = allCheckinRes.data || [];
    const activeDays = allCheckins.map(function (c) { return c.date; }).filter(Boolean);
    const streakInfo = S.streakOf(activeDays, date || S.dayKey(new Date()),
                                  C.STREAK_ALLOW_BREAK);

    /* ---------- 6. 勋章 ---------- */
    const earnedMap = {};
    const earnedList = (medalRes.data || []).map(function (m) {
      earnedMap[m.medalKey] = true;
      return { key: m.medalKey, name: m.medalName, icon: m.icon, unlockedDate: m.unlockedDate };
    });
    const medalProgress = medal.evaluate(allCheckins, date || S.dayKey(new Date()), earnedMap);
    const unlockedCount = medalProgress.filter(function (m) { return m.unlocked; }).length;

    /* ├ 情绪小勇士对孩子不可见(它本身就是"没犯错"的勋章,孩子模式不展示扣分维度) */
    const visibleMedals = isChildMode
      ? medalProgress.filter(function (m) { return m.type !== 'absence'; })
      : medalProgress;

    /* ---------- 7. 最近日志 ---------- */
    const logs = (logRes.data || []).map(function (g) {
      return {
        _id: g._id,
        date: g.date,
        text: g.text || '',
        netPoints: Number(g.netPoints) || 0
      };
    });

    /* ---------- 8. 返回 ---------- */
    return {
      ok: true,
      child: child,
      /* 双积分(R1):可用 = 能兑换的;累计 = 荣誉,只增不减 */
      availablePoints: Number(rawChild.availablePoints) || 0,
      lifetimePoints: Number(rawChild.lifetimePoints) || 0,
      /* ★ 用 pinUsable():必须 hash + salt 都在才算"设过密码"(2026-09-23)。
         前端拿它决定 pin 页是「输入密码」还是「设置密码」。
         只看 hash 的话,那条损坏记录(有 hash 无 salt)会让用户走进
         "输入密码 → 永远不对 → 锁定"的死循环 —— 且他自己没设过密码。
         详见 _shared/pin.js 里 pinUsable / PIN_BROKEN 的说明。 */
      hasPin: pin.pinUsable(rawChild),

      today: {
        date: date,
        bonusTotal: isChildMode ? bonusTotal : bonusTotal,   /* 加分孩子可以看 */
        penaltyTotal: isChildMode ? null : penaltyTotal,      /* 扣分对孩子不可见 */
        netPoints: isChildMode ? bonusTotal : (bonusTotal - penaltyTotal),
        /* 上限余量只在家长模式给 */
        penaltyLimit: isChildMode ? null : safeLimit,
        penaltyRemain: isChildMode ? null : penaltyRemain
      },

      bonusTasks: bonusTasks,
      penaltyTasks: penaltyTasks,
      taskCount: visibleTasks.length,

      streak: {
        current: streakInfo.current,
        longest: streakInfo.longest,
        usedBreaks: streakInfo.usedBreaks,
        allowBreak: C.STREAK_ALLOW_BREAK
      },

      medals: visibleMedals,
      medalEarned: earnedList,
      medalUnlockedCount: unlockedCount,
      medalTotal: C.MEDALS.length,

      /* ---------- 设置项(设置页要用,stripForChildMode 会把它们删掉) ---------- */
      settings: {
        nickname: rawChild.nickname || '',
        grade: rawChild.grade || '',
        avatar: rawChild.avatar || '',
        /* 扣分上限不给孩子看(和孩子模式不返回扣分数据是同一个理由) */
        penaltyLimit: isChildMode ? null : safeLimit,
        penaltyLimitMin: C.PENALTY_LIMIT.min,
        penaltyLimitMax: C.PENALTY_LIMIT.max,
        remindEnabled: !!(rawChild.remindEnabled),
        remindTime: rawChild.remindTime || '19:00'
      },

      logs: logs,

      columns: C.COLUMNS,
      categories: Object.keys(C.CAT_LABEL).map(function (k) {
        return { key: k, label: C.CAT_LABEL[k] };
      }),
      mode: isChildMode ? 'child' : 'parent'
    };

  } catch (err) {
    console.error('[homeData] failed', err);
    return { ok: false, code: 'LOAD_FAILED', message: '数据加载失败,请稍后重试。' };
  }
};
