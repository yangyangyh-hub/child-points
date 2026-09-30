/* 测试 · resetAll(清空所有数据)

   运行:node tests/resetAll.test.js

   ★ 为什么值得单独测
     这是整个项目**唯一不可逆**的操作,而且"删不干净"和"删错人"都不会报错:
       - 漏删一张表 ⇒ 用户以为清空了,过两天发现旧数据还在(静默失败);
       - 删到别人的数据 ⇒ 单孩子项目里看不出来,将来多用户就是事故。
     这两类错误编译器不报、界面不报,只有断言能抓住。

   ★ 为什么用"内存假库 + 真实 require"
     复刻一份算法来测(像 taskToggle.test.js 那样)对本函数不成立 ——
     这个函数的价值**就是**它对数据库做了什么,不测真实调用等于没测。
     所以用桩替换 wx-server-sdk,真实加载 cloudfunctions/resetAll/index.js。 */

'use strict';

const path = require('path');
const Module = require('module');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OPENID = 'op-me';
const OTHER = 'op-other';

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); }
}

/* ================= 内存数据库桩 ================= */

function match(doc, q) {
  if (!q) return true;
  const keys = Object.keys(q);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = q[k];
    if (v && v.__in) {
      if (v.__in.indexOf(doc[k]) < 0) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

/* 记录"哪张表真的被 remove 过" —— 用例 8 靠它做覆盖检查。
   ★ 为什么不扫源码字符串:point_records / medal_records 这些名字来自
     constants.js 的 C.COLL.points / C.COLL.medals,源码里**根本没有**这个字面量,
     扫字符串会漏 —— 这就是本项目反复强调的"断言要覆盖语义,不能只查形状"。 */
let REMOVED = [];

function createDb(state) {
  return {
    collection(name) {
      if (!state[name]) state[name] = [];
      let filter = null;
      let limitN = Infinity;
      const api = {
        where(q) { filter = q; return api; },
        field() { return api; },
        orderBy() { return api; },
        skip() { return api; },
        limit(n) { limitN = n; return api; },
        get() {
          const list = state[name].filter(function (d) { return match(d, filter); });
          const out = (limitN === Infinity) ? list : list.slice(0, limitN);
          return Promise.resolve({ data: out.map(function (d) { return Object.assign({}, d); }) });
        },
        remove() {
          const keep = state[name].filter(function (d) { return !match(d, filter); });
          const n = state[name].length - keep.length;
          state[name] = keep;
          if (n > 0 && REMOVED.indexOf(name) < 0) REMOVED.push(name);
          return Promise.resolve({ stats: { removed: n } });
        },
        add(o) {
          state[name].push(Object.assign({ _id: 'new-' + name }, o.data || {}));
          return Promise.resolve({ _id: 'new-' + name });
        },
        count() { return Promise.resolve({ total: state[name].length }); },
        doc(id) {
          return {
            get() {
              const d = state[name].filter(function (x) { return x._id === id; })[0] || null;
              return Promise.resolve({ data: d ? Object.assign({}, d) : null });
            },
            update(o) {
              const d = state[name].filter(function (x) { return x._id === id; })[0];
              if (d) {
                Object.keys(o.data || {}).forEach(function (k) {
                  const v = o.data[k];
                  /* _.set(x) 的桩是 {__set:x} —— 代表"整个字段替换成这个对象" */
                  d[k] = (v && Object.prototype.hasOwnProperty.call(v, '__set')) ? v.__set : v;
                });
              }
              return Promise.resolve({ stats: { updated: 1 } });
            },
            set(o) {
              const d = Object.assign({}, o.data || {});
              d._id = id;
              state[name] = state[name].filter(function (x) { return x._id !== id; });
              state[name].push(d);
              return Promise.resolve({ _id: id });
            },
            remove() {
              state[name] = state[name].filter(function (x) { return x._id !== id; });
              return Promise.resolve({ stats: { removed: 1 } });
            }
          };
        }
      };
      return api;
    },
    command: {
      in(ids) { return { __in: ids }; },
      set(v) { return { __set: v }; },
      inc(v) { return { __inc: v }; }
    },
    serverDate() { return new Date(); },
    runTransaction(fn) { return fn(this); }
  };
}

/* ================= 替换 wx-server-sdk ================= */

let currentDb = null;
let deleteCalls = [];

const stub = {
  init() {},
  DYNAMIC_CURRENT_ENV: 'stub-env',
  database() { return currentDb; },
  getWXContext() { return { OPENID: OPENID, APPID: 'wxstub' }; },
  deleteFile(o) {
    deleteCalls.push((o && o.fileList) || []);
    return Promise.resolve({ fileList: (o && o.fileList) || [] });
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return 'wx-server-sdk';
  return origResolve.call(this, request, parent, isMain, options);
};
require.cache['wx-server-sdk'] = {
  id: 'wx-server-sdk', filename: 'wx-server-sdk', loaded: true, exports: stub
};

/* ================= 加载被测云函数 ================= */

/* ★ 关键:云函数在**模块加载时**就执行 `const db = cloud.database()` 且只取一次。
   所以桩必须在 require 之前就绪,并且底层的 state 对象**从头到尾是同一个** ——
   每个用例只换内容(清掉旧键再填新的),绝不换引用,否则函数里那个 db 会一直
   指向第一份数据。这个坑是"桩的生命周期"问题,跟被测代码无关。 */
const STATE = {};
currentDb = createDb(STATE);

function resetTo(data) {
  Object.keys(STATE).forEach(function (k) { delete STATE[k]; });
  Object.assign(STATE, data);
  return STATE;
}

const ENTRY = path.join(ROOT, 'cloudfunctions', 'resetAll', 'index.js');
const resetAll = require(ENTRY).main;

/* 用共享模块自己生成一份"真的设过密码"的数据 —— 别手搓 hash/salt */
const pinMod = require(path.join(ROOT, 'cloudfunctions', '_shared', 'pin.js'));

/* 十张表(与 _shared/constants.js 的 COLL + achievement 的 scores/honors 对齐) */
const ALL_COLLS = [
  'children', 'tasks', 'checkins', 'point_records', 'redemptions',
  'rewards', 'medal_records', 'logs', 'scores', 'honors'
];

/**
 * 造一份"有孩子、各表都有数据"的初始状态。
 * 每张表都同时放一条**别人的**数据 —— 用来验证"只删自己的"。
 */
function freshState(withPin) {
  const child = {
    _id: 'c1',
    _openid: OPENID,
    nickname: '小宝',
    avatar: 'cloud://env/avatar/a.png',
    parentPin: withPin ? pinMod.setPin('1234') : null
  };
  const s = { children: [child] };
  ALL_COLLS.forEach(function (c) {
    if (c === 'children') return;
    s[c] = [{ _id: c + '-1', _openid: OPENID }, { _id: c + '-2', _openid: OPENID }];
  });
  s.honors.push({ _id: 'h-other', _openid: OTHER, photo: 'cloud://env/honor/x.png' });
  s.honors[0].photo = 'cloud://env/honor/mine.png';
  s.tasks.push({ _id: 't-other', _openid: OTHER });
  return s;
}

function countBy(state, openid) {
  const out = {};
  ALL_COLLS.forEach(function (c) {
    out[c] = (state[c] || []).filter(function (d) { return d._openid === openid; }).length;
  });
  return out;
}

/* ================= 用例 ================= */

function run(name, fn) {
  return fn().then(function () { console.log('  ✓ ' + name); })
    .catch(function (e) { console.log('  ✗ ' + name + ' → ' + e.message); throw e; });
}

(async function main() {
  console.log('\n=== resetAll · 清空所有数据 ===\n');

  /* ---------- 1. 不带 confirm 必须拒绝,且一个字都不许删 ---------- */
  await run('不带 confirm 直接拒绝', async function () {
    const state = resetTo(freshState(true));
    currentDb = createDb(state);
    deleteCalls = [];
    const before = countBy(state, OPENID);
    const r = await resetAll({ pin: '1234' });
    ok('不带 confirm → ok=false', r.ok === false);
    ok('不带 confirm → 提示需要确认', r.code === 'INVALID' && r.needConfirm === true, JSON.stringify(r));
    const after = countBy(state, OPENID);
    ok('不带 confirm → 一张表都没动',
      JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify(after));
  });

  /* ---------- 2. 没设过家长密码 → 拒绝(不留后门) ---------- */
  await run('没设家长密码 → 拒绝执行', async function () {
    const state = resetTo(freshState(false));
    currentDb = createDb(state);
    deleteCalls = [];
    const r = await resetAll({ confirm: true, pin: '1234' });
    ok('没密码 → ok=false', r.ok === false);
    ok('没密码 → code=PIN_REQUIRED', r.code === 'PIN_REQUIRED', JSON.stringify(r));
    ok('没密码 → 没删任何数据',
      countBy(state, OPENID).children === 1 && countBy(state, OPENID).tasks === 2);
  });

  /* ---------- 3. 密码错 → 拒绝,且记一次错误次数 ---------- */
  await run('密码错 → 拒绝且计数', async function () {
    const state = resetTo(freshState(true));
    currentDb = createDb(state);
    deleteCalls = [];
    const r = await resetAll({ confirm: true, pin: '0000' });
    ok('密码错 → ok=false', r.ok === false);
    ok('密码错 → code=PIN_WRONG', r.code === 'PIN_WRONG', JSON.stringify(r));
    ok('密码错 → 数据还在', countBy(state, OPENID).children === 1);
    ok('密码错 → 错误次数被写回(锁定才有意义)',
      state.children[0].parentPin.attempts === 1,
      JSON.stringify(state.children[0].parentPin));
    ok('密码错 → hash/salt 没被写坏(非 undefined)',
      !!state.children[0].parentPin.hash && !!state.children[0].parentPin.salt);
  });

  /* ---------- 4. 密码对 → 十张表全清 ---------- */
  await run('密码对 → 十张表全部清空', async function () {
    const state = resetTo(freshState(true));
    currentDb = createDb(state);
    deleteCalls = [];
    const r = await resetAll({ confirm: true, pin: '1234' });
    ok('密码对 → ok=true', r.ok === true, JSON.stringify(r));
    const mine = countBy(state, OPENID);
    ALL_COLLS.forEach(function (c) {
      ok('密码对 → ' + c + ' 里我的数据已清空', mine[c] === 0, '还剩 ' + mine[c]);
    });
  });

  /* ---------- 5. 别人的数据一条都不许动 ---------- */
  await run('只删自己的,不动别人的', async function () {
    const state = resetTo(freshState(true));
    currentDb = createDb(state);
    deleteCalls = [];
    await resetAll({ confirm: true, pin: '1234' });
    ok('别人的 tasks 还在',
      state.tasks.filter(function (d) { return d._openid === OTHER; }).length === 1);
    ok('别人的 honors 还在',
      state.honors.filter(function (d) { return d._openid === OTHER; }).length === 1);
  });

  /* ---------- 6. 云存储里的图片要一起删(头像 + 荣誉照片) ---------- */
  await run('云存储图片一并清理', async function () {
    const state = resetTo(freshState(true));
    currentDb = createDb(state);
    deleteCalls = [];
    const r = await resetAll({ confirm: true, pin: '1234' });
    const files = deleteCalls.length ? deleteCalls[0] : [];
    ok('头像被送去删除', files.indexOf('cloud://env/avatar/a.png') >= 0, JSON.stringify(files));
    ok('自己的荣誉照片被送去删除',
      files.indexOf('cloud://env/honor/mine.png') >= 0, JSON.stringify(files));
    ok('别人的照片**没有**被删',
      files.indexOf('cloud://env/honor/x.png') < 0, JSON.stringify(files));
    ok('removedFiles 计数正确', r.removedFiles === 2, String(r.removedFiles));
  });

  /* ---------- 7. 没有孩子时:不该卡住,且仍把残留数据清掉 ---------- */
  await run('没有孩子 → 跳过密码、仍清残留', async function () {
    const state = resetTo(freshState(true));
    state.children = [];
    currentDb = createDb(state);
    deleteCalls = [];
    const r = await resetAll({ confirm: true });
    ok('没孩子也能执行(不被卡死)', r.ok === true, JSON.stringify(r));
    ok('没孩子 → 子表照样清干净', countBy(state, OPENID).tasks === 0);
  });

  /* ---------- 8. 十张表都真的被执行过删除(防将来新增集合漏清) ---------- */
  await run('清空清单覆盖全部 10 张表', async function () {
    const state = resetTo(freshState(true));
    REMOVED = [];
    await resetAll({ confirm: true, pin: '1234' });
    ALL_COLLS.forEach(function (c) {
      ok('真的对 ' + c + ' 执行过删除', REMOVED.indexOf(c) >= 0,
        '实际删过: ' + REMOVED.join(','));
    });
  });

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  if (fail) {
    console.log('  ✗ 失败项:');
    fails.forEach(function (f) { console.log('    - ' + f); });
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过');
  }
})();
