/* 云函数一致性自检

   ★ 校验的是"将要被上传的那份",不是"我写的那份"
     源码在 functions/ ,部署副本在 cloudfunctions/ 。
     历史教训:只在 functions/ 里自测,而 cloudfunctions/ 是空的 ——
     本地全绿,上传时根本找不到函数。

   ★ 2026-09-23 起改为**单项目**方案:
     开发者工具打开【项目根 child-points/】这一层,
     miniprogramRoot = src/ ,cloudfunctionRoot = cloudfunctions/ ,
     一个窗口既能编译前端又能右键上传云函数。

   1) cloudfunctions/ 下每个函数目录存在,且其 index.js 能通过语法解析
   2) 部署副本与 functions/ 源码逐字节一致(含 _shared 副本)
   3) package.json 合法且声明了 wx-server-sdk
   4) 每个函数 require 的 _shared 模块都已复制进来且最新
   5) **项目根** project.config.json 的 cloudfunctionRoot 指向 cloudfunctions/
   6) 前端 lib/cloud.js 调用的云函数都已存在
   运行:  node tests/cloudCheck.js  */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'functions');       /* 源码(唯一真相) */
const DEPLOY_DIR = path.join(ROOT, 'cloudfunctions'); /* IDE 上传目录 */
const SHARED = path.join(DEPLOY_DIR, '_shared');

let pass = 0, fail = 0; const fails = [];
function ok(n, c, e) { if (c) pass++; else { fail++; fails.push(n + (e ? '  → ' + e : '')); } }

function md5(f) { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); }
function listDirs(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter(function (d) {
    return fs.statSync(path.join(p, d)).isDirectory();
  }).sort();
}

/* 收集代码里 require('./_shared/xxx') 的模块名(统一补 .js) */
function requiredShared(code) {
  const out = [];
  const re = /require\(\s*['"]\.\/_shared\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const f = m[1];
    out.push(/\.js$/.test(f) ? f : f + '.js');
  }
  return out;
}

/* 递归列出目录下所有文件的相对路径 */
function relFiles(dir, base) {
  base = base || dir;
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach(function (f) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      if (f === 'node_modules') return;
      out.push.apply(out, relFiles(p, base));
    } else out.push(path.relative(base, p).split(path.sep).join('/'));
  });
  return out.sort();
}

console.log('\n=== 云函数源码 / 部署副本一致性自检 ===\n');

/* ===== 0. 目录存在性 ===== */
ok('functions/ 源码目录存在', fs.existsSync(SRC_DIR));
ok('cloudfunctions/ 部署目录存在', fs.existsSync(DEPLOY_DIR));

const srcFns = listDirs(SRC_DIR).filter(function (d) { return d !== '_shared'; });
const deployFns = listDirs(DEPLOY_DIR).filter(function (d) { return d !== '_shared'; });
ok('源码里有云函数', srcFns.length > 0, srcFns.length + ' 个');
ok('部署目录里有云函数', deployFns.length > 0, deployFns.length + ' 个');

/* ===== 1. 项目根 project.config.json 的两个 Root 都指对 =====
   ★ 2026-09-23 改为单项目方案:
     开发者工具打开的是 **项目根 child-points/** 这一层,
     miniprogramRoot 指 src/ ,cloudfunctionRoot 指 cloudfunctions/ ,
     两者平级且都在项目根下 —— 这是官方文档推荐的布局。
     所以配置的唯一真相是**根目录**那个 project.config.json,
     不再是 src/ 里的那种(那两个是历史遗留,已不再用作入口)。 */
const ROOT_CFG = path.join(ROOT, 'project.config.json');
if (fs.existsSync(ROOT_CFG)) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(ROOT_CFG, 'utf8')); } catch (e) {}
  ok('项目根 project.config.json 可解析', !!j);
  if (j) {
    const norm = function (v) { return String(v || '').replace(/^\.\//, '').replace(/\/$/, ''); };
    ok('根配置 cloudfunctionRoot 指向 cloudfunctions',
       norm(j.cloudfunctionRoot) === 'cloudfunctions', norm(j.cloudfunctionRoot));
    ok('根配置 miniprogramRoot 指向 src',
       norm(j.miniprogramRoot) === 'src', norm(j.miniprogramRoot));
    ok('根配置 appid 正确',
       j.appid === 'wx2938ccdd9266f246', String(j.appid));
    ok('根配置 compileType = miniprogram',
       j.compileType === 'miniprogram', String(j.compileType));
    ok('miniprogramRoot 实际存在',
       fs.existsSync(path.join(ROOT, norm(j.miniprogramRoot))));
    ok('cloudfunctionRoot 实际存在',
       fs.existsSync(path.join(ROOT, norm(j.cloudfunctionRoot))));
    ok('miniprogramRoot 下有 app.json(否则工具认不出小程序)',
       fs.existsSync(path.join(ROOT, norm(j.miniprogramRoot), 'app.json')));
  }
} else {
  ok('项目根存在 project.config.json', false, '缺了它开发者工具会走"新建项目"流程');
}

/* ===== 2. 源码 ↔ 部署副本 双向对账 ===== */
srcFns.forEach(function (n) {
  ok('部署副本存在: ' + n, deployFns.indexOf(n) >= 0, '请跑 node tests/syncCloud.js');
});
deployFns.forEach(function (n) {
  ok('部署副本有源码: ' + n, srcFns.indexOf(n) >= 0, '孤儿目录,建议删除');
});

/* ===== 3. 逐函数深检 ===== */
const srcHashes = {};
if (fs.existsSync(SHARED)) {
  fs.readdirSync(SHARED).forEach(function (f) {
    if (f.endsWith('.js')) srcHashes[f] = md5(path.join(SHARED, f));
  });
}

srcFns.forEach(function (name) {
  const sDir = path.join(SRC_DIR, name);
  const dDir = path.join(DEPLOY_DIR, name);
  if (!fs.existsSync(dDir)) return; /* 已在第 2 节报过 */

  const dIdx = path.join(dDir, 'index.js');
  if (!fs.existsSync(dIdx)) { ok(name + ' 部署副本有 index.js', false); return; }
  const code = fs.readFileSync(dIdx, 'utf8');

  /* 3.1 语法 */
  try {
    new vm.Script(code, { filename: dIdx });
    ok(name + ' 语法正确', true);
  } catch (e) {
    ok(name + ' 语法正确', false, e.message);
  }

  /* 3.2 与源码逐字节一致 */
  const sIdx = path.join(sDir, 'index.js');
  ok(name + ' index.js 与源码一致', fs.existsSync(sIdx) && md5(sIdx) === md5(dIdx),
     '不一致 — 请跑 node tests/syncCloud.js');

  /* 3.3 package.json */
  const pkgPath = path.join(dDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    ok(name + ' 有 package.json', false);
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ok(name + ' package.json 合法', true);
      ok(name + ' 声明 wx-server-sdk',
         !!(pkg.dependencies && pkg.dependencies['wx-server-sdk']),
         JSON.stringify(pkg.dependencies));
    } catch (e) {
      ok(name + ' package.json 合法', false, e.message);
    }
  }

  /* 3.4 用到的 _shared 都已复制且最新 */
  const needs = requiredShared(code);
  if (needs.length) {
    const sd = path.join(dDir, '_shared');
    if (!fs.existsSync(sd)) {
      ok(name + ' 有 _shared 目录', false, '需要 ' + needs.join(', '));
    } else {
      const bad = [];
      needs.forEach(function (f) {
        const p = path.join(sd, f);
        if (!fs.existsSync(p)) { bad.push(f + '(缺失)'); return; }
        if (srcHashes[f] && md5(p) !== srcHashes[f]) bad.push(f + '(过期)');
      });
      ok(name + ' _shared 副本齐全且最新', bad.length === 0,
         bad.join(', ') + ' — 请跑 node tests/syncCloud.js');
    }
  } else {
    ok(name + ' 无需 _shared', true);
  }

  /* 3.5 副本里没有多余文件(多余=源码删过但忘了同步) */
  const sFiles = relFiles(sDir).filter(function (f) { return f.indexOf('_shared/') !== 0; });
  const dFiles = relFiles(dDir).filter(function (f) { return f.indexOf('_shared/') !== 0; });
  const extra = dFiles.filter(function (f) { return sFiles.indexOf(f) < 0; });
  ok(name + ' 部署副本无多余文件', extra.length === 0, extra.join(', '));
});

/* ===== 4. _shared 反向检查:副本里的模块都在源目录存在 ===== */
deployFns.forEach(function (name) {
  const sd = path.join(DEPLOY_DIR, name, '_shared');
  if (!fs.existsSync(sd)) return;
  fs.readdirSync(sd).forEach(function (f) {
    ok(name + ' _shared/' + f + ' 在源目录存在',
       fs.existsSync(path.join(SHARED, f)));
  });
});

/* ===== 5. 全目录断链检查:所有相对 require 都解析得到 ===== */
let broken = 0;
srcFns.forEach(function (name) {
  relFiles(path.join(DEPLOY_DIR, name)).filter(function (f) { return f.endsWith('.js'); })
    .forEach(function (rel) {
      const p = path.join(DEPLOY_DIR, name, rel);
      const s = fs.readFileSync(p, 'utf8');
      const re = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        const t = path.resolve(path.dirname(p), m[1]);
        if (!fs.existsSync(t) && !fs.existsSync(t + '.js')) {
          ok('断链 ' + name + '/' + rel + " → " + m[1], false);
          broken++;
        }
      }
    });
});
if (!broken) ok('全部相对 require 均可解析', true);

/* ===== 6. 前端调用点对齐 ===== */
const libCloud = path.join(ROOT, 'src', 'lib', 'cloud.js');
if (fs.existsSync(libCloud)) {
  const lc = fs.readFileSync(libCloud, 'utf8');
  const called = [];
  const re = /call\(\s*['"]([\w]+)['"]/g;
  let m;
  while ((m = re.exec(lc)) !== null) called.push(m[1]);

  const missing = called.filter(function (n) { return srcFns.indexOf(n) < 0; });
  ok('lib/cloud.js 调用的云函数都已存在', missing.length === 0, '缺失: ' + missing.join(', '));

  const unused = srcFns.filter(function (n) { return called.indexOf(n) < 0; });
  if (unused.length) console.log('  提示:以下云函数前端暂未调用 → ' + unused.join(', '));
}

console.log('\n共享模块源 cloudfunctions/_shared/ :');
Object.keys(srcHashes).forEach(function (f) { console.log('  · ' + f); });
console.log('\n  源码 ' + srcFns.length + ' 个函数  →  部署副本 ' + deployFns.length + ' 个函数');

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) { console.log('\n失败明细:'); fails.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
else console.log('  ✓ 全部通过');
