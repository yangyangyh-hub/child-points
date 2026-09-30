/* 测试 · taskToggle 云函数的核心积分逻辑
   运行:node tests/taskToggle.test.js

   为什么单独测这个:积分是产品的全部资产且不可回滚。
   这里用内存假库把核心算法抽出来验证,重点测 3 个我判断最容易写错的地方:
     1) 扣分任务"取消打勾"时应该加分(方向);
     2) 同一天同一任务重复点击不应该重复加分(幂等);
     3) balanceAfter 应该等于变动前余额 + 增量(对账链)。
   运行不需要微信环境,纯算法验证。 */

'use strict';

/* ---------- 把云函数里的积分算法独立复刻一份便于测试 ----------
   注意:这是"按云函数逻辑重写"的镜像,不是引入真实文件(真实文件依赖 wx-server-sdk)。
   若改了 functions/taskToggle/index.js 的算法,这里必须同步改。 */
function computeDelta(wantDone, score) {
  return (wantDone ? 1 : -1) * score;
}

/* ---------- 极简内存库 ---------- */
function makeDb() {
  const store = { children: {}, checkins: {}, records: [] };
  return {
    store,
    getChild(id) { return store.children[id]; },
    seedChild(id, points) {
      store.children[id] = { _id: id, _openid: 'op1', totalPoints: points };
    },
    /* 复刻云函数的 taskToggle 主逻辑(去掉权限/校验,只留积分算法) */
    toggle(childId, taskId, date, wantDone, task) {
      const checkinId = `${childId}_${taskId}_${date}`;

      /* 确定性 _id 去重:已存在就复用,天然不会产生第二条 */
      const existing = store.checkins[checkinId] || null;
      const wasDone = !!(existing && existing.status === 'done');

      if (wasDone === wantDone) {
        return { ok: true, changed: false, balance: store.children[childId].totalPoints };
      }

      const delta = computeDelta(wantDone, task.score);
      const before = store.children[childId].totalPoints;
      const after = before + delta;

      store.checkins[checkinId] = {
        _id: checkinId, taskId, date,
        status: wantDone ? 'done' : 'undone',
        score: task.score, taskName: task.name
      };
      store.records.push({ change: delta, balanceAfter: after, refId: checkinId });
      store.children[childId].totalPoints = after;

      return { ok: true, changed: true, delta, balance: after };
    }
  };
}

/* ---------- 断言工具 ---------- */
let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + label); }
  else { fail++; failures.push(label); console.log('  ✗ ' + label + '  期望 ' + e + '  实得 ' + a); }
}

console.log('\n[1] 加分任务 +8:打勾 -> 加分');
{
  const db = makeDb();
  db.seedChild('c1', 0);
  const t = { name: '按时完成作业', score: 8 };
  const r = db.toggle('c1', 't1', '2026-09-22', true, t);
  eq(r.changed, true, '产生了变动');
  eq(r.delta, 8, '增量 +8');
  eq(db.getChild('c1').totalPoints, 8, '总分 0 -> 8');
  eq(db.store.records.length, 1, '流水 1 条');
  eq(db.store.records[0].balanceAfter, 8, 'balanceAfter = 8');
}

console.log('\n[2] ★扣分任务 -3:打勾 -> 扣分');
{
  const db = makeDb();
  db.seedChild('c1', 10);
  const t = { name: '发脾气哭闹', score: -3 };
  const r = db.toggle('c1', 't2', '2026-09-22', true, t);
  eq(r.delta, -3, '增量 -3');
  eq(db.getChild('c1').totalPoints, 7, '总分 10 -> 7');
}

console.log('\n[3] ★★扣分任务 -3:取消打勾 -> 必须把分还回去(+3)');
{
  const db = makeDb();
  db.seedChild('c1', 10);
  const t = { name: '发脾气哭闹', score: -3 };
  db.toggle('c1', 't2', '2026-09-22', true, t);      /* 先打勾,10 -> 7 */
  const r = db.toggle('c1', 't2', '2026-09-22', false, t); /* 取消,7 -> 10 */
  eq(r.delta, 3, '取消时增量 +3(不是 -3)');
  eq(db.getChild('c1').totalPoints, 10, '总分回到 10');
  eq(db.store.records.length, 2, '流水追加为 2 条(只增不改)');
}

console.log('\n[4] ★★幂等:同一天同一任务重复打勾,不能重复加分');
{
  const db = makeDb();
  db.seedChild('c1', 0);
  const t = { name: '按时完成作业', score: 8 };
  db.toggle('c1', 't1', '2026-09-22', true, t);
  const r2 = db.toggle('c1', 't1', '2026-09-22', true, t);
  const r3 = db.toggle('c1', 't1', '2026-09-22', true, t);
  eq(r2.changed, false, '第二次点击无变动');
  eq(r3.changed, false, '第三次点击无变动');
  eq(db.getChild('c1').totalPoints, 8, '总分仍是 8(没有 24)');
  eq(db.store.records.length, 1, '流水仍是 1 条');
}

console.log('\n[5] 跨天:同任务不同日期,各自独立计分');
{
  const db = makeDb();
  db.seedChild('c1', 0);
  const t = { name: '按时完成作业', score: 8 };
  db.toggle('c1', 't1', '2026-09-21', true, t);
  db.toggle('c1', 't1', '2026-09-22', true, t);
  eq(db.getChild('c1').totalPoints, 16, '两天各加 8 -> 16');
  eq(Object.keys(db.store.checkins).length, 2, '两条独立打卡记录');
}

console.log('\n[6] 总分允许为负(孩子"欠分"是真实业务状态)');
{
  const db = makeDb();
  db.seedChild('c1', 2);
  const t = { name: '发脾气哭闹', score: -3 };
  const r = db.toggle('c1', 't2', '2026-09-22', true, t);
  eq(r.balance, -1, '总分 2 -> -1(不应抛错/截断为 0)');
}

console.log('\n[7] 对账:balanceAfter 链式连续,末值 = 总分');
{
  const db = makeDb();
  db.seedChild('c1', 0);
  db.toggle('c1', 't1', '2026-09-22', true, { name: 'A', score: 8 });
  db.toggle('c1', 't2', '2026-09-22', true, { name: 'B', score: 5 });
  db.toggle('c1', 't3', '2026-09-22', true, { name: 'C', score: -3 });
  const balances = db.store.records.map(r => r.balanceAfter);
  eq(balances, [8, 13, 10], '余额链 8 -> 13 -> 10');
  eq(db.getChild('c1').totalPoints, 10, '末值等于总分');
  const sum = db.store.records.reduce((s, r) => s + r.change, 0);
  eq(sum, db.getChild('c1').totalPoints, '流水求和 == 总分(可对账)');
}

console.log('\n[8] 快照:任务改分后,历史流水不受影响');
{
  const db = makeDb();
  db.seedChild('c1', 0);
  const t = { name: '按时完成作业', score: 8 };
  db.toggle('c1', 't1', '2026-09-22', true, t);
  /* 家长事后把任务从 +8 改成 +5 */
  db.toggle('c1', 't9', '2026-09-22', true, { name: '按时完成作业', score: 5 });
  eq(db.store.records[0].change, 8, '昨天那条流水仍是 +8(未被追溯改写)');
  eq(db.store.records[1].change, 5, '新的一条是 +5');
}

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' 项,失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过。\n');
