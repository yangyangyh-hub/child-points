/* 探针:验证本轮新增的「自定义 tabBar」断言**真的有效**

   做法:临时改源码 → 跑静态检查 → 看有没有报出对应的失败 → 还原。
   有 finally 兜底,中途报错也会还原。

   注意:本机 node 不能 spawn node(EBUSY),所以改成同进程 require 静态检查脚本,
   先把 process.exit 换成"记录失败"的桩,跑完再还原。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SC = path.join(ROOT, 'tests', 'staticCheck.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }

/* 在子进程里跑会 EBUSY,所以同进程 require;process.exit 打桩 */
function runStaticCheck() {
  delete require.cache[require.resolve(SC)];
  const realExit = process.exit;
  let code = 0;
  process.exit = function (c) { code = c; throw new Error('__EXIT__'); };
  let out = [];
  const realLog = console.log;
  console.log = function () { out.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    require(SC);
  } catch (e) {
    if (e.message !== '__EXIT__') { out.push('THROW: ' + e.message); code = 1; }
  } finally {
    process.exit = realExit;
    console.log = realLog;
  }
  return { code: code, text: out.join('\n') };
}

/* [说明, 文件, 改动前的片段, 改动后的片段, 期望失败的断言关键词] */
const CASES = [
  [
    '开了 lazyCodeLoading ⇒ 应报"与自定义 tabBar 冲突"',
    'src/app.json',
    '"sitemapLocation": "sitemap.json"',
    '"sitemapLocation": "sitemap.json",\n  "lazyCodeLoading": "requiredComponents"',
    '没有开 lazyCodeLoading'
  ],
  [
    '某页没调 setTab ⇒ 应报"切页后高亮不跟着走"',
    'src/pages/mine/mine.js',
    "      this.getTabBar().setTab(3);",
    "      this.getTabBar().setTab(0);",
    'getTabBar().setTab(3)'
  ],
  [
    '页面没留底部内边距 ⇒ 应报"末尾内容被盖住"',
    'src/pages/medal/medal.wxss',
    '  padding-bottom: calc(136rpx + env(safe-area-inset-bottom));',
    '  padding-bottom: 24rpx;',
    '留了底部内边距'
  ],
  [
    '图标文件不在 ⇒ 应报"图标文件存在"',
    'src/app.json',
    '"iconPath": "assets/tab/mine.png"',
    '"iconPath": "assets/tab/nope.png"',
    '的图标文件存在'
  ],
  [
    'switchTab 的 url 丢了斜杠 ⇒ 应报"不是绝对路径"(本轮真实 bug)',
    'src/custom-tab-bar/index.js',
    "      wx.switchTab({\n        url: path,",
    "      wx.switchTab({\n        url: path.replace(/^\\//, ''),",
    '不是绝对路径|做了加工'
  ],
  [
    'switchTab 没有 fail 回调 ⇒ 应报"不能静默"',
    'src/custom-tab-bar/index.js',
    "        fail: function (err) {",
    "        nose: function (err) {",
    '写了 fail 回调'
  ],
  [
    '组件与 list 页码对不上 ⇒ 应报"第 N 项指向"',
    'src/custom-tab-bar/index.js',
    "pagePath: '/pages/medal/medal'",
    "pagePath: '/pages/reward/reward'",
    '第 2 项指向'
  ]
];

let pass = 0, fail = 0;
const orig = {};

CASES.forEach(function (c, i) {
  const [desc, file, from, to, expect] = c;
  const p = path.join(ROOT, file);
  const backup = read(p);
  let r;
  try {
    if (backup.indexOf(from) < 0) {
      console.log('✗ [注入失败] ' + desc + ' —— 找不到待替换片段,用例本身写错了');
      fail++;
      return;
    }
    write(p, backup.replace(from, to));
    r = runStaticCheck();
  } finally {
    write(p, backup);
  }
  const hit = expect.split('|').some(function (kw) { return r.text.indexOf(kw) >= 0; });
  if (hit && r.code === 1) {
    console.log('✓ ' + desc + ' → 断言按预期报错');
    pass++;
  } else {
    console.log('✗ ' + desc + ' → 断言**没报**(关键词"' + expect + '"未出现在失败明细里)');
    fail++;
  }
});

/* 还原后再跑一次,必须全绿 —— 证明探针本身没有留下副作用 */
const final = runStaticCheck();
if (final.code === 0) {
  console.log('✓ 还原后复跑:全绿(探针无副作用)');
  pass++;
} else {
  console.log('✗ 还原后复跑仍有失败 —— 探针没还原干净');
  fail++;
}

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
