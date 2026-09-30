/* 可选:断言有效性探针 —— 验证 staticCheck.js 新增的「写 parentPin 必须用 _.set()」
   与「cloud.js 必须清超时定时器」这两组断言,真的能抓到 bug。
   依据 PROJECT.md 里的规矩:"新断言必须先证明它真能抓到那个 bug,否则等于没有"。

   为什么在同一个进程里 require 静态检查脚本(而不是 spawn 一个子进程):
   本机(Windows + 沙箱)node 再 spawn node 会报 EBUSY,所以改成
   "覆盖掉 process.exit,把静态检查 require 进来跑" —— 这样也能拿到它的失败计数。
   运行:  node tests/verify-write-assertions.js   (不在 run-all 里自动跑,它会临时改源码) */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  {
    name: 'functions/setPin/index.js 的 parentPin 写入',
    file: path.join(ROOT, 'functions', 'setPin', 'index.js'),
    from: 'data: { parentPin: _.set(v.parentPin) }',
    to: 'data: { parentPin: v.parentPin }'
  },
  {
    name: 'src/lib/cloud.js 的清定时器',
    file: path.join(ROOT, 'src', 'lib', 'cloud.js'),
    from: 'if (timer) { clearTimeout(timer); timer = null; }',
    to: ''
  }
];

const CHECKER = path.join(__dirname, 'staticCheck.js');
const origExit = process.exit;

/* 跑一次静态检查,返回"是否报了失败"(不真的退出进程) */
function runCheck() {
  let failed = false;
  process.exit = function (code) { if (code) failed = true; };
  delete require.cache[require.resolve(CHECKER)];
  const origLog = console.log;
  console.log = function () {};           /* 静音,只看结论 */
  try { require(CHECKER); } catch (e) { failed = true; }
  finally { console.log = origLog; }
  process.exit = origExit;
  return failed;
}

let allGood = true;
try {
  console.log('--- 还原态:应当全部通过 ---');
  const clean = runCheck();
  console.log('  静态检查报失败? ' + clean + '   ' + (clean ? '✗ 不该' : '✓ 预期 0 失败'));
  if (clean) allGood = false;

  TARGETS.forEach(function (t) {
    const orig = fs.readFileSync(t.file, 'utf8');
    if (orig.indexOf(t.from) < 0) {
      console.log('!! ' + t.name + ':找不到注入点,跳过(源码可能已改)');
      allGood = false;
      return;
    }
    try {
      fs.writeFileSync(t.file, orig.replace(t.from, t.to), 'utf8');
      console.log('--- 注入 bug:' + t.name + ' ---');
      const caught = runCheck();
      console.log('  静态检查报失败? ' + caught + '   ' + (caught ? '✓ 断言有效' : '✗ 没抓到!'));
      if (!caught) allGood = false;
    } finally {
      fs.writeFileSync(t.file, orig, 'utf8');
      console.log('  已还原 ' + path.relative(ROOT, t.file));
    }
  });
} finally {
  console.log('\n========================================');
  console.log(allGood ? '★ 全部断言有效且已还原' : '★ 有断言没抓到 bug,或注入点失效');
  console.log('========================================');
}
if (!allGood) origExit.call(process, 1);
