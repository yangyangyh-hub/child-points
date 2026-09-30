/* 云函数 · redeemReward —— 兑换奖励(第二个改分入口)

   ★ 按文字原型稿重构(2026-09-22)。核心变化:
     1) 消耗的是 **availablePoints**(可用积分),不是 lifetimePoints(原型稿页面3)
        —— 这是"双积分体系"落地的关键一处:孩子兑换奖励不会动摇"累计荣誉"
     2) 两步审核(原型稿「兑换需家长审核通过」):
        孩子提交 → status='pending';家长确认 → 扣分变 'approved'
     3) 库存扣减(原型稿「奖励可设置库存」隐含)

   ★ 为什么"审核通过"这一步必须在这里而不是在提交时
     如果提交时就扣分,驳回时要"加分回去"—— 那会污染流水:
     孩子会看到「兑换 -50」和「驳回 +50」两条,以为积分被动过。
     先 pending 不扣分,批准时才扣,流水里就干干净净只有一条兑换扣分。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const ledger = require('./_shared/ledger');
const pin = require('./_shared/pin');
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  rewards: 'rewards',
  redemptions: 'redemptions',
  records: 'point_records'
};

/**
 * @param event.action  'request'(提交申请) | 'approve'(批准) | 'reject'(驳回) | 'cancel'(取消)
 */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, childId, rewardId, redemptionId, pin: inputPin } = event || {};
  const act = action || 'request';
  const now = new Date();

  if (!childId) return { ok: false, code: 'INVALID', message: '缺少孩子信息。' };

  try {
    const childRes = await db.collection(COLL.children).doc(childId).get();
    const child = childRes.data;
    if (!child || child._openid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }

    /* ---------- 批准 / 驳回 / 取消 都需要家长身份 ---------- */
    if (act === 'approve' || act === 'reject') {
      const v = await requirePin(child, inputPin, childId);
      if (!v.ok) return v.res;
    }

    /* ================= 提交申请 ================= */
    if (act === 'request') {
      if (!rewardId) return { ok: false, code: 'INVALID', message: '缺少奖励信息。' };

      let reward;
      try {
        const r = await db.collection(COLL.rewards).doc(rewardId).get();
        reward = r.data;
      } catch (e) {
        return { ok: false, code: 'NOT_FOUND', message: '这个奖励已经不在了。' };
      }
      if (!reward || reward._openid !== OPENID) {
        return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
      }
      if (reward.active === false) {
        return { ok: false, code: 'INVALID', message: '这个奖励已经下架了。' };
      }

      const cost = Math.abs(Number(reward.cost) || 0);
      const avail = Number(child.availablePoints) || 0;

      /* 余额校验:必须在服务端做,前端校验可绕过 */
      if (avail < cost) {
        return {
          ok: false, code: C.ERR.NOT_ENOUGH,
          message: '可用积分还差 ' + (cost - avail) + ' 分,再攒一攒吧。',
          available: avail, need: cost
        };
      }

      /* 库存校验(-1 表示不限量) */
      const stock = Number(reward.stock);
      if (isFinite(stock) && stock >= 0 && stock <= 0) {
        return { ok: false, code: 'INVALID', message: '这个奖励已经兑完了。' };
      }

      /* 防止重复提交:同一奖励若有 pending 申请,不再新建 */
      const pendRes = await db.collection(COLL.redemptions)
        .where({ _openid: OPENID, childId: childId, rewardId: rewardId, status: 'pending' })
        .limit(1).get();
      if ((pendRes.data || []).length) {
        return { ok: false, code: C.ERR.DUPLICATE, message: '这个奖励已经提交过申请,等家长确认。' };
      }

      const addRes = await db.collection(COLL.redemptions).add({
        data: {
          _openid: OPENID,
          childId: childId,
          rewardId: rewardId,
          /* 快照:奖励日后改名/改价,历史兑换不能被追溯改写 */
          rewardName: reward.name || '',
          icon: reward.icon || '',
          cost: cost,
          tier: reward.tier || 'small',
          status: 'pending',
          requestedBy: 'child',
          requestedAt: now,
          approvedBy: '',
          approvedAt: null,
          remark: '',
          createdAt: now
        }
      });

      /* ★ 提交阶段不扣分 —— 批准时才扣,流水才干净 */
      return {
        ok: true,
        changed: false,
        redemptionId: addRes._id,
        message: '已提交给家长确认,通过后扣 ' + cost + ' 分。'
      };
    }

    /* ================= 批准 / 驳回 / 取消 ================= */
    if (!redemptionId) return { ok: false, code: 'INVALID', message: '缺少申请记录 ID。' };

    let rd;
    try {
      const r = await db.collection(COLL.redemptions).doc(redemptionId).get();
      rd = r.data;
    } catch (e) {
      return { ok: false, code: 'NOT_FOUND', message: '找不到这条申请。' };
    }
    if (!rd || rd._openid !== OPENID) {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }
    if (rd.status !== 'pending') {
      return { ok: false, code: 'INVALID', message: '这条申请已经处理过了。' };
    }

    /* ---------- 驳回 / 取消:只改状态,不碰积分 ---------- */
    if (act === 'reject' || act === 'cancel') {
      await db.collection(COLL.redemptions).doc(redemptionId).update({
        data: {
          status: act === 'reject' ? 'rejected' : 'cancelled',
          approvedBy: OPENID,
          approvedAt: now,
          remark: String((event || {}).remark || '').slice(0, 50)
        }
      });
      return {
        ok: true,
        changed: false,
        message: act === 'reject' ? '已驳回,积分没有变动。' : '已取消申请。'
      };
    }

    /* ---------- 批准:这一刻才真正扣分 ---------- */
    const cost = Math.abs(Number(rd.cost) || 0);
    const d = ledger.splitDelta('redeem', cost);   /* 只减 availablePoints */

    const txResult = await db.runTransaction(async (transaction) => {
      /* 事务内重读孩子 + 申请,防止并发下重复批准 */
      const cRes = await transaction.collection(COLL.children).doc(childId).get();
      const c = cRes.data;
      if (c._openid !== OPENID) throw new Error('FORBIDDEN');

      const rRes = await transaction.collection(COLL.redemptions).doc(redemptionId).get();
      const r = rRes.data;
      if (r.status !== 'pending') throw new Error('ALREADY_HANDLED');

      const availBefore = Number(c.availablePoints) || 0;
      const lifeBefore = Number(c.lifetimePoints) || 0;

      /* ★ 二次余额校验:提交时够了,现在可能已经被别的兑换花掉 */
      if (availBefore < cost) throw new Error('NOT_ENOUGH');

      const availAfter = availBefore + d.dAvailable;
      const lifeAfter = Math.max(0, lifeBefore + d.dLifetime);

      await transaction.collection(COLL.redemptions).doc(redemptionId).update({
        data: {
          status: 'approved',
          approvedBy: OPENID,
          approvedAt: now,
          remark: String((event || {}).remark || '').slice(0, 50)
        }
      });

      await transaction.collection(COLL.records).add({
        data: {
          _openid: OPENID,
          childId: childId,
          change: d.dAvailable,
          kind: 'redeem',
          refKind: null,
          date: S.dayKey(now),
          availAfter: availAfter,
          lifeAfter: lifeAfter,
          reason: 'redeem',
          refId: redemptionId,
          refName: rd.rewardName || '',
          operatorOpenid: OPENID,
          createdAt: now
        }
      });

      await transaction.collection(COLL.children).doc(childId).update({
        data: { availablePoints: availAfter, lifetimePoints: lifeAfter, updatedAt: now }
      });

      return { availAfter: availAfter, lifeAfter: lifeAfter };
    });

    /* 库存扣减(独立于积分事务:库存不是资产,失败不影响积分正确性) */
    try {
      const rwRes = await db.collection(COLL.rewards).doc(rd.rewardId).get();
      const stock = Number(rwRes.data.stock);
      if (isFinite(stock) && stock > 0) {
        await db.collection(COLL.rewards).doc(rd.rewardId)
          .update({ data: { stock: _.inc(-1), updatedAt: now } });
      }
    } catch (e) {
      console.error('[redeemReward] stock dec failed', e);
    }

    return {
      ok: true,
      changed: true,
      delta: d.dAvailable,
      availablePoints: txResult.availAfter,
      lifetimePoints: txResult.lifeAfter,
      message: '兑换成功,用了 ' + cost + ' 分,累计总积分不变。'
    };

  } catch (err) {
    if (err && err.message === 'FORBIDDEN') {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }
    if (err && err.message === 'NOT_ENOUGH') {
      return { ok: false, code: C.ERR.NOT_ENOUGH, message: '可用积分不够了,可能刚被别的兑换花掉。' };
    }
    if (err && err.message === 'ALREADY_HANDLED') {
      return { ok: false, code: 'INVALID', message: '这条申请已经被处理过了。' };
    }
    console.error('[redeemReward] failed', err);
    return { ok: false, code: 'TX_FAILED', message: '操作失败,请重试。' };
  }
};

/* 家长 PIN 校验 —— 三个函数里重复出现,刻意不抽公共模块:
   每个云函数是独立部署单元,共用外部模块需要额外配置层,不值得。
   真正共享的算法(ledger/medal/pin 本体)才放 _shared。 */
async function requirePin(child, inputPin, childId) {
  if (!child.parentPin || !child.parentPin.hash) return { ok: true };
  const pin = require('./_shared/pin');
  const v = pin.verifyPin(child, inputPin);
  if (v.ok) {
    if (v.parentPin) {
      await db.collection(COLL.children).doc(childId)
        /* ★ 必须 _.set():云开发传裸对象是按子字段合并,parentPin 为 null 时会报错 —— 详见 setPin/index.js 的说明 */
        .update({ data: { parentPin: _.set(v.parentPin) } });
    }
    return { ok: true };
  }
  if (v.parentPin) {
    await db.collection(COLL.children).doc(childId)
      .update({ data: { parentPin: _.set(v.parentPin) } });
  }
  const msg = v.code === 'PIN_LOCKED'
    ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
    : '家长密码不对。';
  return { ok: false, res: { ok: false, code: v.code, message: msg } };
}
