/* 云函数 · rewardSave —— 奖励的新增 / 修改 / 上下架

   ★ 按文字原型稿重构(2026-09-22)。变化点:
     1) tier 分档(小额即时 / 大额长期)
     2) stock 库存,支持 -1 不限量
     3) 预设奖励不可删除(与任务同理:改价可以,删掉会让历史兑换找不到出处) */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const C = require('./_shared/constants');

const COLL = { children: 'children', rewards: 'rewards' };
const MAX_COST = 99999;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, rewardId, childId, name, cost, icon, tier, stock, active } = event || {};

  const act = action || (rewardId ? 'update' : 'create');

  try {
    /* ---------- 已有奖励:改 / 上下架 / 删 ---------- */
    if (rewardId) {
      let rw;
      try {
        const r = await db.collection(COLL.rewards).doc(rewardId).get();
        rw = r.data;
      } catch (e) {
        return { ok: false, code: 'NOT_FOUND', message: '奖励不存在。' };
      }
      if (!rw || rw._openid !== OPENID) {
        return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
      }

      if (act === 'delete') {
        if (rw.preset) {
          return {
            ok: false, code: 'INVALID',
            message: '「' + rw.name + '」是系统自带的奖励,可以下架但不能删除。',
            canDeactivate: true
          };
        }
        await db.collection(COLL.rewards).doc(rewardId).update({
          data: { active: false, deletedAt: new Date(), updatedAt: new Date() }
        });
        return { ok: true, changed: true, message: '已删除「' + rw.name + '」。' };
      }

      if (act === 'toggle') {
        const next = (active !== false);
        await db.collection(COLL.rewards).doc(rewardId).update({
          data: { active: next, updatedAt: new Date() }
        });
        return {
          ok: true, changed: true, active: next,
          message: next ? '已上架「' + rw.name + '」' : '已下架「' + rw.name + '」'
        };
      }

      const patch = { updatedAt: new Date() };
      if (name !== undefined) {
        const nm = String(name).trim().slice(0, 20);
        if (!nm) return { ok: false, code: 'INVALID', message: '奖励名称不能为空。' };
        patch.name = nm;
      }
      if (cost !== undefined) {
        const c = Math.round(Number(cost));
        if (!isFinite(c) || c <= 0) return { ok: false, code: 'INVALID', message: '所需积分要大于 0。' };
        if (c > MAX_COST) return { ok: false, code: 'INVALID', message: '积分不要超过 ' + MAX_COST + '。' };
        patch.cost = c;
      }
      if (icon !== undefined) patch.icon = String(icon).slice(0, 4);
      if (tier !== undefined) patch.tier = (tier === 'large') ? 'large' : 'small';
      if (stock !== undefined) {
        const s = Math.round(Number(stock));
        patch.stock = (isFinite(s) && s >= 0) ? s : -1;
      }
      if (active !== undefined) patch.active = !!active;

      await db.collection(COLL.rewards).doc(rewardId).update({ data: patch });
      return {
        ok: true, changed: true, rewardId: rewardId,
        message: '已更新「' + (patch.name || rw.name) + '」。'
      };
    }

    /* ---------- 新增 ---------- */
    if (!childId) return { ok: false, code: 'INVALID', message: '缺少孩子信息。' };

    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID, _id: childId }).limit(1).get();
    if (!(childRes.data || []).length) {
      return { ok: false, code: 'FORBIDDEN', message: '无权为该孩子添加奖励。' };
    }

    const nm = String(name || '').trim().slice(0, 20);
    if (!nm) return { ok: false, code: 'INVALID', message: '请填写奖励名称。' };

    const c = Math.round(Number(cost));
    if (!isFinite(c) || c <= 0) return { ok: false, code: 'INVALID', message: '所需积分要大于 0。' };
    if (c > MAX_COST) return { ok: false, code: 'INVALID', message: '积分不要超过 ' + MAX_COST + '。' };

    const s = Math.round(Number(stock));
    const now = new Date();

    const addRes = await db.collection(COLL.rewards).add({
      data: {
        _openid: OPENID,
        childId: childId,
        name: nm,
        icon: String(icon || '').slice(0, 4),
        cost: c,
        tier: (tier === 'large') ? 'large' : 'small',
        stock: (isFinite(s) && s >= 0) ? s : -1,
        preset: false,
        active: true,
        sortOrder: 9000,
        createdAt: now,
        updatedAt: now
      }
    });

    return {
      ok: true, changed: true, created: true, rewardId: addRes._id,
      message: '已添加「' + nm + '」,需要 ' + c + ' 积分。'
    };

  } catch (err) {
    console.error('[rewardSave] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '保存失败,请重试。' };
  }
};
