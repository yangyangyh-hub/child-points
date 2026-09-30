/* 勋章引擎 + 家长 PIN + 周报模板 测试
   运行:  node tests/medal.test.js  */

const path = require('path');
const M = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'medal'));
const P = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'pin'));
const R = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'report'));
const C = require(path.join(__dirname, '..', 'cloudfunctions', '_shared', 'constants'));

let pass = 0, fail = 0; const fails = [];
function ok(n, c, e) { if (c) pass++; else { fail++; fails.push(n + (e ? '  → ' + e : '')); } }
function eq(n, a, b) { ok(n, JSON.stringify(a) === JSON.stringify(b),
  'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

console.log('\n=== 1. 勋章判定 · 索引构建 ===');

function ck(date, tag, score, status) {
  return { date: date, medalTag: tag || '', score: score, status: status || 'done' };
}

const idx = M.buildIndex([
  ck('2026-09-01', 'sleep', 3),
  ck('2026-09-01', 'nap', 2),
  ck('2026-09-01', 'emotion', -4),      /* 扣分方向 */
  ck('2026-09-02', 'sleep', 3),
  ck('2026-09-02', 'x', 1, 'undone'),   /* undone 不算 */
  ck('2026-09-03', '', 2)               /* 无 tag 不算进 tagsByDay */
]);
eq('有打卡动作的日子(undone 不算)', idx.activeDays, ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('加分方向 tag 索引', idx.tagsByDay['2026-09-01'].sort(), ['nap', 'sleep']);
eq('扣分方向 tag 索引(sleep/nap 不在里面)', idx.badTagsByDay['2026-09-01'], ['emotion']);

console.log('=== 2. 勋章判定 · 五枚逐一验证 ===');

/* 造 30 天完整数据:每天 sleep+nap+reading+homework,无 emotion 扣分 */
const many = [];
for (let i = 1; i <= 30; i++) {
  const d = '2026-09-' + (i < 10 ? '0' + i : i);
  many.push(ck(d, 'sleep', 3));
  many.push(ck(d, 'nap', 2));
  many.push(ck(d, 'reading', 3));
  many.push(ck(d, 'homework', 5));
}
const today = '2026-09-30';
const res = M.evaluate(many, today, {});
const by = {}; res.forEach(function (m) { by[m.key] = m; });

/* 每日坚持之星:连续 30 天 ≥ 7 */
ok('每日坚持之星 解锁(30天 ≥ 7)', by['daily_streak'].unlocked);
eq('每日坚持之星 进度封顶在 target', by['daily_streak'].progress, 7);

/* 作业认真之星:累计 30 天 ≥ 20 */
ok('作业认真之星 解锁(30天 ≥ 20)', by['homework'].unlocked);
eq('作业认真之星 进度封顶 20', by['homework'].progress, 20);

/* 自律小达人:连续 30 天 sleep+nap ≥ 10 */
ok('自律小达人 解锁(30天 ≥ 10)', by['self_discipline'].unlocked);

/* 情绪小勇士:30 天无 emotion 扣分 ≥ 15 */
ok('情绪小勇士 解锁', by['emotion'].unlocked);

/* 阅读小明星:累计 30 次 ≥ 30 */
ok('阅读小明星 解锁(30次 ≥ 30)', by['reading'].unlocked);

console.log('=== 3. 勋章判定 · 未达标场景 ===');

/* 只有 3 天 —— 全部未解锁 */
const few = [ck('2026-09-28','sleep',3), ck('2026-09-28','nap',2),
             ck('2026-09-29','sleep',3), ck('2026-09-29','nap',2),
             ck('2026-09-30','sleep',3), ck('2026-09-30','nap',2)];
const r3 = M.evaluate(few, '2026-09-30', {});
const b3 = {}; r3.forEach(function (m) { b3[m.key] = m; });
ok('3 天 → 每日坚持之星 未解锁', !b3['daily_streak'].unlocked);
eq('3 天 → 进度 3/7', b3['daily_streak'].progress, 3);
eq('3 天 → 百分比 43', b3['daily_streak'].percent, 43);
eq('3 天 → 文案', b3['daily_streak'].progressText, '连续 3/7 天');

/* ★ 自律小达人:只完成了 sleep 没完成 nap → 不算 */
const halfNap = [ck('2026-09-28','sleep',3), ck('2026-09-29','sleep',3), ck('2026-09-30','sleep',3)];
const r4 = M.evaluate(halfNap, '2026-09-30', {});
const b4 = {}; r4.forEach(function (m) { b4[m.key] = m; });
eq('★ 只完成 sleep 未完成 nap → 自律小达人进度 0', b4['self_discipline'].progress, 0);

/* 累计类用"天数"不是"次数":一天勾 3 次阅读只算 1 天 */
const dupDay = [];
for (let i = 0; i < 3; i++) dupDay.push(ck('2026-09-30', 'reading', 3));
const r5 = M.evaluate(dupDay, '2026-09-30', {});
const b5 = {}; r5.forEach(function (m) { b5[m.key] = m; });
eq('★ 同一天勾 3 次阅读 → 阅读小明星只算 1 天', b5['reading'].progress, 1);

console.log('=== 4. 已解锁勋章永久保留 ===');

/* 已解锁的勋章:即使现在数据不达标,也必须显示为已获得 */
const earned = { reading: true };
const r6 = M.evaluate(few, '2026-09-30', earned);
const b6 = {}; r6.forEach(function (m) { b6[m.key] = m; });
ok('★ 数据不达标但已解锁 → 仍显示已获得', b6['reading'].unlocked);
eq('★ 已解锁进度直接顶到 target', b6['reading'].progress, 30);
eq('★ 已解锁文案', b6['reading'].progressText, '已获得');

console.log('=== 5. 新解锁检测 ===');
const newly = M.newlyUnlocked(many, today, { homework: true });
ok('已有 homework → 不在新解锁列表', newly.indexOf('homework') < 0);
ok('daily_streak → 在新解锁列表', newly.indexOf('daily_streak') >= 0);
eq('新解锁共 4 枚', newly.length, 4);

console.log('=== 6. 家长 PIN ===');

const sec = P.setPin('1234');
ok('hash 不是明文', sec.hash !== '1234' && sec.hash.length === 64);
ok('有随机盐', !!sec.salt && sec.salt.length === 32);

/* 两个相同 PIN 的盐必须不同(否则彩虹表可破) */
const sec2 = P.setPin('1234');
ok('★ 相同 PIN 两次生成不同盐', sec.salt !== sec2.salt);
ok('★ 相同 PIN 两次生成不同 hash', sec.hash !== sec2.hash);

const child = { parentPin: sec };

/* 正确 PIN */
let v = P.verifyPin(child, '1234');
ok('正确 PIN 通过', v.ok);
eq('正确 PIN 不产生错误码', v.code, undefined);
/* ★ 返回值已改为**完整的 parentPin 对象**(2026-09-23)。
   旧写法返回局部 patch,云函数里 `Object.assign({}, child.parentPin, v.patch)`
   在 parentPin 为 null 时会丢掉 hash/salt;直接写子字段又会报
   `Cannot create field 'attempts' in element {parentPin: null}`。 */
ok('正确 PIN 会重置尝试次数', v.parentPin.attempts === 0);
/* ★ 守住"丢字段"那个坑:返回值必须带完整的 hash/salt,不能只是改动的几个字段 */
ok('★ 正确 PIN 返回值保留 hash', v.parentPin.hash === sec.hash);
ok('★ 正确 PIN 返回值保留 salt', v.parentPin.salt === sec.salt);

/* 错误 PIN */
v = P.verifyPin(child, '0000');
ok('错误 PIN 拒绝', !v.ok);
eq('错误 PIN 码', v.code, 'PIN_WRONG');
eq('错误 PIN 计数 +1', v.parentPin.attempts, 1);
ok('★ 错误 PIN 返回值保留 hash', v.parentPin.hash === sec.hash);
ok('★ 错误 PIN 返回值保留 salt', v.parentPin.salt === sec.salt);

/* ★★ parentPin 为 null 时(刚创建的孩子)必须给出可直接入库的返回值:
   既不能返回 patch(调用方 Object.assign 后会丢字段),也不能真的去写子字段。
   这是 2026-09-23 线上报错 `Cannot create field 'attempts' in element {parentPin: null}` 的源头。 */
const vNull = P.verifyPin({ parentPin: null }, '1234');
eq('★ parentPin 为 null → 标记为未设密码', vNull.code, 'NO_PIN_SET');
eq('★ parentPin 为 null → 返回值也是 null(调用方跳过写库)', vNull.parentPin, null);
ok('★ parentPin 为 null 时不返回 patch', vNull.patch === undefined);

/* 格式非法 */
/* ★ 空密码必须与"密码错"分开(2026-09-23,一次线上事故):
   首页「手动加减分」漏传 pin,结果被当成输错并累计次数,连试 5 次把家长锁死。
   现在空值一律 PIN_REQUIRED,且**不产生可写回的 parentPin**(即不计数)。 */
v = P.verifyPin(child, '');
eq('★ 空 PIN → PIN_REQUIRED(不是 PIN_WRONG)', v.code, 'PIN_REQUIRED');
ok('★ 空 PIN 不产生可写回的 parentPin(不计数)', v.parentPin === null);
v = P.verifyPin(child, undefined);
eq('★ 完全没传 pin → 同样是 PIN_REQUIRED', v.code, 'PIN_REQUIRED');
v = P.verifyPin(child, '   ');
eq('★ 纯空格也算没带密码', v.code, 'PIN_REQUIRED');
v = P.verifyPin(child, 'ab12');
eq('非数字 PIN 拒绝', v.code, 'PIN_WRONG');
v = P.verifyPin(child, '123456');
eq('6 位 PIN 拒绝', v.code, 'PIN_WRONG');

/* 连续错 5 次锁定 —— ★ 必须把每次的 patch 写回去,否则计数永远是 1 */
let c2 = { parentPin: P.setPin('1234') };
let lockRes = null;
for (let i = 0; i < 5; i++) {
  lockRes = P.verifyPin(c2, '9999', 1000);
  /* ★ 整体替换,而不是把改动合并回旧对象 —— 与云函数里的写法保持一致 */
  if (lockRes.parentPin) c2.parentPin = lockRes.parentPin;
}
ok('连错 5 次触发锁定', !!(lockRes.parentPin && lockRes.parentPin.lockedUntil));
eq('锁定时长为 10 分钟', lockRes.parentPin.lockedUntil - 1000, 10 * 60 * 1000);
eq('锁定时尝试次数归零(解锁后重新数)', lockRes.parentPin.attempts, 0);
ok('★ 锁定后返回值仍需保留 hash', lockRes.parentPin.hash === c2.parentPin.hash);

/* 第 4 次还不该锁 */
let c3 = { parentPin: P.setPin('1234') };
let r4th = null;
for (let i = 0; i < 4; i++) {
  r4th = P.verifyPin(c3, '9999', 1000);
  if (r4th.parentPin) c3.parentPin = r4th.parentPin;
}
ok('只错 4 次不锁定', !r4th.parentPin.lockedUntil);
eq('错 4 次后计数为 4', r4th.parentPin.attempts, 4);

/* 锁定期间即使输对也拒绝 */
const lockedChild = { parentPin: Object.assign({}, c2.parentPin, {
  attempts: 0, lockedUntil: 1000 + 10 * 60 * 1000 }) };
v = P.verifyPin(lockedChild, '1234', 2000);
ok('★ 锁定期间正确 PIN 也被拒', !v.ok);
eq('★ 锁定错误码', v.code, 'PIN_LOCKED');
ok('★ 返回剩余毫秒', typeof v.remainMs === 'number' && v.remainMs > 0);

/* 锁定过期后恢复 */
v = P.verifyPin(lockedChild, '1234', 1000 + 10 * 60 * 1000 + 1);
ok('锁定期满后正确 PIN 可进', v.ok);

/* 没设过 PIN */
v = P.verifyPin({}, '1234');
ok('未设置 PIN → 放行(由调用方引导设置)', v.ok);
eq('未设置 PIN 的码', v.code, 'NO_PIN_SET');

/* ★★ 密码数据损坏:有 hash、没有 salt
   这不是假想的边界 —— 2026-09-23 用户云开发控制台截图里的 children 记录
   就长这样:`parentPin: { attempts: 0, hash: '2d4886e6…' }`。
   少了 salt 之后 hashPin() 会现场随机生成盐,算出的 hash 永远对不上
   ⇒ 任何密码都判错 ⇒ 连错 5 次锁 10 分钟 ⇒ 家长被永久锁在门外
   ——而且他压根没设过密码。所以必须能识别出来并允许重设。 */
const broken = { parentPin: { attempts: 0, hash: '2d4886e6a28e458d4ddb15314de27ca5' } };
ok('★ 只有 hash 没有 salt → pinUsable 为 false', P.pinUsable(broken) === false);
ok('★ 正常密码 → pinUsable 为 true', P.pinUsable(child) === true);
ok('★ 没设过密码 → pinUsable 为 false', P.pinUsable({ parentPin: null }) === false);
ok('★ 空对象也算没设', P.pinUsable({}) === false);

v = P.verifyPin(broken, '1234');
ok('★ 损坏的密码数据 → 拒绝', !v.ok);
eq('★ 损坏的密码数据 → PIN_BROKEN', v.code, 'PIN_BROKEN');
ok('★ 损坏时不产生可写回的 parentPin(不计数、不锁人)', v.parentPin === null);

console.log('=== 7. 孩子模式字段剥离 ===');
const raw = { nickname: '然然', availablePoints: 10, parentPin: sec, penaltyLimit: 15 };
const stripped = P.stripForChildMode(raw);
ok('★ 剥离 parentPin', stripped.parentPin === undefined);
ok('★ 剥离 penaltyLimit', stripped.penaltyLimit === undefined);
ok('保留昵称', stripped.nickname === '然然');
ok('保留可用积分', stripped.availablePoints === 10);
ok('原对象未被改动', raw.parentPin !== undefined);

console.log('=== 8. 周报模板 ===');

const rep = R.buildWeeklyReport({
  thisWeek: {
    '认真完成学校作业': { days: 6, category: 'study', score: 5 },
    '每日阅读20分钟':   { days: 4, category: 'study', score: 3 },
    '写作业拖拉磨蹭':   { days: 2, category: 'study', score: -3 }
  },
  lastWeek: {
    '认真完成学校作业': { days: 3, category: 'study', score: 5 },
    '每日阅读20分钟':   { days: 5, category: 'study', score: 3 },
    '写作业拖拉磨蹭':   { days: 4, category: 'study', score: -3 }
  },
  netPoints: 30, bonusTotal: 44, penaltyTotal: 14,
  checkinDays: 6, weekLabel: '9月15日–9月21日'
});

ok('周报非空', !rep.empty);
ok('头部提到坚持', rep.headline.indexOf('坚持') >= 0 || rep.headline.indexOf('每天') >= 0);
ok('有"做得好的地方"', rep.lines.some(function (l) { return l.kind === 'good'; }));
ok('有积分概览', rep.lines.some(function (l) { return l.kind === 'stat'; }));

/* 作业从 3 天涨到 6 天 → 应出现"比上周多做了 3 天" */
const joinedAll = rep.lines.map(function (l) { return l.text; }).join(' | ');
ok('★ 进步项写明增量', joinedAll.indexOf('多做了 3 天') >= 0, joinedAll);
/* 扣分项从 4 次降到 2 次 → 走的是"变好"分支,归在 good */
ok('★ 退步的扣分项被识别为"在变好"', joinedAll.indexOf('少了 2 次') >= 0, joinedAll);
ok('★ 有净得分数字', joinedAll.indexOf('净得 +30 分') >= 0, joinedAll);

/* ★ 真正触发 watch 分支:扣分次数比上周多,且 ≥3 次 */
const rep2 = R.buildWeeklyReport({
  thisWeek: {
    '认真完成学校作业': { days: 5, category: 'study', score: 5 },
    '乱发脾气、哭闹顶嘴': { days: 4, category: 'moral', score: -4 },
    '写作业拖拉磨蹭':   { days: 1, category: 'study', score: -3 }
  },
  lastWeek: {
    '认真完成学校作业': { days: 5, category: 'study', score: 5 },
    '乱发脾气、哭闹顶嘴': { days: 2, category: 'moral', score: -4 },
    '写作业拖拉磨蹭':   { days: 1, category: 'study', score: -3 }
  },
  netPoints: 10, bonusTotal: 25, penaltyTotal: 18, checkinDays: 5
});
const j2 = rep2.lines.map(function (l) { return l.text; }).join(' | ');
ok('★ 变差的扣分项(本周4次上周2次)→ watch', j2.indexOf('帮一帮') >= 0, j2);
ok('★ 只犯 1 次的扣分项 → 安抚口吻', j2.indexOf('不用太在意') >= 0, j2);
ok('★ 稳定项提示"和上周一样"', j2.indexOf('一样稳定') >= 0, j2);

/* 空状态 */
const empty = R.buildWeeklyReport({ thisWeek: {}, lastWeek: {}, checkinDays: 0,
  netPoints: 0, bonusTotal: 0, penaltyTotal: 0 });
ok('空数据 → empty 标记', empty.empty);
eq('空数据头部', empty.headline, '这周还没有打卡记录');
ok('空数据仍有兜底文案', empty.lines.length === 1);

/* 只有 2 天打卡时的头部 */
const light = R.buildWeeklyReport({ thisWeek: {}, lastWeek: {}, checkinDays: 2,
  netPoints: 5, bonusTotal: 5, penaltyTotal: 0 });
ok('2 天 → 鼓励性头部', light.headline.indexOf('下周') >= 0, light.headline);

console.log('=== 9. 常量一致性(前后端两份副本必须相等) ===');

const FE = require(path.join(__dirname, '..', 'src', 'config.js'));

eq('★ 勋章数量一致', FE.MEDALS.length, C.MEDALS.length);
FE.MEDALS.forEach(function (m, i) {
  const be = C.MEDALS[i];
  ok('勋章[' + m.key + '] key 一致', m.key === be.key);
  ok('勋章[' + m.key + '] 阈值一致', m.threshold === be.threshold);
  ok('勋章[' + m.key + '] 类型一致', m.type === be.type);
});

eq('★ 预设任务数量一致', FE.PRESET_TASKS.length, C.PRESET_TASKS.length);
FE.PRESET_TASKS.forEach(function (t, i) {
  const be = C.PRESET_TASKS[i];
  ok('预设[' + i + '] ' + t.name + ' 分值一致', t.score === be.score,
     t.score + ' vs ' + be.score);
  ok('预设[' + i + '] ' + t.name + ' tag 一致', (t.medalTag || '') === (be.medalTag || ''));
});

eq('★ 奖励数量一致', FE.PRESET_REWARDS.length, C.PRESET_REWARDS.length);
eq('★ 上限默认值一致', FE.PENALTY_LIMIT.def, C.PENALTY_LIMIT.def);
eq('★ 断签次数一致', FE.STREAK_ALLOW_BREAK, C.STREAK_ALLOW_BREAK);

const tagSet = new Set(C.VALID_MEDAL_TAGS);
FE.PRESET_TASKS.forEach(function (t) {
  if (t.medalTag) ok('预设 tag「' + t.medalTag + '」在白名单内', tagSet.has(t.medalTag));
});
C.MEDALS.forEach(function (m) {
  const ts = m.tags || (m.tag ? [m.tag] : []);
  ts.forEach(function (t) { ok('勋章 ' + m.key + ' 引用的 tag「' + t + '」在白名单内', tagSet.has(t)); });
});

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); fails.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
else console.log('  ✓ 全部通过');
