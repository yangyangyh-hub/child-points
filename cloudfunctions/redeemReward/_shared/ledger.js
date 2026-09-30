/* 双积分账本 —— 全项目唯一允许改积分的地方

   ★ 核心口径(R1/R2,2026-09-22 yang 拍板)

     availablePoints  可用积分   兑换时减少,扣分时减少
     lifetimePoints   累计总积分 「历史所有加分之和」,只增不减

     kind = 'bonus'   → available += |v| ;  lifetime += |v|
     kind = 'penalty' → available -= |v| ;  lifetime  不变
     kind = 'redeem'  → available -= |v| ;  lifetime  不变
     kind = 'revoke'  → 按 refKind 反向冲正

   ★ 为什么 lifetime 只有加分才涨
     "一辈子累计,只增不减,代表成长荣誉"(原型稿 §四.2)。
     如果扣分也减 lifetime,那它就不是荣誉,只是第二个余额而已,
     "避免孩子把成长成果一次性兑换挥霍"这个设计目的就落空了。

   ★ 为什么余额记在 children 上而不是流水里
     流水只记 delta,余额每次由服务端读改写(R2)。
     理由是"余额双写"在并发下极易不一致,而 children 文档上的
     冗余字段本来就有一个现成的读改写点(事务),顺带写掉零成本。 */

const { KIND, REASON, ERR } = require('./constants');

/**
 * 把一次「变动」拆解成两个余额的增量。
 * @param {string} kind  bonus | penalty | redeem | revoke
 * @param {number} amount 正数(绝对值);方向由 kind 决定
 * @param {string} [refKind] kind='revoke' 时必传:被冲正记录的 kind
 * @returns {{dAvailable:number, dLifetime:number}}
 */
function splitDelta(kind, amount, refKind) {
  const v = Math.abs(Number(amount) || 0);

  if (kind === KIND.BONUS) {
    /* 加分:两个余额一起涨 */
    return { dAvailable: v, dLifetime: v };
  }
  if (kind === KIND.PENALTY || kind === KIND.REDEEM) {
    /* 扣分 / 兑换:只动可用积分,累计总积分纹丝不动 */
    return { dAvailable: -v, dLifetime: 0 };
  }
  if (kind === KIND.REVOKE) {
    /* 冲正:把原记录的影响原样反回去 */
    const rk = refKind || KIND.BONUS;
    const orig = splitDelta(rk, v);
    return { dAvailable: -orig.dAvailable, dLifetime: -orig.dLifetime };
  }
  throw new Error(ERR.INVALID + '|unknown kind: ' + kind);
}

/**
 * 从一条任务的 score 推导出「勾选」时的 kind 与 amount。
 * score 带符号:正数=加分任务,负数=扣分任务。
 */
function taskKindOf(score) {
  return Number(score) >= 0 ? KIND.BONUS : KIND.PENALTY;
}

/**
 * 算「今天还能扣多少分」(R4:单日扣分上限,口径 = 扣分绝对值之和)。
 * 只有 penalty 且未被冲正的记录计入;兑换不算扣分。
 * @param {Array} records  今日的 point_records
 * @returns {number} 剩余可扣分额度
 */
function remainingPenaltyBudget(records, limit) {
  let used = 0;
  (records || []).forEach(function (r) {
    /* 用 kind 而不是 change 的符号判断,避免把"撤销加分"的负数误算成扣分 */
    if (r.kind === KIND.PENALTY) used += Math.abs(Number(r.change) || 0);
    if (r.kind === KIND.REVOKE && r.refKind === KIND.PENALTY) {
      used -= Math.abs(Number(r.change) || 0);   /* 冲正后额度还回来 */
    }
  });
  const cap = Number(limit);
  const safeCap = (isFinite(cap) && cap > 0) ? cap : 15;
  return Math.max(0, safeCap - used);
}

/**
 * 结算一个孩子的两个余额(纯函数,便于单测)。
 * 不依赖数据库 —— 传入流水数组即可复算,是「对账」的基础。
 * @param {Array} records 全部 point_records
 */
function settle(records) {
  let available = 0, lifetime = 0;
  (records || []).forEach(function (r) {
    const d = splitDelta(r.kind, Math.abs(r.change), r.refKind);
    available += d.dAvailable;
    lifetime  += d.dLifetime;
  });
  return { availablePoints: available, lifetimePoints: lifetime };
}

module.exports = { splitDelta, taskKindOf, remainingPenaltyBudget, settle, KIND, REASON };
