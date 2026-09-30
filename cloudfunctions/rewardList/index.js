/* 云函数 · rewardList —— 奖励商城 + 兑换记录(原型稿页面3)

   ★ 按文字原型稿重构(2026-09-22)。变化点:
     1) 返回可用积分(不是总分)—— 兑换能力看的是 availablePoints
     2) 奖励分「小额即时 / 大额长期」两档展示(原型稿设计原则)
     3) 兑换记录含 pending / approved / rejected 三态,家长要能审批
     4) 每条奖励带 affordable 标记,前端据此置灰 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const C = require('./_shared/constants');

const COLL = {
  children: 'children',
  rewards: 'rewards',
  redemptions: 'redemptions'
};

/* ★★ 档位定义统一从 constants 取(2026-09-23 修)
   原来这里第 64 行直接写 `C.REWARD_TIERS.filter(...)`,但服务端 constants.js
   **根本没有这个常量**(它只在前端 config.js 里) ⇒ `undefined.filter` 抛 TypeError
   ⇒ 整个奖励页永远「加载失败,请重试。」。
   同时文件底部返回的 tiers 数组原来是另抄一份的 —— 两份必须一致,
   现在只留 constants 这一份,杜绝漂移。
   `|| []` 是第二道防线:万一再漏,退化成"档位名用 key"而不是整页崩掉。 */
const TIERS = C.REWARD_TIERS || [];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId, mode } = event || {};
  const isChildMode = mode === 'child';

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) {
      return { ok: true, rewards: [], records: [], availablePoints: 0, needInit: true };
    }
    const cid = childId || child._id;
    const avail = Number(child.availablePoints) || 0;

    const [rwRes, rdRes] = await Promise.all([
      /* ★ 孩子只看上架的;家长要看全部,否则下架后就再也找不到重新上架的入口 */
      (isChildMode
        ? db.collection(COLL.rewards)
            .where({ _openid: OPENID, childId: cid, active: true })
        : db.collection(COLL.rewards)
            .where({ _openid: OPENID, childId: cid })
      )
        .orderBy('sortOrder', 'asc')
        .limit(100).get(),
      db.collection(COLL.redemptions)
        .where({ _openid: OPENID, childId: cid })
        .orderBy('createdAt', 'desc')
        .limit(50).get()
    ]);

    /* ---------- 奖励列表 ---------- */
    const rewards = (rwRes.data || []).map(function (r) {
      const cost = Math.abs(Number(r.cost) || 0);
      const stock = Number(r.stock);
      const unlimited = !(isFinite(stock) && stock >= 0);
      const soldOut = !unlimited && stock <= 0;
      return {
        _id: r._id,
        name: r.name,
        icon: r.icon || '',
        cost: cost,
        tier: r.tier || 'small',
        tierLabel: (TIERS.filter(function (x) { return x.key === r.tier; })[0] || {}).label || r.tier,
        preset: !!r.preset,
        /* 家长需要知道这条是不是已下架(前端据此显示"上架") */
        active: r.active !== false,
        unlimited: unlimited,
        stock: unlimited ? -1 : stock,
        soldOut: soldOut,
        /* 余额够不够 —— 前端据此置灰,但真正的校验在云函数里 */
        affordable: !soldOut && avail >= cost,
        gap: Math.max(0, cost - avail)
      };
    });

    /* ---------- 兑换记录 ---------- */
    const records = (rdRes.data || []).map(function (d) {
      return {
        _id: d._id,
        rewardName: d.rewardName || '',
        icon: d.icon || '',
        cost: Math.abs(Number(d.cost) || 0),
        status: d.status,
        statusLabel: statusLabel(d.status),
        isPending: d.status === 'pending',
        requestedBy: d.requestedBy || 'parent',
        timeText: fmtTime(d.approvedAt || d.requestedAt || d.createdAt),
        remark: d.remark || '',
        /* 孩子模式看不到被驳回的记录 —— 那只是家长的一时判断,不必留痕给孩子 */
        hidden: isChildMode && d.status === 'rejected'
      };
    }).filter(function (d) { return !d.hidden; });

    return {
      ok: true,
      childId: cid,
      /* ★ 用可用积分,不是累计总积分(双积分的落地) */
      availablePoints: avail,
      lifetimePoints: Number(child.lifetimePoints) || 0,
      rewards: rewards,
      records: records,
      pendingCount: records.filter(function (d) { return d.isPending; }).length,
      /* 与上方 tierLabel 用同一份定义(constants.REWARD_TIERS),不再各抄一份 */
      tiers: TIERS.map(function (t) {
        return { key: t.key, label: t.label, hint: t.hint };
      }),
      mode: isChildMode ? 'child' : 'parent'
    };

  } catch (err) {
    console.error('[rewardList] failed', err);
    return { ok: false, code: 'LOAD_FAILED', message: '加载失败,请重试。' };
  }
};

function statusLabel(s) {
  if (s === 'pending') return '待家长确认';
  if (s === 'approved') return '已兑换';
  if (s === 'rejected') return '已驳回';
  if (s === 'cancelled') return '已取消';
  return s || '';
}

/* 服务端格式化时间,避免前端各页面各写一套(且小程序 Date 解析 iOS 有坑) */
function fmtTime(t) {
  if (!t) return '';
  const d = (t instanceof Date) ? t : new Date(t);
  if (isNaN(d.getTime())) return '';
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
