/* 可选:断言有效性探针 —— 验证 medal.test.js 里为「parentPin 整体替换」补的断言是否真的能报错。
   为什么需要它:PROJECT.md 里的规矩 ——「新断言必须先证明它真能抓到那个 bug,否则等于没有」。
   做法:把 pin.js 临时改回旧写法 → 看断言会不会失败 → 无论结果都还原源文件。
   运行:  node tests/verify-pin-assertions.js   (不在 run-all 里自动跑,因为它会临时改源码) */

const fs = require('fs');
const path = require('path');

const PIN = path.join(__dirname, '..', 'cloudfunctions', '_shared', 'pin.js');
const orig = fs.readFileSync(PIN, 'utf8');

/* 注入点选 mergeSec:让它只返回 patch(即"返回值只有改动的几个字段"),
   这正是旧写法在 parentPin 为 null 时丢掉 hash/salt 的形态。 */
const ORIG_MERGE = 'return Object.assign({}, sec, patch);';
const BROKEN_MERGE = 'return patch;';

function runWith(src, label) {
  fs.writeFileSync(PIN, src, 'utf8');
  delete require.cache[require.resolve(PIN)];
  const P = require(PIN);
  const sec = P.setPin('1234');
  const v = P.verifyPin({ parentPin: sec }, '1234');
  const r = {
    '★ 返回值保留 hash': v.parentPin && v.parentPin.hash === sec.hash,
    '★ 返回值保留 salt': v.parentPin && v.parentPin.salt === sec.salt
  };
  console.log('--- ' + label + ' ---');
  Object.keys(r).forEach(function (k) {
    console.log((r[k] ? '  断言通过(不该)' : '  ★ 断言报错(预期)') + '  ' + k);
  });
  delete require.cache[require.resolve(PIN)];
  return r;
}

let injected = false, effective = false;
try {
  if (orig.indexOf(ORIG_MERGE) < 0) {
    console.log('!! 没找到目标行,探针无法注入,请检查 pin.js 是否已改动');
    process.exit(1);
  }
  const broken = orig.replace(ORIG_MERGE, BROKEN_MERGE);
  const res = runWith(broken, '注入 bug:返回值改回局部 patch');
  injected = true;
  effective = Object.keys(res).every(function (k) { return res[k] === false; });

  /* 还原后必须全通过 */
  const back = runWith(orig, '还原后');
  const restored = Object.keys(back).every(function (k) { return back[k] === true; });

  console.log('\n========================================');
  console.log('注入成功        : ' + injected);
  console.log('★ 断言有效(注入后必报错): ' + effective);
  console.log('还原后全绿      : ' + restored);
  console.log('========================================');
  if (!effective || !restored) process.exitCode = 1;
} finally {
  fs.writeFileSync(PIN, orig, 'utf8');
  console.log('已还原 pin.js');
}
