/* 云函数 · initChild —— 创建/更新孩子,并首次播种预设任务与奖励

   ★ 按文字原型稿重构(2026-09-22)。新增:
     1) grade 年级字段(原型稿页面7)
     2) penaltyLimit 单日扣分上限(R4,默认 15,范围 1-30)
     3) 首次创建时播种 18 条预设任务(原型稿给的 8+7 条 + R6 新增 3 条)
        与 7 条预设奖励
     4) 双积分初始化(都从 0 开始)

   ★ 播种为什么要幂等
     用户可能在弱网下手抖点两次"开始"。如果每次调用都播种,
     就会得到两套一模一样的任务。用确定性 _id(`preset_<childId>_<序号>`)
     保证同一条预设任务永远只写一次。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const C = require('./_shared/constants');

const COLL = {
  children: 'children',
  tasks: 'tasks',
  rewards: 'rewards'
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { nickname, grade, avatar, penaltyLimit, seedPresets } = event || {};

  const name = String(nickname || '').trim().slice(0, 12);
  if (!name) {
    return { ok: false, code: 'INVALID', message: '请先给孩子起个昵称。' };
  }

  /* 上限合法性(R4:1-30) */
  let limit = Number(penaltyLimit);
  if (!isFinite(limit) || limit < C.PENALTY_LIMIT.min || limit > C.PENALTY_LIMIT.max) {
    limit = C.PENALTY_LIMIT.def;
  }

  const gr = String(grade || '').trim().slice(0, 8);
  const now = new Date();

  try {
    const existRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const exist = existRes.data[0] || null;

    /* ---------- 已存在 → 只更新资料,不动积分 ---------- */
    if (exist) {
      const patch = { nickname: name, updatedAt: now };
      if (gr) patch.grade = gr;
      if (avatar !== undefined) patch.avatar = avatar;
      if (penaltyLimit !== undefined) patch.penaltyLimit = limit;

      await db.collection(COLL.children).doc(exist._id).update({ data: patch });
      return {
        ok: true,
        created: false,
        childId: exist._id,
        child: Object.assign({}, exist, patch),
        message: '资料已更新。'
      };
    }

    /* ---------- 新建 ---------- */
    const childDoc = {
      _openid: OPENID,
      nickname: name,
      grade: gr || '',
      avatar: avatar || '',
      /* ★ 双积分,都从 0 开始(R1) */
      availablePoints: 0,
      lifetimePoints: 0,
      /* 单日扣分上限 */
      penaltyLimit: limit,
      /* 家长 PIN 尚未设置 —— 前端据此引导家长去设置 */
      parentPin: null,
      active: true,
      createdAt: now,
      updatedAt: now
    };

    const addRes = await db.collection(COLL.children).add({ data: childDoc });
    const childId = addRes._id;

    /* ---------- 播种预设任务与奖励(可关) ---------- */
    let taskCount = 0, rewardCount = 0;
    if (seedPresets !== false) {
      taskCount = await seedTasks(OPENID, childId, now);
      rewardCount = await seedRewards(OPENID, childId, now);
    }

    return {
      ok: true,
      created: true,
      childId: childId,
      child: Object.assign({}, childDoc, { _id: childId }),
      seeded: { tasks: taskCount, rewards: rewardCount },
      message: '开始啦!已为你准备好 ' + taskCount + ' 项默认行为规则。'
    };

  } catch (err) {
    console.error('[initChild] failed', err);
    return { ok: false, code: 'INIT_FAILED', message: '创建失败,请重试。' };
  }
};

/**
 * 播种预设任务。确定性 _id ⇒ 重复调用不会产生重复任务。
 * ★ 幂等策略:先一次性查出已存在的 preset 任务,再只补缺失的。
 *   逐条 set 也能保证唯一,但会产生 N 次写请求;批量查一次更省。
 */
async function seedTasks(openid, childId, now) {
  const existingRes = await db.collection(COLL.tasks)
    .where({ _openid: openid, childId: childId, preset: true })
    .field({ name: true })
    .limit(100)
    .get();

  const have = {};
  (existingRes.data || []).forEach(function (t) { have[t.name] = true; });

  const todo = C.PRESET_TASKS.filter(function (t) { return !have[t.name]; });
  if (!todo.length) return 0;

  let n = 0;
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    const score = Number(t.score) || 0;
    const id = childId + '_preset_task_' + i;
    try {
      await db.collection(COLL.tasks).doc(id).set({
        data: {
          _openid: openid,
          childId: childId,
          name: t.name,
          icon: '',
          score: score,
          category: t.category || '',
          /* ★ 勋章判定靠这个标签,不靠任务名(R5) */
          medalTag: t.medalTag || '',
          /* 预设项系统自带:家长可开关可改分,但不能删 */
          preset: true,
          checkType: 'manual',
          active: true,
          sortOrder: score > 0 ? (100 + i) : (500 + i),
          createdAt: now,
          updatedAt: now
        }
      });
      n++;
    } catch (e) {
      console.error('[initChild] seed task failed', t.name, e);
    }
  }
  return n;
}

async function seedRewards(openid, childId, now) {
  const existingRes = await db.collection(COLL.rewards)
    .where({ _openid: openid, childId: childId, preset: true })
    .field({ name: true })
    .limit(100)
    .get();

  const have = {};
  (existingRes.data || []).forEach(function (r) { have[r.name] = true; });

  const todo = C.PRESET_REWARDS.filter(function (r) { return !have[r.name]; });
  if (!todo.length) return 0;

  let n = 0;
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    const id = childId + '_preset_reward_' + i;
    try {
      await db.collection(COLL.rewards).doc(id).set({
        data: {
          _openid: openid,
          childId: childId,
          name: r.name,
          icon: r.icon || '',
          cost: Number(r.cost) || 0,
          tier: r.tier || 'small',
          stock: -1,             /* -1 = 不限量 */
          preset: true,
          active: true,
          sortOrder: 100 + i,
          createdAt: now,
          updatedAt: now
        }
      });
      n++;
    } catch (e) {
      console.error('[initChild] seed reward failed', r.name, e);
    }
  }
  return n;
}
