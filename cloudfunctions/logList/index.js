/* 云函数 · logList —— 成长日志列表(原型稿页面6)

   分页返回,按日期倒序。每条带当天净得分快照。
   ★ 不返回流水明细 —— 日志页只看"那天发生了什么、得了多少分",
     要看明细是统计页的事。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLL = { children: 'children', logs: 'logs' };

const PAGE = 20;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId, offset, date } = event || {};

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: true, list: [], total: 0, needInit: true };

    const cid = childId || child._id;
    const skip = Math.max(0, Number(offset) || 0);

    /* 指定日期 → 只取那一条(首页点日期格子用) */
    if (date) {
      try {
        const r = await db.collection(COLL.logs).doc(cid + '_' + date).get();
        return { ok: true, list: r.data ? [shape(r.data)] : [], total: r.data ? 1 : 0 };
      } catch (e) {
        return { ok: true, list: [], total: 0 };
      }
    }

    const q = db.collection(COLL.logs).where({ _openid: OPENID, childId: cid });

    const [listRes, cntRes] = await Promise.all([
      q.orderBy('date', 'desc').skip(skip).limit(PAGE).get(),
      q.count()
    ]);

    return {
      ok: true,
      childId: cid,
      list: (listRes.data || []).map(shape),
      total: cntRes.total,
      hasMore: skip + (listRes.data || []).length < cntRes.total,
      nextOffset: skip + (listRes.data || []).length
    };

  } catch (err) {
    console.error('[logList] failed', err);
    return { ok: false, code: 'LOAD_FAILED', message: '加载失败,请重试。' };
  }
};

function shape(g) {
  return {
    _id: g._id,
    date: g.date || '',
    /* 2026-09-22 → 9月22日 */
    dateText: fmtDate(g.date),
    weekday: weekdayOf(g.date),
    text: g.text || '',
    netPoints: Number(g.netPoints) || 0,
    netText: (Number(g.netPoints) > 0 ? '+' : '') + (Number(g.netPoints) || 0)
  };
}

function fmtDate(key) {
  if (!key || key.length < 10) return key || '';
  return Number(key.slice(5, 7)) + '月' + Number(key.slice(8, 10)) + '日';
}

function weekdayOf(key) {
  const p = String(key || '').split('-');
  if (p.length !== 3) return '';
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
