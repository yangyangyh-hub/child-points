/* 云函数 · taskToggle —— 勾选 / 取消勾选任务(唯一改分入口之一)

   ★ 按文字原型稿重构(2026-09-22)。变化点:
     1) 双积分:加分才涨 lifetimePoints,扣分只减 availablePoints(见 _shared/ledger.js)
     2) 单日扣分上限保护(原型稿页面1「单日扣分上限保护」)
     3) 打卡记录增加 medalTag 快照,供勋章判定
     4) 返回勋章新解锁项,前端可弹祝贺

   为什么必须由云函数做:
   1) 小程序前端可被反编译,积分是家长账本,不能让孩子端篡改;
   2) 勾选是"加分/取消是扣分"的双向操作,要保证 checkin 与流水原子一致;
   3) 同一天同一任务只能有一条记录,去重必须在服务端做。

   核心设计:确定性 _id = `${childId}_${taskId}_${date}`
   云数据库没有 unique 索引。若用"先查后写"去重,并发下两次请求都查不到、
   都写入 -> 产生两条记录 -> 重复加分,且这种脏数据极难排查。
   用确定性 _id 后,第二次写入直接抛冲突,把静默错误变成显式错误。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const { KIND, REASON, ERR, ERR_MSG } = require('./_shared/constants');
const ledger = require('./_shared/ledger');
const medal = require('./_shared/medal');
const pin = require('./_shared/pin');
const S = require('./_shared/streak');

/**
 * 家长密码校验(与 achievement / setPin 同一套规矩)。
 * ★ 没设过密码时放行 —— 否则新用户连"突破上限"都用不了。
 * ★ 返回 v(verifyPin 的原始结果),调用方统一写 `_.set(chk.v.parentPin)`,
 *   这样"写库"只剩一种形状,静态断言也只需认一种写法。
 */
function checkPin(child, inputPin) {
  if (!pin.pinUsable(child)) return { ok: true, v: null };

  const v = pin.verifyPin(child, inputPin);
  if (v.ok) return { ok: true, v: v };

  const msg = v.code === 'PIN_LOCKED'
    ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
    : (v.code === 'PIN_REQUIRED' ? '突破扣分上限需要家长密码。' : '家长密码不对。');
  return { ok: false, code: v.code, message: msg, v: v };
}

const COLL = {
  children: 'children',
  tasks: 'tasks',
  checkins: 'checkins',
  records: 'point_records',
  medals: 'medal_records'
};

function fail(code, msg) {
  return { ok: false, code: code, message: msg || ERR_MSG[code] || '操作失败' };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId, taskId, date, done, allowOverLimit } = event || {};

  /* ---------- 参数校验:宁可显式报错,不要静默写坏数据 ---------- */
  if (!childId || !taskId || !date) {
    return fail(ERR.INVALID, '参数不完整(childId / taskId / date 必填)。');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail(ERR.INVALID, '日期格式必须是 YYYY-MM-DD。');
  }
  const wantDone = done === true || done === 'true';

  /* ---------- 读任务(校验归属 + 拿分值快照) ---------- */
  let task;
  try {
    const res = await db.collection(COLL.tasks).doc(taskId).get();
    task = res.data;
  } catch (e) {
    return fail(ERR.NOT_FOUND, '任务不存在或已删除。');
  }
  if (task._openid !== OPENID) return fail(ERR.FORBIDDEN, '无权操作该任务。');
  if (task.childId && task.childId !== childId) return fail(ERR.FORBIDDEN, '该任务不属于当前孩子。');

  const score = Number(task.score) || 0;
  if (score === 0) return fail(ERR.INVALID, '该任务分值为 0,不产生积分变动。');

  const kind = ledger.taskKindOf(score);          /* bonus | penalty */
  const checkinId = `${childId}_${taskId}_${date}`;
  const now = new Date();

  /* ---------- 读现有打卡记录,判断是"新增"还是"翻转" ---------- */
  let existing = null;
  try {
    const res = await db.collection(COLL.checkins).doc(checkinId).get();
    existing = res.data;
  } catch (e) {
    existing = null;          /* 不存在是正常路径,不是错误 */
  }
  if (existing && existing._openid !== OPENID) return fail(ERR.FORBIDDEN, '无权操作该记录。');

  const wasDone = !!(existing && existing.status === 'done');
  if (wasDone === wantDone) {
    return {
      ok: true, changed: false,
      message: wantDone ? '这项已经打勾了。' : '这项本来就没打勾。'
    };
  }

  /* ---------- ★ 单日扣分上限保护(原型稿页面1) ----------
     口径:当日 penalty 类变动的**绝对值之和** ≤ 家长设定的上限。
     取消勾选(把分还回去)不占额度,所以只在"要打勾一个扣分任务"时检查。 */
  if (kind === KIND.PENALTY && wantDone) {

    /* ★★ 家长在弹窗里选「仍要扣分」时,必须验密码(2026-09-24 补)
       以前这里写成 `&& !allowOverLimit` —— 只要带上 allowOverLimit 就直接跳过额度检查,
       **而且完全不验身份**。等于"前端说自己是家长,那就是家长",
       而前端代码跑在别人的手机上,这不叫隔离(本项目反复强调:
       真正的边界必须在服务端)。现在:没设过密码 → 放行;设过 → 必须传。 */
    if (allowOverLimit) {
      const childDoc = await db.collection(COLL.children).doc(childId).get();
      const chk = checkPin(childDoc.data, event.pin);
      if (chk.v && chk.v.parentPin) {
        await db.collection(COLL.children).doc(childId)
          /* ★ 必须 _.set():云开发传裸对象是**按子字段合并**,parentPin 为 null 时会报错
             —— 详见 setPin/index.js 的说明(2026-09-23 官方文档确认) */
          .update({ data: { parentPin: _.set(chk.v.parentPin) } });
      }
      if (!chk.ok) return fail(chk.code, chk.message);
      /* 通过 → 不再检查额度,往下正常扣分 */
    } else {
      const childRes0 = await db.collection(COLL.children).doc(childId).get();
      const limit = Number(childRes0.data.penaltyLimit);

      const todayRes = await db.collection(COLL.records)
        .where({ _openid: OPENID, childId: childId, date: date })
        .field({ kind: true, change: true, refKind: true })
        .limit(200)
        .get();

      const remain = ledger.remainingPenaltyBudget(todayRes.data || [],
        (isFinite(limit) && limit > 0) ? limit : 15);

      if (remain < Math.abs(score)) {
        return {
          ok: false,
          code: ERR.PENALTY_LIMIT,
          message: '今天最多还能扣 ' + remain + ' 分,这项要扣 ' + Math.abs(score) +
                   ' 分。今天的扣分够了,先到这里吧。',
          remain: remain,
          need: Math.abs(score),
          limit: (isFinite(limit) && limit > 0) ? limit : 15,
          /* 前端据此决定是否给出"家长可手动突破"的入口 */
          canOverLimit: true
        };
      }
    }
  }

  /* ---------- 积分增量拆分(双积分,R1/R2) ----------
     ★ 关键:score 本身带符号(扣分任务为负数)
     打勾   -> 方向为正,按 kind 决定涨哪个余额
     取消勾 -> 方向为反,即"冲正上一次的影响"
     手写 if (done) delta = Math.abs(score) 会立刻出错。 */
  const magnitude = Math.abs(score);
  const direction = wantDone ? 1 : -1;

  /* 当方向为负时,语义是撤销,要按原来那个 kind 反向 */
  const effKind = (direction > 0) ? kind : KIND.REVOKE;
  const effRefKind = (direction > 0) ? null : kind;
  const d = ledger.splitDelta(effKind, magnitude, effRefKind);
  const delta = d.dAvailable;                    /* 流水里记的 change(可用积分口径) */

  /* ---------- 事务:打卡 + 流水 + 双余额 + 勋章 一起变,或都不变 ---------- */
  let txResult;
  try {
    txResult = await db.runTransaction(async (transaction) => {
      /* 1) 读孩子当前双余额(必须在事务内读,否则并发下会算错) */
      const childRes = await transaction.collection(COLL.children).doc(childId).get();
      const child = childRes.data;
      if (child._openid !== OPENID) throw new Error(ERR.FORBIDDEN);

      const availBefore = Number(child.availablePoints) || 0;
      const lifeBefore = Number(child.lifetimePoints) || 0;
      const availAfter = availBefore + d.dAvailable;
      const lifeAfter = Math.max(0, lifeBefore + d.dLifetime);   /* 只增不减,兜底不为负 */

      /* 2) 写打卡记录(确定性 _id;存在则 update,不存在则 set) */
      const base = {
        _openid: OPENID,
        childId: childId,
        taskId: taskId,
        /* 快照:任务日后改名/改分/改标签,历史记录不能被追溯改写 */
        taskName: task.name || '',
        score: score,
        category: task.category || '',
        medalTag: task.medalTag || '',
        date: date,
        status: wantDone ? 'done' : 'undone',
        source: 'task',
        operatorOpenid: OPENID,
        updatedAt: now
      };
      if (existing) {
        await transaction.collection(COLL.checkins).doc(checkinId).update({
          data: {
            status: base.status,
            /* 快照以"当时勾选时"的值为准:取消再勾,取最新任务定义 */
            taskName: base.taskName,
            score: base.score,
            category: base.category,
            medalTag: base.medalTag,
            updatedAt: now
          }
        });
      } else {
        await transaction.collection(COLL.checkins).doc(checkinId).set({
          data: Object.assign({ createdAt: now }, base)
        });
      }

      /* 3) 追加积分流水(只增不改) */
      await transaction.collection(COLL.records).add({
        data: {
          _openid: OPENID,
          childId: childId,
          change: delta,
          kind: effKind,
          refKind: effRefKind,
          date: date,
          availAfter: availAfter,
          lifeAfter: lifeAfter,
          reason: REASON.CHECKIN,
          refId: checkinId,
          refName: task.name || '',
          operatorOpenid: OPENID,
          createdAt: now
        }
      });

      /* 4) 更新 children 上的双余额冗余 */
      await transaction.collection(COLL.children).doc(childId).update({
        data: {
          availablePoints: availAfter,
          lifetimePoints: lifeAfter,
          updatedAt: now
        }
      });

      return { availAfter: availAfter, lifeAfter: lifeAfter };
    });
  } catch (err) {
    if (err && err.message === ERR.FORBIDDEN) return fail(ERR.FORBIDDEN);
    console.error('[taskToggle] transaction failed', err);
    return fail('TX_FAILED', '保存失败,积分未变动,请重试。');
  }

  /* ---------- 勋章重新判定并落库(事务外做) ----------
     为什么放事务外:勋章判定要读全部打卡记录,放在事务里会显著拖长
     事务持有的时间(云开发事务有时限)。勋章晚几秒解锁是可接受的。 */
  let newMedals = [];
  try {
    newMedals = await refreshMedals(OPENID, childId, date);
  } catch (e) {
    console.error('[taskToggle] medal refresh failed(不影响积分)', e);
  }

  return {
    ok: true,
    changed: true,
    delta: delta,
    kind: kind,
    availablePoints: txResult.availAfter,
    lifetimePoints: txResult.lifeAfter,
    newMedals: newMedals,
    message: (delta > 0 ? '加 ' : '扣 ') + Math.abs(delta) + ' 分。'
  };
};

/**
 * 重新算一遍勋章,把新解锁的落库。
 * 已解锁的永久保留 —— 所以只做"新增",从不删除 medal_records。
 */
async function refreshMedals(openid, childId, today) {
  const [checkinRes, earnedRes] = await Promise.all([
    db.collection(COLL.checkins)
      .where({ _openid: openid, childId: childId, status: 'done' })
      .field({ date: true, medalTag: true, score: true, status: true })
      .limit(2000)
      .get(),
    db.collection(COLL.medals)
      .where({ _openid: openid, childId: childId })
      .field({ medalKey: true })
      .limit(50)
      .get()
  ]);

  const earned = {};
  (earnedRes.data || []).forEach(function (m) { earned[m.medalKey] = true; });

  const fresh = medal.newlyUnlocked(checkinRes.data || [], today, earned);
  if (!fresh.length) return [];

  const all = medal.evaluate(checkinRes.data || [], today, earned);
  const now = new Date();
  const written = [];

  for (let i = 0; i < fresh.length; i++) {
    const key = fresh[i];
    const meta = all.filter(function (m) { return m.key === key; })[0];
    /* 用确定性 _id 防止并发下重复写入同一枚勋章 */
    const mid = childId + '_' + key;
    try {
      await db.collection(COLL.medals).doc(mid).set({
        data: {
          _openid: openid,
          childId: childId,
          medalKey: key,
          medalName: meta ? meta.name : key,
          icon: meta ? meta.icon : '',
          unlockedAt: now,
          unlockedDate: today
        }
      });
      written.push({ key: key, name: meta ? meta.name : key, icon: meta ? meta.icon : '' });
    } catch (e) {
      /* 已存在(并发下另一个请求先写了)—— 不算错误 */
      console.log('[taskToggle] medal already exists', mid);
    }
  }
  return written;
}
