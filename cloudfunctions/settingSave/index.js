/* 云函数 · settingSave —— 系统设置中心(原型稿页面7)

   ★ 可以改的四项
     1) 孩子信息:昵称、头像、年级
     2) 单日扣分上限(0–30,原型稿写的范围;R4 收敛为 1–30)
     3) 每日打卡提醒开关 + 提醒时间(存配置,前端做本地提醒)
     4) 重置今日数据(带二次确认标志)

   ★ 关于「每日打卡提醒」
     小程序**没有**后台定时推送能力(除非用订阅消息,而订阅消息需要
     用户每次授权,不能长期常驻)。所以这里的"提醒"落地为:
     存下开关与时间,用户下次打开小程序且已过提醒时间时,首页给一个提示条。
     这是能力边界,不能承诺"到点响铃"。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const pin = require('./_shared/pin');
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  checkins: 'checkins',
  records: 'point_records',
  logs: 'logs'
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    action, childId, pin: inputPin,
    nickname, grade, avatar, penaltyLimit,
    remindEnabled, remindTime, resetDate, confirmReset
  } = event || {};

  const now = new Date();

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: false, code: 'NOT_FOUND', message: '还没有孩子信息。' };
    const cid = childId || child._id;

    /* ---------- 重置今日数据(原型稿页面7)---------- */
    if (action === 'resetToday') {
      if (!confirmReset) {
        return {
          ok: false, code: 'INVALID',
          message: '重置会清空今天的打分记录,需要再次确认。',
          needConfirm: true
        };
      }

      /* 要家长身份 —— 这是破坏性操作 */
      const v = pin.verifyPin(child, inputPin);
      if (!v.ok) {
        if (v.parentPin) {
          await db.collection(COLL.children).doc(cid)
        /* ★ 必须 _.set():云开发传裸对象是按子字段合并,parentPin 为 null 时会报错 —— 详见 setPin/index.js 的说明 */
            .update({ data: { parentPin: _.set(v.parentPin) } });
        }
        const msg = v.code === 'PIN_LOCKED'
          ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
          : '家长密码不对。';
        return { ok: false, code: v.code, message: msg };
      }

      const day = (/^\d{4}-\d{2}-\d{2}$/.test(resetDate)) ? resetDate : S.dayKey(now);

      /* ★ 口径(必须说清,这是最容易出事的地方)
         重置 = 删除当天的 checkins + 冲正当天的积分流水
         不等于"回到当天早上"—— 因为当天的加分已经计入了 lifetimePoints,
         而 lifetimePoints 的设计是"只增不减"(原型稿 §四.2)。

         所以这里的选择是:
           把当天的**加分**也从 lifetimePoints 里扣掉 —— 因为那本就记错了,
           不应污染"终身荣誉"。这是唯一自洽的处理。 */
      const [ckRes, recRes] = await Promise.all([
        db.collection(COLL.checkins)
          .where({ _openid: OPENID, childId: cid, date: day })
          .field({ _id: true }).limit(500).get(),
        db.collection(COLL.records)
          .where({ _openid: OPENID, childId: cid, date: day })
          .field({ change: true, kind: true, refKind: true }).limit(500).get()
      ]);

      const checkins = ckRes.data || [];
      const recs = recRes.data || [];

      /* 累加当天对两个余额的净影响,反向一次性冲掉 */
      let dAvail = 0, dLife = 0;
      recs.forEach(function (r) {
        const v = Math.abs(Number(r.change) || 0);
        if (r.kind === 'bonus') { dAvail -= v; dLife -= v; }
        else if (r.kind === 'penalty') { dAvail += v; }          /* 扣分还回来 */
        else if (r.kind === 'redeem') { dAvail += v; }           /* 兑换还回来 */
        else if (r.kind === 'revoke') {
          /* 冲正记录:影响反向 */
          if (r.refKind === 'bonus') { dAvail += v; dLife += v; }
          else if (r.refKind === 'penalty') { dAvail -= v; }
          else if (r.refKind === 'redeem') { dAvail -= v; }
        }
      });

      const txResult = await db.runTransaction(async (transaction) => {
        const cRes = await transaction.collection(COLL.children).doc(cid).get();
        const c = cRes.data;
        if (c._openid !== OPENID) throw new Error('FORBIDDEN');

        const availAfter = (Number(c.availablePoints) || 0) + dAvail;
        const lifeAfter = Math.max(0, (Number(c.lifetimePoints) || 0) + dLife);

        for (let i = 0; i < checkins.length; i++) {
          await transaction.collection(COLL.checkins).doc(checkins[i]._id).remove();
        }

        /* 删掉当天流水(重置是"抹掉",不是"冲正" —— 冲正会留下负数记录,
           而重置的语义是"这些记录本来就不该存在") */
        const idsRes = await transaction.collection(COLL.records)
          .where({ _openid: OPENID, childId: cid, date: day })
          .field({ _id: true }).limit(500).get();
        const ids = idsRes.data || [];
        for (let i = 0; i < ids.length; i++) {
          await transaction.collection(COLL.records).doc(ids[i]._id).remove();
        }

        await transaction.collection(COLL.children).doc(cid).update({
          data: { availablePoints: availAfter, lifetimePoints: lifeAfter, updatedAt: now }
        });

        return { availAfter: availAfter, lifeAfter: lifeAfter };
      });

      return {
        ok: true,
        changed: true,
        removedCheckins: checkins.length,
        removedRecords: recs.length,
        availablePoints: txResult.availAfter,
        lifetimePoints: txResult.lifeAfter,
        message: '已重置 ' + day + ' 的记录。'
      };
    }

    /* ---------- 普通设置项 ---------- */
    const patch = { updatedAt: now };

    if (nickname !== undefined) {
      const nm = String(nickname).trim().slice(0, 12);
      if (!nm) return { ok: false, code: 'INVALID', message: '昵称不能为空。' };
      patch.nickname = nm;
    }
    if (grade !== undefined) {
      const g = String(grade).trim().slice(0, 8);
      if (g && C.GRADES.indexOf(g) < 0) {
        return { ok: false, code: 'INVALID', message: '年级不在可选范围内。' };
      }
      patch.grade = g;
    }
    if (avatar !== undefined) patch.avatar = String(avatar).slice(0, 300);

    if (penaltyLimit !== undefined) {
      const l = Number(penaltyLimit);
      /* R4:1–30。(原型稿写 0–30;0 意味着完全不能扣分,
         会给家长一个"以为关了扣分其实只是数字设错了"的坑,故下限取 1) */
      if (!isFinite(l) || l < C.PENALTY_LIMIT.min || l > C.PENALTY_LIMIT.max) {
        return {
          ok: false, code: 'INVALID',
          message: '单日扣分上限要在 ' + C.PENALTY_LIMIT.min + '–' + C.PENALTY_LIMIT.max + ' 分之间。'
        };
      }
      patch.penaltyLimit = Math.round(l);
    }

    if (remindEnabled !== undefined) patch.remindEnabled = !!remindEnabled;
    if (remindTime !== undefined) {
      const t = String(remindTime);
      if (!/^\d{2}:\d{2}$/.test(t)) {
        return { ok: false, code: 'INVALID', message: '提醒时间格式应为 HH:MM。' };
      }
      patch.remindTime = t;
    }

    if (Object.keys(patch).length <= 1) {
      return { ok: false, code: 'INVALID', message: '没有需要保存的改动。' };
    }

    await db.collection(COLL.children).doc(cid).update({ data: patch });

    return {
      ok: true, changed: true,
      child: Object.assign({}, pin.stripForChildMode(child), patch),
      message: '设置已保存。'
    };

  } catch (err) {
    if (err && err.message === 'FORBIDDEN') {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }
    console.error('[settingSave] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '保存失败,请重试。' };
  }
};
