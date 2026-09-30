/* 一键跑全部检查。
   顺序有讲究:先同步,再自检,最后跑业务测试 ——
   部署副本没同步的话,后面所有测试都是在测"过期的东西"。

   用法:  node tests/run-all.js
      (或 npm test,若 package.json 里配了 scripts.test) */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/* [脚本名, 是否需要先跑, 说明] */
const STEPS = [
  ['syncCloud.js',       '同步 functions/ → cloudfunctions/ 部署副本'],
  ['cloudCheck.js',      '源码与部署副本一致性(178 项)'],
  ['deployLoad.test.js', '部署副本可加载性 + 前后端常量对账/C.xxx引用检查(70 项)'],
  ['ledger.test.js',     '积分账本与双积分口径(47 项)'],
  ['medal.test.js',      '勋章判定与预设数据 + 家长 PIN(154 项)'],
  ['taskToggle.test.js', '打卡开关与扣分上限(22 项)'],
  ['pages.test.js',      '页面逻辑与状态机(44 项)'],
  ['resetAll.test.js',   '清空所有数据:三道锁 / 十张表全覆盖 / 只删自己的(40 项)'],
  ['staticCheck.js',     '静态合规:语法/页面/事件/云函数/兜底/超时/App方法/断链/写入指令/tabBar(336 项)']
];

let failed = 0;
const results = [];

console.log('\n' + '='.repeat(52));
console.log('  儿童成长积分打卡 — 全量检查');
console.log('='.repeat(52));

STEPS.forEach(function (s) {
  const file = path.join(__dirname, s[0]);
  if (!fs.existsSync(file)) {
    results.push(['跳过', s[0], '文件不存在']);
    return;
  }
  process.stdout.write('\n▶ ' + s[0] + '  (' + s[1] + ')\n');
  try {
    const out = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
    /* 摘出统计行 */
    const m = out.match(/通过\s*(\d+)\s*项[^\n]*失败\s*(\d+)\s*项/) ||
              out.match(/通过\s*(\d+)\s*项[^\n]*失败\s*(\d+)/);
    const p = m ? Number(m[1]) : null;
    const f = m ? Number(m[2]) : 0;
    results.push([f ? '失败' : '通过', s[0], m ? p + ' 项通过 / ' + f + ' 项失败' : '已完成']);
    if (f) { failed++; process.stdout.write(out); }
    else process.stdout.write('  ✓ ' + (m ? p + ' 项通过' : '完成') + '\n');
  } catch (e) {
    failed++;
    /* ★ 必须把子进程的**真实错误**说清楚(2026-09-23 修)
       原来这里只打印 stdout / stderr,但"**启动子进程本身失败**"时两者都是空的
       —— 界面上只看到 8 个脚本齐刷刷"执行失败",一点线索都没有。
       实测就是这么踩到的:Windows 下 spawn 报 EBUSY(安全软件/沙箱短暂占用
       node.exe),而错误信息被吞掉了,害我一度以为是代码全崩。
       ★ 判据:多个脚本同时报同一种失败 ⇒ 先怀疑运行环境/脚本自身,不是被测代码。 */
    const why = (e && (e.message || e.code)) || '未知';
    results.push(['失败', s[0], '执行出错: ' + why]);
    process.stdout.write('  ✗ 执行失败: ' + why + '\n');
    if (e && e.stdout) process.stdout.write(e.stdout);
    if (e && e.stderr) process.stdout.write(e.stderr);
    if (e && e.code === 'EBUSY') {
      process.stdout.write('  ⓘ EBUSY = 进程被短暂占用(杀毒/安全软件正在扫 node.exe)。\n');
      process.stdout.write('    不是代码问题 —— 关掉实时防护,或单独跑这一个脚本:\n');
      process.stdout.write('      node tests/' + s[0] + '\n');
    }
  }
});

console.log('\n' + '='.repeat(52));
console.log('  汇总');
console.log('='.repeat(52));
let totalPass = 0;
results.forEach(function (r) {
  const num = r[2].match(/^(\d+)/);
  if (num) totalPass += Number(num[1]);
  const mark = r[0] === '通过' ? '✓' : (r[0] === '跳过' ? '·' : '✗');
  console.log('  ' + mark + ' ' + r[1].padEnd(20) + r[2]);
});
console.log('');
console.log('  合计 ' + totalPass + ' 项断言通过，' + failed + ' 个脚本失败');
console.log('');

process.exit(failed ? 1 : 0);
