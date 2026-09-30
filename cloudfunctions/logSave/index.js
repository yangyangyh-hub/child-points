/* 云函数 · logSave —— 成长日志(原型稿页面6)

   ★ 与「今日备注」是同一张表(2026-09-22 yang 确认)
     首页底部的【添加今日备注】和成长日志页写的是同一条记录,
     只是首页是快速入口。所以这里用「每个孩子每天一条」的模型:
     _id = `${childId}_${date}` —— 同一天再写就是修改而不是新增。

   ★ 为什么要冗余 netPoints(当天净得分)
     原型稿页面6 明确要求「自动关联日期、当日积分」。
     如果渲染时实时算,那三个月后家长改了某条流水,历史日志显示的
     "当天净得分"会跟着变 —— 那这条日志的语境就毁了。
     所以写入时快照一次,之后不再更新。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const S = require('./_shared/streak');

const COLL = {
  children: 'children',
  logs: 'logs',
  records: 'point_records'
};

const MAX_LEN = 300;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId, date, text, delete: doDelete } = event || {};

  const day = (/^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : S.dayKey(new Date());

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: false, code: 'NOT_FOUND', message: '还没有孩子信息。' };

    const cid = childId || child._id;
    const logId = cid + '_' + day;
    const now = new Date();

    /* ---------- 删除 ---------- */
    if (doDelete) {
      try {
        const r = await db.collection(COLL.logs).doc(logId).get();
        if (r.data && r.data._openid !== OPENID) {
          return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
        }
      } catch (e) { /* 不存在,当作已删 */ }
      try {
        await db.collection(COLL.logs).doc(logId).remove();
      } catch (e) { /* 已经没了 */ }
      return { ok: true, changed: true, removed: true, message: '已删除这条记录。' };
    }

    /* ---------- 写入 ---------- */
    const t = String(text || '').trim().slice(0, MAX_LEN);
    if (!t) {
      /* 清空内容 = 删除这条日志,不留空壳 */
      try { await db.collection(COLL.logs).doc(logId).remove(); } catch (e) {}
      return { ok: true, changed: true, removed: true, message: '内容为空,已移除这条记录。' };
    }

    /* 快照当天净得分(可用积分口径的当日增减) */
    const recRes = await db.collection(COLL.records)
      .where({ _openid: OPENID, childId: cid, date: day })
      .field({ kind: true, change: true, refKind: true })
      .limit(200).get();

    let net = 0;
    (recRes.data || []).forEach(function (r) {
      const v = Math.abs(Number(r.change) || 0);
      if (r.kind === 'bonus') net += v;
      else if (r.kind === 'penalty') net -= v;
      else if (r.kind === 'revoke') {
        if (r.refKind === 'bonus') net -= v;
        else if (r.refKind === 'penalty') net += v;
      }
      /* 兑换不计入"当天得分"—— 那是消费不是表现 */
    });

    let existed = false;
    try {
      const r = await db.collection(COLL.logs).doc(logId).get();
      existed = !!r.data;
      if (existed && r.data._openid !== OPENID) {
        return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
      }
    } catch (e) { existed = false; }

    if (existed) {
      await db.collection(COLL.logs).doc(logId).update({
        data: { text: t, netPoints: net, updatedAt: now }
      });
      return { ok: true, changed: true, updated: true, netPoints: net, message: '已更新今天的记录。' };
    }

    await db.collection(COLL.logs).doc(logId).set({
      data: {
        _openid: OPENID,
        childId: cid,
        date: day,
        text: t,
        netPoints: net,
        createdAt: now,
        updatedAt: now
      }
    });

    return { ok: true, changed: true, created: true, netPoints: net, message: '已记录。' };

  } catch (err) {
    console.error('[logSave] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '保存失败,请重试。' };
  }
};
