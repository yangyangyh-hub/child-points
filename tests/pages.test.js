/* 测试 · 新增页面的核心逻辑(兑换两步式 / 分页累加 / 保存回调)
   运行:node tests/pages.test.js

   ★ 为什么值得单测这三块
     1) 兑换两步式是"状态机":提交不扣分、批准才扣分。中间任何一步搞错
        都会造成"孩子以为兑换了但没扣分"或"扣了两次"。这是资损级问题。
     2) 日志分页累加容易写成"覆盖"而不是"追加",一上拉就丢前面几页。
     3) 设置页 doSave 用回调在成功后做事(toast / 更新全局缓存),
        回调没被调 → 家长改了没反馈,看起来像没保存。

   ★ 这些测试复刻页面里的纯逻辑,不加载真实页面文件(页面依赖 wx 全局)。
     若改了页面里对应方法,这里要同步改 —— 这是"镜像测试"的固有代价,
     但比不测强。 */

'use strict';

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, msg) {
  if (actual === expected) { pass++; }
  else { fail++; failures.push(msg + ' → 期望 ' + JSON.stringify(expected) + ',实际 ' + JSON.stringify(actual)); }
}
function ok(cond, msg) { cond ? pass++ : (fail++, failures.push(msg)); }

/* ================= 1. 兑换两步式状态机 ================= */

/* 复刻 redeemReward 的四个动作对积分的影响(见 functions/redeemReward/index.js)。
   关键口径:只有 approve 会动 availablePoints;lifetimePoints 永远不动。 */
function redeemStep(action, ctx) {
  const c = Object.assign({}, ctx);
  if (action === 'request') {
    /* 提交:只校验,不改积分 */
    if (c.available < c.cost) return { ok: false, code: 'NOT_ENOUGH', c: c };
    if (c.hasPending) return { ok: false, code: 'DUPLICATE', c: c };
    return { ok: true, c: c, status: 'pending' };
  }
  if (action === 'approve') {
    if (c.status !== 'pending') return { ok: false, code: 'INVALID', c: c };
    if (c.available < c.cost) return { ok: false, code: 'NOT_ENOUGH', c: c };
    c.available -= c.cost;                 /* 只有这里减可用积分 */
    return { ok: true, c: c, status: 'approved', delta: -c.cost };
  }
  if (action === 'reject' || action === 'cancel') {
    if (c.status !== 'pending') return { ok: false, code: 'INVALID', c: c };
    return { ok: true, c: c, status: action === 'reject' ? 'rejected' : 'cancelled' };
  }
  return { ok: false, code: 'NOOP', c: c };
}

(function testRedeemFlow() {
  console.log('\n--- 兑换两步式 ---');

  const base = { available: 100, lifetime: 300, cost: 40, status: 'pending', hasPending: false };

  /* ① 提交不扣分 */
  const r1 = redeemStep('request', { available: 100, lifetime: 300, cost: 40, status: 'new', hasPending: false });
  ok(r1.ok, '提交申请成功');
  eq(r1.c.available, 100, '★ 提交阶段可用积分不变(不预扣)');
  eq(r1.c.lifetime, 300, '提交阶段累计总积分不变');

  /* ② 批准才扣,且只扣可用 */
  const r2 = redeemStep('approve', base);
  ok(r2.ok, '批准成功');
  eq(r2.c.available, 60, '★ 批准后可用积分 -40');
  eq(r2.c.lifetime, 300, '★★ 批准后累计总积分不变(双积分核心)');

  /* ③ 驳回不动积分 */
  const r3 = redeemStep('reject', base);
  ok(r3.ok, '驳回成功');
  eq(r3.c.available, 100, '★ 驳回后可用积分不变');
  eq(r3.c.lifetime, 300, '驳回后累计总积分不变');

  /* ④ 取消不动积分 */
  const r4 = redeemStep('cancel', base);
  ok(r4.ok, '取消成功');
  eq(r4.c.available, 100, '取消后可用积分不变');

  /* ⑤ 余额不够时提交就被拦(不用等到批准) */
  const r5 = redeemStep('request', { available: 30, lifetime: 300, cost: 40, status: 'new', hasPending: false });
  eq(r5.ok, false, '余额不足时提交失败');
  eq(r5.code, 'NOT_ENOUGH', '余额不足返回 NOT_ENOUGH');

  /* ⑥ 已有 pending 时不能重复提交 */
  const r6 = redeemStep('request', { available: 100, lifetime: 300, cost: 40, status: 'new', hasPending: true });
  eq(r6.code, 'DUPLICATE', '同一奖励有 pending 时返回 DUPLICATE');

  /* ⑦ 已处理的申请不能被再次批准(防重复扣分) */
  const r7 = redeemStep('approve', { available: 100, lifetime: 300, cost: 40, status: 'approved', hasPending: false });
  eq(r7.ok, false, '★ 已批准的申请不能重复批准');
  eq(r7.c.available, 100, '★ 重复批准不会二次扣分');

  /* ⑧ 提交时够、批准时不够(期间被别处花掉)→ 批准失败,不产生负余额 */
  const r8 = redeemStep('approve', { available: 10, lifetime: 300, cost: 40, status: 'pending', hasPending: false });
  eq(r8.ok, false, '★ 批准时余额不足会失败');
  eq(r8.c.available, 10, '★ 失败时不产生负数余额');
})();

/* ================= 2. 日志分页累加 ================= */

(function testPaging() {
  console.log('\n--- 日志分页累加 ---');

  /* 复刻 sub/log/log.js 的 loadMore 语义:必须是 concat 而不是覆盖 */
  let state = { list: [], nextOffset: 0, hasMore: true };

  function firstPage(page) {
    state.list = page.list;
    state.hasMore = page.hasMore;
    state.nextOffset = page.nextOffset;
  }
  function loadMore(page) {
    /* ★ 这一行是整个用例的重点:用 concat,并且把新页放在后面 */
    state.list = state.list.concat(page.list);
    state.hasMore = page.hasMore;
    state.nextOffset = page.nextOffset;
  }

  const p1 = { list: ['a', 'b'], hasMore: true, nextOffset: 2 };
  const p2 = { list: ['c', 'd'], hasMore: true, nextOffset: 4 };
  const p3 = { list: ['e'], hasMore: false, nextOffset: 5 };

  firstPage(p1);
  eq(state.list.length, 2, '首屏 2 条');
  eq(state.nextOffset, 2, '下一页偏移 2');

  loadMore(p2);
  eq(state.list.length, 4, '★ 第二页是追加,不是覆盖(4 条)');
  eq(state.list[0], 'a', '★ 追加后第一条仍是首屏的数据');

  loadMore(p3);
  eq(state.list.length, 5, '第三页后共 5 条');
  eq(state.hasMore, false, '末页 hasMore=false');
  eq(state.list[4], 'e', '最后一条是新页数据');

  /* 顺序验证:分页数据必须保持服务端的日期倒序 */
  eq(state.list.join(''), 'abcde', '★ 追加顺序正确(不被打乱)');
})();

/* ================= 3. 设置页 doSave 回调 ================= */

(function testSaveCallback() {
  console.log('\n--- 设置页 doSave ---');

  /* 复刻 setting.js 的 doSave:成功才调回调;失败不调 */
  function doSave(res, onOk) {
    if (!res || !res.ok) return { called: false };
    if (typeof onOk === 'function') onOk(res);
    return { called: true };
  }

  let hit = 0;
  doSave({ ok: true }, function () { hit++; });
  eq(hit, 1, '★ 保存成功时回调被调用');

  hit = 0;
  doSave({ ok: false, message: 'x' }, function () { hit++; });
  eq(hit, 0, '★ 保存失败时回调不被调用');

  hit = 0;
  doSave(null, function () { hit++; });
  eq(hit, 0, '★ 无响应时回调不被调用');
})();

/* ================= 4. 奖励分组逻辑 ================= */

(function testGrouping() {
  console.log('\n--- 奖励分组 ---');

  /* 复刻 reward.js applyData 里的分组:按 tiers 分,空档不显示 */
  function group(tiers, rewards) {
    const out = [];
    tiers.forEach(function (t) {
      const list = rewards.filter(function (r) { return r.tier === t.key; });
      if (!list.length) return;
      out.push({ key: t.key, list: list });
    });
    return out;
  }

  const tiers = [{ key: 'small' }, { key: 'large' }];

  const g1 = group(tiers, [
    { tier: 'small', name: 'A' }, { tier: 'small', name: 'B' }, { tier: 'large', name: 'C' }
  ]);
  eq(g1.length, 2, '两档都有 → 两组');
  eq(g1[0].list.length, 2, '小额 2 条');
  eq(g1[1].list.length, 1, '大额 1 条');

  const g2 = group(tiers, [{ tier: 'small', name: 'A' }]);
  eq(g2.length, 1, '★ 大额为空时不显示空分组');

  const g3 = group(tiers, []);
  eq(g3.length, 0, '没有奖励时不产生分组');
})();

/* ================= 5. 规则页分值方向 ================= */

(function testTaskScoreDirection() {
  console.log('\n--- 规则页分值方向 ---');

  /* 复刻 rules.js onSaveTask:方向由当前分栏决定,不由用户输入的正负决定 */
  function normalizeScore(raw, isPenalty) {
    const n = Math.abs(parseInt(raw, 10));
    return isPenalty ? -n : n;
  }

  eq(normalizeScore('5', false), 5, '加分栏填 5 → +5');
  eq(normalizeScore('5', true), -5, '★ 扣分栏填 5 → -5(用户不用填负号)');
  eq(normalizeScore('-5', false), 5, '★ 加分栏误填 -5 → 仍为 +5(容错)');
  eq(normalizeScore('-5', true), -5, '★ 扣分栏误填 -5 → 仍为 -5(容错)');
})();

/* ================= 6. 勋章列表分组与排序 ================= */

(function testMedalSort() {
  console.log('\n--- 勋章排序 ---');

  /* 复刻 medal.js applyData:未解锁按进度倒序 */
  const medals = [
    { key: 'a', unlocked: false, percent: 20 },
    { key: 'b', unlocked: true, percent: 100 },
    { key: 'c', unlocked: false, percent: 80 },
    { key: 'd', unlocked: false, percent: 50 }
  ];
  const locked = medals.filter(function (m) { return !m.unlocked; })
    .sort(function (x, y) { return y.percent - x.percent; });

  eq(locked[0].key, 'c', '★ 最接近解锁的排最前(80%)');
  eq(locked[2].key, 'a', '进度最低的排最后(20%)');
  eq(locked.length, 3, '已解锁的不在进行中列表里');
})();

/* ================= 7. 区间切换的降级 ================= */

(function testRangeDowngrade() {
  console.log('\n--- 统计区间降级 ---');

  /* 孩子模式不允许看 month,切到孩子时要降回 week */
  function normalizeRange(range, isParent) {
    if (!isParent && range === 'month') return 'week';
    return range;
  }

  eq(normalizeRange('month', false), 'week', '★ 孩子模式的 month 降级为 week');
  eq(normalizeRange('month', true), 'month', '家长模式保留 month');
  eq(normalizeRange('week', false), 'week', '孩子模式 week 不变');
})();

/* ================= 汇总 ================= */

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
} else {
  console.log('  ✓ 全部通过');
}
