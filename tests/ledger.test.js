/* 双积分账本 + 连续打卡算法测试
   运行:  node tests/ledger.test.js
   这两个模块是全项目最核心的纯逻辑,必须在改动时立刻跑一遍。 */

const path = require('path');
const ledger = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'ledger'));
const streak = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'streak'));

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expect) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expect),
     'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expect));
}

console.log('\n=== 1. 双积分拆分(splitDelta) ===');

/* 加分:两个余额一起涨 */
eq('加分 +5 → 可用+5 / 累计+5',
   ledger.splitDelta('bonus', 5), { dAvailable: 5, dLifetime: 5 });

/* 入参是负数也按绝对值处理(方向由 kind 决定,不由符号决定) */
eq('加分 传 -5 也涨(按绝对值)',
   ledger.splitDelta('bonus', -5), { dAvailable: 5, dLifetime: 5 });

/* ★ 核心:R1 决定的扣分只降可用 */
eq('★ 扣分 4 → 可用-4 / 累计 0',
   ledger.splitDelta('penalty', 4), { dAvailable: -4, dLifetime: 0 });

/* 兑换同样只降可用 */
eq('兑换 50 → 可用-50 / 累计 0',
   ledger.splitDelta('redeem', 50), { dAvailable: -50, dLifetime: 0 });

/* 冲正:按原 kind 反向 */
eq('冲正一笔加分5 → 可用-5 / 累计-5',
   ledger.splitDelta('revoke', 5, 'bonus'), { dAvailable: -5, dLifetime: -5 });
eq('冲正一笔扣分4 → 可用+4 / 累计 0',
   ledger.splitDelta('revoke', 4, 'penalty'), { dAvailable: 4, dLifetime: 0 });
eq('冲正兑换50 → 可用+50 / 累计 0',
   ledger.splitDelta('revoke', 50, 'redeem'), { dAvailable: 50, dLifetime: 0 });

/* 未知 kind 必须炸,不能静默返回 0 */
try {
  ledger.splitDelta('nonsense', 1);
  ok('未知 kind 抛错', false, '没有抛错');
} catch (e) { ok('未知 kind 抛错', String(e.message).indexOf('INVALID') === 0); }

console.log('=== 2. 任务方向推导(taskKindOf) ===');
eq('score=+8 → bonus', ledger.taskKindOf(8), 'bonus');
eq('score=-3 → penalty', ledger.taskKindOf(-3), 'penalty');
eq('score=0 → bonus', ledger.taskKindOf(0), 'bonus');

console.log('=== 3. 单日扣分上限(R4:绝对值之和 ≤ 15) ===');

function rec(kind, change, refKind) {
  return { kind: kind, change: change, refKind: refKind };
}

eq('今日无扣分 → 剩 15',
   ledger.remainingPenaltyBudget([], 15), 15);
eq('已扣 4 → 剩 11',
   ledger.remainingPenaltyBudget([rec('penalty', -4)], 15), 11);
eq('已扣 4+3=7 → 剩 8',
   ledger.remainingPenaltyBudget([rec('penalty', -4), rec('penalty', -3)], 15), 8);
eq('扣满 15 → 剩 0',
   ledger.remainingPenaltyBudget([rec('penalty', -5), rec('penalty', -5), rec('penalty', -5)], 15), 0);
eq('超出上限(18)→ 剩 0 不为负',
   ledger.remainingPenaltyBudget([rec('penalty', -10), rec('penalty', -8)], 15), 0);

/* ★ 关键:加分、兑换都不占扣分额度 */
eq('加分不占扣分额度',
   ledger.remainingPenaltyBudget([rec('bonus', 8), rec('bonus', 5)], 15), 15);
eq('兑换不占扣分额度',
   ledger.remainingPenaltyBudget([rec('redeem', -50)], 15), 15);

/* ★ 关键:撤销一笔扣分,额度要还回来 */
eq('冲正一笔扣分4 → 额度还回 4(剩 15)',
   ledger.remainingPenaltyBudget(
     [rec('penalty', -4), rec('revoke', 4, 'penalty')], 15), 15);
eq('冲正一笔加分,不影响额度',
   ledger.remainingPenaltyBudget(
     [rec('penalty', -4), rec('revoke', -5, 'bonus')], 15), 11);

/* 上限可调(R4:1-30) */
eq('上限设为 5,已扣 4 → 剩 1',
   ledger.remainingPenaltyBudget([rec('penalty', -4)], 5), 1);
eq('上限设为 30,已扣 20 → 剩 10',
   ledger.remainingPenaltyBudget([rec('penalty', -20)], 30), 10);
eq('上限非法(0)→ 回退默认 15',
   ledger.remainingPenaltyBudget([], 0), 15);
eq('上限非法(负数)→ 回退默认 15',
   ledger.remainingPenaltyBudget([], -5), 15);

console.log('=== 4. 全量结算(settle) ===');

/* 场景:加了 8+5+3=16,扣了 4,兑换了 10
   → 可用 = 16-4-10 = 2 ; 累计 = 16 */
eq('★ 可用2 / 累计16(扣分与兑换都不动累计)',
   ledger.settle([
     rec('bonus', 8), rec('bonus', 5), rec('bonus', 3),
     rec('penalty', -4), rec('redeem', -10)
   ]), { availablePoints: 2, lifetimePoints: 16 });

/* 同一批数据追加一条冲正,验证对账链闭合 */
eq('冲正一笔兑换10 → 可用回到 12 / 累计仍 16',
   ledger.settle([
     rec('bonus', 8), rec('bonus', 5), rec('bonus', 3),
     rec('penalty', -4), rec('redeem', -10),
     rec('revoke', 10, 'redeem')
   ]), { availablePoints: 12, lifetimePoints: 16 });

eq('空流水 → 0/0', ledger.settle([]), { availablePoints: 0, lifetimePoints: 0 });

console.log('=== 5. 连续打卡(R10:允许断 1 次,第 2 次从 0 重算) ===');

function s(days, today, allowBreak) {
  return streak.streakOf(days, today, allowBreak).current;
}

/* 基准:不断签 */
eq('9/1~9/5 连续,今天 9/5 → 5',
   s(['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05'], '2026-09-05'), 5);

/* 断 1 次:链条继续,但天数只算"有记录的" */
eq('9/1 9/2 [9/3缺] 9/4 9/5,今天 9/5 → 4(用掉 1 次额度)',
   s(['2026-09-01','2026-09-02','2026-09-04','2026-09-05'], '2026-09-05'), 4);

/* ★ 断 2 次:从第 2 次断之后重算 */
eq('★ 9/1 9/2 [3缺] 9/4 9/5 [6缺] 9/7,今天 9/7 → 1(重算)',
   s(['2026-09-01','2026-09-02','2026-09-04','2026-09-05','2026-09-07'], '2026-09-07'), 1);

/* 断 2 次后继续打 */
eq('★ 同上再打 9/8 → 2',
   s(['2026-09-01','2026-09-02','2026-09-04','2026-09-05','2026-09-07','2026-09-08'], '2026-09-08'), 2);

/* 今天是最后一天且还没打卡 —— 不该算断签 */
eq('★ 9/1~9/4 已打,今天 9/5 还没打 → 仍是 4',
   s(['2026-09-01','2026-09-02','2026-09-03','2026-09-04'], '2026-09-05'), 4);

/* 前天断了 1 次(用了额度),之后连打 3 天;今天未打不计断签
   打卡日共 4 天(9/1 + 9/3~9/5),断签 1 次用掉额度 → 链条未断,current = 4 */
eq('[9/2缺] 9/3 9/4 9/5 已打,今天 9/6 未打 → 4',
   s(['2026-09-01','2026-09-03','2026-09-04','2026-09-05'], '2026-09-06'), 4);

/* 断签额度用完后的第二次断,才触发重算 —— 与上例只差一天 */
eq('[9/2缺] 9/3 [9/4缺] 9/5 今天9/5 → 1(第2次断,重算)',
   s(['2026-09-01','2026-09-03','2026-09-05'], '2026-09-05'), 1);

/* 空集合 */
eq('无记录 → 0', s([], '2026-09-05'), 0);

/* allowBreak=0 时,断 1 次就该重算 */
eq('allowBreak=0:9/1 9/2 [3缺] 9/4 今天9/4 → 1',
   s(['2026-09-01','2026-09-02','2026-09-04'], '2026-09-04', 0), 1);

/* allowBreak=2 时,断 2 次仍不断链 */
eq('allowBreak=2:9/1 [2缺] 9/3 [4缺] 9/5 今天9/5 → 3',
   s(['2026-09-01','2026-09-03','2026-09-05'], '2026-09-05', 2), 3);

console.log('=== 6. 跨月/跨年边界 ===');
eq('跨月:8/30 8/31 9/1 今天9/2 → 3',
   s(['2026-08-30','2026-08-31','2026-09-01'], '2026-09-02'), 3);
eq('跨年:12/31 1/1 今天1/2 → 2',
   s(['2026-12-31','2027-01-01'], '2027-01-02'), 2);

/* 闰年 2/29 */
eq('闰年:2/28 2/29 3/1 今天3/1 → 3',
   s(['2028-02-28','2028-02-29','2028-03-01'], '2028-03-01'), 3);

console.log('=== 7. 条件连续(tagStreak:自律小达人) ===');

/* 自律小达人 = 当天同时完成 sleep + nap */
const days = {
  '2026-09-01': ['sleep','nap'],
  '2026-09-02': ['sleep','nap'],
  '2026-09-03': ['sleep'],            /* 缺 nap → 不算 */
  '2026-09-04': ['sleep','nap']
};
eq('9/1 9/2 [9/3缺nap] 9/4 今天9/4 → 3',
   streak.tagStreak(days, ['sleep','nap'], '2026-09-04', 1).current, 3);
eq('allowBreak=0 时同上 → 1',
   streak.tagStreak(days, ['sleep','nap'], '2026-09-04', 0).current, 1);

console.log('=== 8. 无扣分连续(absenceStreak:情绪小勇士) ===');

const badDays = { '2026-09-03': ['emotion'] };
const allDays = ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05'];
/* 有效日 = 9/1 9/2 (9/3 犯错了) 9/4 9/5 —— 断 1 次在 9/3,链条继续 */
eq('9/3 犯错 1 次,今天 9/5 → 4',
   streak.absenceStreak(badDays, 'emotion', '2026-09-05', allDays, 1).current, 4);

console.log('=== 9. 日期工具兜底 ===');
eq('dayKey 本地时区', streak.dayKey(new Date(2026, 8, 22)), '2026-09-22');
eq('addDays 跨月', streak.addDays('2026-08-31', 1), '2026-09-01');
eq('diffDays', streak.diffDays('2026-09-01', '2026-09-05'), 4);

/* ★ 关键回归:早上 7 点不能算成昨天 */
const morning = new Date(2026, 8, 22, 7, 0, 0);
eq('★ 早 7 点 dayKey 仍是当天(不能退到 9/21)',
   streak.dayKey(morning), '2026-09-22');

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  fails.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
} else {
  console.log('  ✓ 全部通过');
}
