/* 云函数 · adjustPoints —— 家长手动加分 / 扣分 / 犯错补救

   ★ 按文字原型稿重构(2026-09-22)。三种来源合并在一个函数里:
     reason='manual'  家长手动加/减分(原型稿页面1「支持手动补分/手动扣分(家长专属权限)」)
     reason='makeup'  犯错补救(原型稿 §四.1 核心独创机制)
     reason='revoke'  冲正一笔历史流水

   ★ 为什么补救也算加分而不是"抵扣扣分"
     原型稿的原话:「孩子扣分后,可通过补救任务赚回积分」。
     如果做成"抵扣",那么当天扣的分会被抹掉 —— 但孩子确实犯了错,
     抹掉就失去了"这个行为不好"的记忆。做成加分则保留两条独立记录:
     「发脾气 -4」「主动道歉 +2」,孩子能看到"我用道歉换回了 2 分",
     但"发脾气"这件事仍在账上。这才是原型稿要的教育逻辑。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const ledger = require('./_shared/ledger');
const pin = require('./_shared/pin');
const medal = require('./_shared/medal');
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  records: 'point_records',
  medals: 'medal_records',
  checkins: 'checkins'
};

/* 单次手动变动的绝对上限。防止手抖多打一个 0 */
const MAX_SINGLE = 1000;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    childId, change, reason, note, pin: inputPin,
    date, allowOverLimit, recordId
  } = event || {};

  if (!childId) return { ok: false, code: 'INVALID', message: '缺少孩子信息。' };

  const rsn = (reason === 'makeup' || reason === 'revoke') ? reason : 'manual';
  const day = (/^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : S.dayKey(new Date());
  const now = new Date();

  try {
    const childRes = await db.collection(COLL.children).doc(childId).get();
    const child = childRes.data;
    if (!child || child._openid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }

    /* ---------- 家长身份校验(R3:4 位 PIN) ----------
       手动改分是家长专属权限,孩子模式不能做 —— 所以这里必须验 PIN。
       若家长还没设 PIN,放行并由前端引导去设置(否则新用户无法手动加分)。 */
    if (child.parentPin && child.parentPin.hash) {
      const v = pin.verifyPin(child, inputPin);
      if (!v.ok) {
        /* 把尝试计数/锁定写回,否则限次形同虚设 */
        if (v.parentPin) {
          await db.collection(COLL.children).doc(childId)
        /* ★ 必须 _.set():云开发传裸对象是按子字段合并,parentPin 为 null 时会报错 —— 详见 setPin/index.js 的说明 */
            .update({ data: { parentPin: _.set(v.parentPin) } });
        }
        const msg = v.code === 'PIN_LOCKED'
          ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
          : '家长密码不对。';
        return { ok: false, code: v.code, message: msg };
      }
      /* 校验通过 → 重置尝试计数 */
      if (v.parentPin) {
        await db.collection(COLL.children).doc(childId)
          .update({ data: { parentPin: _.set(v.parentPin) } });
      }
    }

    let magnitude, kind, refKind = null, refId = '', refName = '';

    /* ---------- 分支 A:冲正一笔历史流水 ---------- */
    if (rsn === 'revoke') {
      if (!recordId) return { ok: false, code: 'INVALID', message: '缺少要冲正的流水 ID。' };

      let rec;
      try {
        const r = await db.collection(COLL.records).doc(recordId).get();
        rec = r.data;
      } catch (e) {
        return { ok: false, code: 'NOT_FOUND', message: '找不到这笔记录。' };
      }
      if (!rec || rec._openid !== OPENID) {
        return { ok: false, code: 'FORBIDDEN', message: '无权操作该记录。' };
      }
      if (rec.kind === 'revoke') {
        return { ok: false, code: 'INVALID', message: '冲正记录不能再被冲正。' };
      }

      magnitude = Math.abs(Number(rec.change) || 0);
      kind = 'revoke';
      refKind = rec.kind;                 /* 按原记录的方向反向 */
      refId = recordId;
      refName = rec.refName || '';

      if (magnitude === 0) {
        return { ok: false, code: 'INVALID', message: '这笔记录金额为 0,无需冲正。' };
      }

    /* ---------- 分支 B:手动加分 / 扣分 / 补救 ---------- */
    } else {
      const raw = Number(change);
      if (!isFinite(raw) || raw === 0) {
        return { ok: false, code: 'INVALID', message: '请填写一个非 0 的分值。' };
      }
      if (Math.abs(raw) > MAX_SINGLE) {
        return { ok: false, code: 'INVALID', message: '单次最多 ' + MAX_SINGLE + ' 分,请检查是否多打了 0。' };
      }

      magnitude = Math.abs(Math.round(raw));
      kind = (raw > 0) ? 'bonus' : 'penalty';
      refName = String(note || '').trim().slice(0, 30) ||
                (rsn === 'makeup' ? '犯错补救' : (raw > 0 ? '手动加分' : '手动扣分'));

      /* ---------- 扣分也要受单日上限保护(R4) ----------
         例外:allowOverLimit=true 表示家长明确要突破 —— 这是 R4 里"家长可手动突破"的落地。 */
      if (kind === 'penalty' && !allowOverLimit) {
        const limit = Number(child.penaltyLimit);
        const safeLimit = (isFinite(limit) && limit > 0) ? limit : C.PENALTY_LIMIT.def;

        const todayRes = await db.collection(COLL.records)
          .where({ _openid: OPENID, childId: childId, date: day })
          .field({ kind: true, change: true, refKind: true })
          .limit(200)
          .get();

        const remain = ledger.remainingPenaltyBudget(todayRes.data || [], safeLimit);
        if (remain < magnitude) {
          return {
            ok: false,
            code: C.ERR.PENALTY_LIMIT,
            message: '今天最多还能扣 ' + remain + ' 分。是否要以家长身份突破上限?',
            remain: remain,
            need: magnitude,
            canOverLimit: true
          };
        }
      }
    }

    /* ---------- 事务:流水 + 双余额 ---------- */
    const d = ledger.splitDelta(kind, magnitude, refKind);

    const txResult = await db.runTransaction(async (transaction) => {
      const cRes = await transaction.collection(COLL.children).doc(childId).get();
      const c = cRes.data;
      if (c._openid !== OPENID) throw new Error('FORBIDDEN');

      const availBefore = Number(c.availablePoints) || 0;
      const lifeBefore = Number(c.lifetimePoints) || 0;
      const availAfter = availBefore + d.dAvailable;
      const lifeAfter = Math.max(0, lifeBefore + d.dLifetime);

      await transaction.collection(COLL.records).add({
        data: {
          _openid: OPENID,
          childId: childId,
          change: d.dAvailable,
          kind: kind,
          refKind: refKind,
          date: day,
          availAfter: availAfter,
          lifeAfter: lifeAfter,
          reason: rsn,
          refId: refId,
          refName: refName,
          operatorOpenid: OPENID,
          createdAt: now
        }
      });

      await transaction.collection(COLL.children).doc(childId).update({
        data: {
          availablePoints: availAfter,
          lifetimePoints: lifeAfter,
          updatedAt: now
        }
      });

      return { availAfter: availAfter, lifeAfter: lifeAfter };
    });

    /* ---------- 勋章可能因为这次加分而解锁 ---------- */
    let newMedals = [];
    if (d.dAvailable > 0) {
      try { newMedals = await refreshMedals(OPENID, childId, day); }
      catch (e) { console.error('[adjustPoints] medal refresh failed', e); }
    }

    const label = rsn === 'makeup' ? '补救'
                : rsn === 'revoke' ? '冲正' : '调整';
    return {
      ok: true,
      changed: true,
      delta: d.dAvailable,
      kind: kind,
      availablePoints: txResult.availAfter,
      lifetimePoints: txResult.lifeAfter,
      newMedals: newMedals,
      message: label + (d.dAvailable > 0 ? ' +' : ' ') + d.dAvailable + ' 分。'
    };

  } catch (err) {
    if (err && err.message === 'FORBIDDEN') {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }
    console.error('[adjustPoints] failed', err);
    return { ok: false, code: 'TX_FAILED', message: '保存失败,积分未变动,请重试。' };
  }
};

/* 与 taskToggle 中同名函数逻辑一致 —— 勋章按需重算并落库 */
async function refreshMedals(openid, childId, today) {
  const [checkinRes, earnedRes] = await Promise.all([
    db.collection(COLL.checkins)
      .where({ _openid: openid, childId: childId, status: 'done' })
      .field({ date: true, medalTag: true, score: true, status: true })
      .limit(2000).get(),
    db.collection(COLL.medals)
      .where({ _openid: openid, childId: childId })
      .field({ medalKey: true })
      .limit(50).get()
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
    try {
      await db.collection(COLL.medals).doc(childId + '_' + key).set({
        data: {
          _openid: openid, childId: childId, medalKey: key,
          medalName: meta ? meta.name : key, icon: meta ? meta.icon : '',
          unlockedAt: now, unlockedDate: today
        }
      });
      written.push({ key: key, name: meta ? meta.name : key, icon: meta ? meta.icon : '' });
    } catch (e) { console.log('[adjustPoints] medal exists', key); }
  }
  return written;
}
