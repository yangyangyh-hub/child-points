/* 部署副本"可加载性"验证：模拟微信云函数运行时的 require 行为
   云函数上传后，运行时从函数目录根部执行 require('./index')。
   本脚本对 cloudfunctions/ 下每个函数做同样的事，用桩替换 wx-server-sdk，
   验证：模块能加载、导出的是函数、常量口径与前端一致。 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DEPLOY = path.join(ROOT, 'cloudfunctions');

let pass = 0, fail = 0; const fails = [];
function ok(n, c, e) { if (c) pass++; else { fail++; fails.push(n + (e ? ' → ' + e : '')); } }

/* 去掉注释再扫,避免注释里的举例被当成代码(这是本项目的既定铁律) */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/* 桩：wx-server-sdk 在本地不存在，用最小实现替代 */
const stubDb = {
  collection: function () {
    return {
      where: function () { return this; },
      orderBy: function () { return this; },
      limit: function () { return this; },
      skip: function () { return this; },
      field: function () { return this; },
      get: function () { return Promise.resolve({ data: [] }); },
      count: function () { return Promise.resolve({ total: 0 }); },
      add: function () { return Promise.resolve({ _id: 'stub' }); },
      doc: function () { return { get: function () { return Promise.resolve({ data: null }); }, update: function () { return Promise.resolve({}); }, set: function () { return Promise.resolve({}); }, remove: function () { return Promise.resolve({}); } }; }
    };
  },
  runTransaction: function (fn) { return fn({}); },
  serverDate: function () { return new Date(); },
  command: { inc: function (v) { return { $inc: v }; }, set: function (v) { return v; } }
};
const stub = {
  init: function () {
    return {
      database: function () { return stubDb; },
      getWXContext: function () { return { OPENID: 'stub-openid', APPID: 'wxstub' }; },
      DYNAMIC_CURRENT_ENV: 'stub-env',
      uploadFile: function () { return Promise.resolve({ fileID: 'cloud://stub' }); },
      deleteFile: function () { return Promise.resolve({}); }
    };
  },
  database: function () { return stubDb; },
  getWXContext: function () { return { OPENID: 'stub-openid', APPID: 'wxstub' }; },
  DYNAMIC_CURRENT_ENV: 'stub-env'
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return 'wx-server-sdk';
  return origResolve.call(this, request, parent, isMain, options);
};
require.cache['wx-server-sdk'] = { id: 'wx-server-sdk', filename: 'wx-server-sdk', loaded: true, exports: stub };

console.log('\n=== 部署副本可加载性验证 ===\n');

const fns = fs.readdirSync(DEPLOY).filter(function (d) {
  return d !== '_shared' && fs.statSync(path.join(DEPLOY, d)).isDirectory();
}).sort();

fns.forEach(function (name) {
  const entry = path.join(DEPLOY, name, 'index.js');
  ok(name + ' 入口存在', fs.existsSync(entry));
  if (!fs.existsSync(entry)) return;
  try {
    const mod = require(entry);
    ok(name + ' 可 require 加载', true);
    const fn = typeof mod === 'function' ? mod : (mod && (mod.main || mod.handler));
    ok(name + ' 导出的是可调用函数', typeof fn === 'function',
       '实际类型 ' + typeof fn + '，导出键 ' + Object.keys(mod || {}).join(','));
  } catch (e) {
    ok(name + ' 可 require 加载', false, e.message);
  }
});

/* 常量口径：服务端 constants 与前端 config 的关键数值必须一致。
   这两份常量是**物理重复**的(云函数用不到前端文件,前端用不到 _shared),
   所以唯一能防漂移的手段就是在这里对账。 */
console.log('');
try {
  const C = require(path.join(DEPLOY, '_shared', 'constants.js'));
  const F = require(path.join(ROOT, 'src', 'config.js'));

  /* --- 服务端自身结构 --- */
  ok('[服务端] MEDALS 已定义', Array.isArray(C.MEDALS) && C.MEDALS.length > 0,
     (C.MEDALS || []).length + ' 枚');
  ok('[服务端] PRESET_TASKS 已定义', Array.isArray(C.PRESET_TASKS) && C.PRESET_TASKS.length > 0,
     (C.PRESET_TASKS || []).length + ' 条');
  ok('[服务端] PRESET_REWARDS 已定义', Array.isArray(C.PRESET_REWARDS) && C.PRESET_REWARDS.length > 0,
     (C.PRESET_REWARDS || []).length + ' 项');
  ok('[服务端] PENALTY_LIMIT 范围 1-30',
     C.PENALTY_LIMIT && C.PENALTY_LIMIT.min === 1 && C.PENALTY_LIMIT.max === 30,
     JSON.stringify(C.PENALTY_LIMIT));
  ok('[服务端] PENALTY_LIMIT 默认值合法(1-30 之间)',
     C.PENALTY_LIMIT && C.PENALTY_LIMIT.def >= 1 && C.PENALTY_LIMIT.def <= 30,
     '默认 ' + (C.PENALTY_LIMIT || {}).def);
  ok('[服务端] STREAK_ALLOW_BREAK = 1(允许断签 1 次)',
     C.STREAK_ALLOW_BREAK === 1, String(C.STREAK_ALLOW_BREAK));
  ok('[服务端] ERR 错误码齐全', C.ERR && C.ERR.PIN_REQUIRED && C.ERR.PENALTY_LIMIT && C.ERR.NOT_ENOUGH,
     Object.keys(C.ERR || {}).join(','));
  ok('[服务端] ERR_MSG 与 ERR 一一对应',
     Object.keys(C.ERR || {}).every(function (k) { return typeof C.ERR_MSG[k] === 'string'; }),
     '缺:' + Object.keys(C.ERR || {}).filter(function (k) { return typeof C.ERR_MSG[k] !== 'string'; }).join(','));

  /* --- 跨层对账:集合名 ---
     服务端的 COLL 多一个 records 别名(历史写法,指向 point_records),
     比对时把它排除掉,只看真正的 8 张表。 */
  const ALIAS = ['records'];
  const cKeys = Object.keys(C.COLL || {}).filter(function (k) { return ALIAS.indexOf(k) < 0; }).sort();
  const fKeys = Object.keys(F.COLL || {}).sort();
  ok('[对账] 集合名键一致', JSON.stringify(cKeys) === JSON.stringify(fKeys),
     '服务端[' + cKeys.join(',') + '] 前端[' + fKeys.join(',') + ']');
  ok('[对账] 集合名值一致',
     cKeys.every(function (k) { return C.COLL[k] === F.COLL[k]; }),
     cKeys.filter(function (k) { return C.COLL[k] !== F.COLL[k]; }).join(','));
  ok('[对账] 集合共 8 张', cKeys.length === 8, cKeys.length + ' 张');
  ok('[对账] records 别名指向 point_records',
     C.COLL.records === C.COLL.points && C.COLL.records === 'point_records',
     String(C.COLL.records));

  /* --- 跨层对账:分类标签 --- */
  const cCat = Object.keys(C.CAT_LABEL || {}).sort();
  const fCat = (F.CATEGORIES || []).map(function (x) { return x.key; }).sort();
  ok('[对账] 任务分类键一致', JSON.stringify(cCat) === JSON.stringify(fCat),
     '服务端[' + cCat.join(',') + '] 前端[' + fCat.join(',') + ']');
  ok('[对账] 任务分类共 6 类', fCat.length === 6, fCat.length + ' 类');

  /* --- 跨层对账:勋章键 --- */
  const cMedal = (C.MEDALS || []).map(function (m) { return m.key; }).sort();
  const fMedal = (F.MEDALS || []).map(function (m) { return m.key; }).sort();
  ok('[对账] 勋章键一致(前端)',
     JSON.stringify(cMedal) === JSON.stringify(fMedal),
     fMedal.length ? '服务端[' + cMedal.join(',') + '] 前端[' + fMedal.join(',') + ']' : '前端未定义 MEDALS');

  /* --- 跨层对账:惩罚上限 --- */
  ok('[对账] PENALTY_LIMIT 前后端一致',
     JSON.stringify(C.PENALTY_LIMIT) === JSON.stringify(F.PENALTY_LIMIT),
     '服务端' + JSON.stringify(C.PENALTY_LIMIT) + ' 前端' + JSON.stringify(F.PENALTY_LIMIT));

  /* --- 跨层对账:断签容忍 --- */
  ok('[对账] STREAK_ALLOW_BREAK 前后端一致',
     C.STREAK_ALLOW_BREAK === F.STREAK_ALLOW_BREAK,
     '服务端' + C.STREAK_ALLOW_BREAK + ' 前端' + F.STREAK_ALLOW_BREAK);

  /* --- 跨层对账:奖励档位 ---
     ★ 2026-09-23 补,这是"漏网之鱼"的直接补丁:
     `functions/rewardList/index.js` 用了 `C.REWARD_TIERS`,
     而服务端 constants.js 当时**没有**这个常量(它只在前端 config.js 里)
     ⇒ `undefined.filter(...)` 抛 TypeError ⇒ **整个奖励页永远「加载失败,请重试。」**,
     用户完全用不了奖励/兑换。 */
  ok('[对账] REWARD_TIERS 前后端一致',
     JSON.stringify(C.REWARD_TIERS) === JSON.stringify(F.REWARD_TIERS),
     '服务端' + JSON.stringify(C.REWARD_TIERS) + ' 前端' + JSON.stringify(F.REWARD_TIERS));
  ok('[对账] REWARD_TIERS 是 small/large 两档',
     Array.isArray(C.REWARD_TIERS) && C.REWARD_TIERS.length === 2 &&
     C.REWARD_TIERS[0].key === 'small' && C.REWARD_TIERS[1].key === 'large');

  /* 同批漏网的另外两个,一起对上账 */
  ok('[对账] GRADES 前后端一致',
     JSON.stringify(C.GRADES) === JSON.stringify(F.GRADES),
     '服务端' + JSON.stringify(C.GRADES) + ' 前端' + JSON.stringify(F.GRADES));
  ok('[对账] COLUMNS 前后端一致',
     JSON.stringify(C.COLUMNS) === JSON.stringify(F.COLUMNS),
     '服务端' + JSON.stringify(C.COLUMNS) + ' 前端' + JSON.stringify(F.COLUMNS));

  /* --- ★★ 通用防漏:云函数里引用的 C.XXX 必须真的在 constants.js 里定义 ---
     ★ 上面那条治标,这条治本。
     原有的跨层对账只比"两边**都有**的键",所以查不出
     "服务端引用了、但服务端根本没定义"这种漏网 —— 本次奖励页就是这么崩的。
     做法:扫 functions/ 下每个云函数源码里出现的 `C.<名字>`,逐个回查定义。 */
  const constNames = Object.keys(C);
  const constRefs = {};
  fs.readdirSync(path.join(ROOT, 'functions')).forEach(function (name) {
    const p = path.join(ROOT, 'functions', name, 'index.js');
    if (!fs.existsSync(p)) return;
    const code = stripComments(fs.readFileSync(p, 'utf8'));
    const re = /\bC\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(code))) constRefs[m[1]] = name;
  });
  const refKeys = Object.keys(constRefs);
  const missConst = refKeys.filter(function (k) { return constNames.indexOf(k) < 0; });
  ok('[对账] 云函数引用的 C.xxx 全部在 constants.js 里有定义',
     missConst.length === 0,
     missConst.length
       ? missConst.map(function (k) { return 'C.' + k + '(没定义,见 ' + constRefs[k] + ')'; }).join('; ')
       : '共检查 ' + refKeys.length + ' 个引用: ' + refKeys.join(','));

} catch (e) {
  ok('加载 constants.js / config.js', false, e.message);
}

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); fails.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
else console.log('  ✓ 全部通过');
