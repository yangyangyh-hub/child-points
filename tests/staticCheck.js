/* 静态自检 —— 页面与云函数/配置之间的一致性

   ★ 为什么需要它
     这轮一次性写了 9 个页面。人工核对以下这类问题代价太高、且容易漏:
       1) 页面调了不存在的云函数名(云函数改名了页面没跟着改)
       2) 页面引用了配置里不存在的常量(如 PRESET_TASKS 拼成 PRESET_TASK)
       3) 同一页面内渲染函数互相调用(会造成重复渲染 / 难查的递归)
       4) app.json 里登记了页面但文件不存在,或文件存在却没登记
       5) 云函数返回的字段名和页面读的字段名对不上

     ★ 已知误报的规避
     - 正则匹配字段读取时,要排除注释里的说明文字
     - 「页面读的字段」不做全集比对(云函数返回字段很多页面只用一部分),
       只查"页面读了但云函数明确不返回"的高危项(见 CRITICAL_FIELDS) */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
const failures = [];

function ok(msg) { pass++; }
function bad(msg) { fail++; failures.push(msg); }
function check(cond, msg) { cond ? ok(msg) : bad(msg); }

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

function listDir(p) {
  try { return fs.readdirSync(p); } catch (e) { return []; }
}

/* 去掉注释,避免注释里的举例被当真代码 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

console.log('\n=== 静态自检 · 页面与后端一致性 ===\n');

/* ================= 0. ★ 语法检查(最先做,后面所有检查都建立在"能解析"之上) =================

   ★ 为什么要有这一节(2026-09-23 补)
     此前 214 项静态检查**全部漏掉了语法错误** —— 因为那些检查都是
     "读文本 + 正则匹配",一个 `{ url: '...'; }` 这种括号内分号的低级语法错
     照样能通过所有断言。实测中它确实发生了:
       sub/log/log.js 的 onGoCheckin 里写成了 { url: '/pages/index/index'; }
     后果是**整个页面加载失败**,但这个脚本当时报了"214 项全过"。
     教训:**文本级检查不能替代真正的解析**。所以第一件事就是用
     node --check(等价于 new vm.Script)把每个 js 解析一遍。 */

const vm = require('vm');

let syntaxBad = 0;
function checkSyntax(absPath, label) {
  const code = read(absPath);
  if (!code) return;
  try {
    new vm.Script(code, { filename: absPath });
    ok(label + ' 语法正确');
  } catch (e) {
    bad(label + ' 语法错误 → ' + e.message);
    syntaxBad++;
  }
}

/* 0.1 src 下所有 js 文件 */
function collectAllJs(dir, out) {
  listDir(dir).forEach(function (n) {
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { return; }
    if (st.isDirectory()) { if (n !== 'node_modules') collectAllJs(full, out); }
    else if (/\.js$/.test(n)) out.push(full);
  });
  return out;
}
collectAllJs(SRC, []).forEach(function (p) {
  checkSyntax(p, path.relative(SRC, p).replace(/\\/g, '/'));
});
console.log('语法检查覆盖 ' + collectAllJs(SRC, []).length + ' 个 js 文件');

/* 0.2 app.wxss 里引用的样式类不做检查,但 wxml 的标签闭合做一次粗查
       (真正的编译在开发者工具里,这里只拦"明显不闭合"的情况) */

/* ================= 1. 云函数存在性 ================= */

const fnDir = path.join(ROOT, 'functions');
const cloudFns = listDir(fnDir).filter(function (n) {
  return exists(path.join(fnDir, n, 'index.js'));
});
console.log('发现云函数 ' + cloudFns.length + ' 个: ' + cloudFns.join(', '));

/* lib/cloud.js 里的 api 映射 → 实际云函数名
   写法形如:  key(params) { return call('fnName', ...); }
   ★ 参数个数不定(homeData(data, opt) / taskList(data)),故用 [^)]* 而不是固定形式 */
const cloudLib = read(path.join(SRC, 'lib', 'cloud.js'));
const apiCalls = [];
const apiRe = /(\w+)\s*\([^)]*\)\s*\{\s*return\s+call\(\s*'([^']+)'/g;
let m;
while ((m = apiRe.exec(cloudLib))) {
  apiCalls.push({ key: m[1], fn: m[2] });
}

console.log('lib/cloud.js 暴露 ' + apiCalls.length + ' 个接口');
apiCalls.forEach(function (a) {
  check(cloudFns.indexOf(a.fn) >= 0,
        'api.' + a.key + ' → 云函数 ' + a.fn + (cloudFns.indexOf(a.fn) >= 0 ? ' 存在' : ' 不存在!'));
});

/* ================= 2. 页面清单与 app.json 对账 ================= */

const appJson = JSON.parse(read(path.join(SRC, 'app.json')) || '{}');
const declared = (appJson.pages || []).map(function (p) { return p + '.js'; });
(appJson.subpackages || []).forEach(function (sp) {
  (sp.pages || []).forEach(function (p) { declared.push(sp.root + '/' + p + '.js'); });
});

console.log('\napp.json 登记页面 ' + declared.length + ' 个');
declared.forEach(function (rel) {
  check(exists(path.join(SRC, rel)), '登记页面存在: ' + rel);
});

/* 反查:src 下有页面 js 但没登记 */
function walkJs(dir, out) {
  listDir(dir).forEach(function (n) {
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { return; }
    if (st.isDirectory()) walkJs(full, out);
    else if (/\.js$/.test(n)) out.push(path.relative(SRC, full).replace(/\\/g, '/'));
  });
  return out;
}
const allPageJs = walkJs(path.join(SRC, 'pages'), []).concat(walkJs(path.join(SRC, 'sub'), []))
  .filter(function (p) { return /\.js$/.test(p); });

allPageJs.forEach(function (rel) {
  if (declared.indexOf(rel) < 0) {
    /* 只报未登记的页面,不报工具库 */
    bad('页面未在 app.json 登记: ' + rel);
  } else {
    ok('页面已登记: ' + rel);
  }
});

/* ================= 3. 每个页面的四件套齐全 ================= */

declared.forEach(function (rel) {
  const base = rel.replace(/\.js$/, '');
  const dir = path.dirname(base);
  const name = path.basename(base);
  ['.js', '.wxml', '.wxss', '.json'].forEach(function (ext) {
    const f = path.join(SRC, dir, name + ext);
    check(exists(f), '文件齐全 ' + dir + '/' + name + ext);
  });
});

/* ================= 4. 页面调用的云函数必须存在 ================= */

console.log('\n--- 页面调用的云函数 ---');
declared.forEach(function (rel) {
  const code = stripComments(read(path.join(SRC, rel)));
  const re = /cloud\.api\.(\w+)\s*\(/g;
  const used = {};
  let mm;
  while ((mm = re.exec(code))) used[mm[1]] = true;

  Object.keys(used).forEach(function (k) {
    const hit = apiCalls.filter(function (a) { return a.key === k; })[0];
    check(!!hit, rel + ' 调用 cloud.api.' + k + (hit ? ' (→' + hit.fn + ')' : ' 未在 lib/cloud.js 定义!'));
  });
});

/* ================= 5. 渲染函数互不调用 ================= */

console.log('\n--- 渲染函数互不调用 ---');
declared.forEach(function (rel) {
  const code = read(path.join(SRC, rel));
  /* 找出所有 renderXxx 定义 */
  const defs = [];
  const dre = /\brender([A-Z]\w*)\s*\(/g;
  let dm;
  while ((dm = dre.exec(code))) defs.push(dm[1]);

  const uniq = defs.filter(function (v, i) { return defs.indexOf(v) === i; });
  if (!uniq.length) return;

  /* 检查每个 renderXxx 的函数体里有没有调另一个 renderYyy */
  uniq.forEach(function (name) {
    /* 抓函数体:从定义处到下一个顶层方法(粗粒度但够用) */
    const sig = new RegExp('render' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s{2}\\w+\\s*\\(', 'm');
    const bm = sig.exec(code);
    if (!bm) return;
    const body = bm[1];
    uniq.forEach(function (other) {
      if (other === name) return;
      if (new RegExp('\\brender' + other + '\\s*\\(').test(body)) {
        bad(rel + ' 中 render' + name + ' 调用了 render' + other + '(应统一由 renderAll 调度)');
      }
    });
  });
  ok(rel + ' 渲染函数互不调用(' + uniq.length + ' 个)');
});

/* ================= 6. wxml 里绑定的事件必须在 js 里有定义 ================= */

console.log('\n--- 事件绑定与处理函数 ---');
declared.forEach(function (rel) {
  const jsPath = path.join(SRC, rel);
  const wxmlPath = jsPath.replace(/\.js$/, '.wxml');
  if (!exists(wxmlPath)) return;

  const wxml = stripComments(read(wxmlPath));
  const js = stripComments(read(jsPath));

  const handlers = {};
  const hre = /\b(?:bind|catch)(?:tap|input|change|confirm|chooseavatar|blur|focus|longpress)\s*=\s*"([^"{}]+)"/g;
  let hm;
  while ((hm = hre.exec(wxml))) handlers[hm[1]] = true;

  Object.keys(handlers).forEach(function (h) {
    /* 页面方法名 */
    const defined = new RegExp('\\b' + h + '\\s*\\(').test(js);
    check(defined, rel + ' wxml 绑定 ' + h + (defined ? ' 已定义' : ' 但 js 里没有定义!'));
  });
});

/* ================= 7. 配置常量引用 ================= */

console.log('\n--- 配置常量引用 ---');
const config = require(path.join(SRC, 'config.js'));
const configKeys = Object.keys(config);

declared.forEach(function (rel) {
  const code = stripComments(read(path.join(SRC, rel)));
  /* 只查 config.XxxYyy 这种明确引用 */
  const cre = /\bconfig\.([A-Z][A-Za-z0-9_]*)/g;
  let cm;
  while ((cm = cre.exec(code))) {
    check(configKeys.indexOf(cm[1]) >= 0,
          rel + ' 引用 config.' + cm[1] + (configKeys.indexOf(cm[1]) >= 0 ? ' 存在' : ' 不存在!'));
  }
});

/* ================= 8. 高危字段口径 ================= */

console.log('\n--- 字段口径(高危项) ---');
/* 孩子模式绝不该读到扣分数据;页面若直接读 today.penaltyTotal 必须是家长分支 */
declared.forEach(function (rel) {
  const wxml = stripComments(read(path.join(SRC, rel.replace(/\.js$/, '.wxml'))));
  if (!wxml) return;
  /* 钱包口径:reward 页不能用 lifetimePoints 判断可兑换 */
  if (/availablePoints/.test(wxml) && /lifetimePoints/.test(wxml)) {
    ok(rel + ' 同时展示 availablePoints / lifetimePoints(双积分口径,正确)');
  }
});

/* ================= 9. 每个"有数据列表"的页面都有空状态 ================= */

console.log('\n--- 空状态覆盖 ---');
/* ★ 例外:纯表单/输入页没有列表数据,不需要空状态 */
const NO_EMPTY_NEEDED = ['pages/pin/pin.js'];

declared.forEach(function (rel) {
  if (NO_EMPTY_NEEDED.indexOf(rel) >= 0) {
    ok(rel + ' 是纯输入页,按约定不需要空状态');
    return;
  }
  const wxml = read(path.join(SRC, rel.replace(/\.js$/, '.wxml')));
  const hasEmpty = /class="empty"/.test(wxml) || /empty-icon/.test(wxml);
  check(hasEmpty, rel + (hasEmpty ? ' 有空状态' : ' 缺少空状态(不能显示空白容器)'));
});

/* ================= 10. ★ 异步加载必须有兜底(2026-09-23 补) =================

   ★ 为什么要有这一节
     曾出现「模拟器停在骨架屏、一个字都不显示」的故障,根因是:
     `loadAll()` 只有 `.then` 没有 `.catch`,而链路上**确实存在同步抛错**
     (getApp() 返回 undefined / app.callFunction 不存在 / wx.cloud 不存在),
     同步抛错接不住 ⇒ `loading` 永远 true ⇒ 骨架屏挂死。

     两层防线都要有:
       ① lib/cloud.js 的 call() 永不抛出(已用 try/catch 包住)
       ② 每个 loadAll / doXxx 调用链自己有 .catch

     这里只查 ①(文本可验证):call() 里必须同时出现 try 与 catch。
     ② 由下面的"页面 loadAll 有 catch"逐页检查。 */

console.log('\n--- 异步加载兜底 ---');
const cloudLibPath = path.join(SRC, 'lib', 'cloud.js');
const cloudLibCode = read(cloudLibPath);
check(/\btry\s*\{/.test(cloudLibCode) && /\.catch\s*\(/.test(cloudLibCode),
      'lib/cloud.js 的 call() 有 try/catch 双重防护(不会向页面抛出)');
check(/typeof\s+instance\.callFunction\s*!==\s*'function'/.test(cloudLibCode) ||
      /typeof\s+\w+\.callFunction\s*!==\s*'function'/.test(cloudLibCode),
      'lib/cloud.js 检查了 app 实例是否可用(防 getApp() 返回 undefined)');

/* 页面里每个 loadAll 都必须有 catch */
declared.forEach(function (rel) {
  const code = read(path.join(SRC, rel));
  const m = code.match(/^  loadAll\(\)\s*\{([\s\S]*?)^  \},/m);
  if (!m) return;                     /* 该页没有 loadAll,跳过 */
  check(/\.catch\s*\(/.test(m[1]),
        rel + ' 的 loadAll 有 .catch 兜底(否则 loading 可能永远为 true)');
});

/* pin 页的提交必须有 catch —— 卡住会让数字键盘永久禁用 */
const pinCode = read(path.join(SRC, 'pages', 'pin', 'pin.js'));
if (pinCode) {
  const nThen = (pinCode.match(/\.then\s*\(/g) || []).length;
  const nCatch = (pinCode.match(/\.catch\s*\(/g) || []).length;
  check(nCatch >= nThen,
        'pages/pin/pin.js 每个 .then 都有对应 .catch(' + nThen + ' then / ' + nCatch + ' catch)');
}

/* ★ 超时兜底(2026-09-23 加)
   try/catch 只能挡"失败",挡不住"永远不返回"。
   云调用既不 resolve 也不 reject 时(网络半开、云函数冷启动卡死),
   调用方的 .then 和 .catch 都永远不触发 ⇒ loading 永远 true ⇒ 界面卡骨架屏。
   必须有 Promise.race + setTimeout 保证一定落一个结果。
   ★ 依据:2026-09-23 用户实测卡在骨架屏,排查时发现兜底链缺这一环。 */
check(/Promise\.race\s*\(/.test(cloudLibCode),
      'lib/cloud.js 有 Promise.race 超时兜底(防"永远不返回"导致骨架屏挂死)');
check(/TIMEOUT_MS\s*=\s*\d+/.test(cloudLibCode) && /setTimeout\(/.test(cloudLibCode),
      'lib/cloud.js 定义了超时阈值 TIMEOUT_MS 并用 setTimeout 触发');
check(/code:\s*'TIMEOUT'/.test(cloudLibCode),
      'lib/cloud.js 超时后返回可识别的 TIMEOUT 错误码(便于前端提示与排查)');

/* ★★ App 方法与 globalData 字段不能混用（2026-09-23 加）
   app.js 的 App({}) 里有两类东西:
     - globalData 对象里的**数据字段**: child / mode / pinUnlocked / hasPin ...
     - App 实例上的**方法**: setMode / isParentView / callFunction / clearChildCache
   ★ 方法**不在 globalData 里**。写成 `g.isParentView()`（g = globalData）会抛
     TypeError: g.isParentView is not a function —— 且抛在 onShow 里,
     loadAll() 根本执行不到 ⇒ loading 永远 true ⇒ 骨架屏卡死。
   ★ 这个 bug 曾骗过全部 708 项断言（因为断言只查语法/结构，不查"方法挂在哪")。
     修法:页面里必须写 `app().isParentView()` 或 `app.isParentView()`。 */
const APP_METHODS = ['isParentView', 'setMode', 'callFunction', 'clearChildCache'];

/* ★ 必须先剥掉注释再扫(stripComments 已在文件头部定义,直接复用)——
   否则注释里解释"曾误写成 g.isParentView()"会让断言误报(2026-09-23 实测踩到)。 */

let appMixin = 0;
declared.forEach(function (rel) {
  const code = stripComments(read(path.join(SRC, rel)));
  APP_METHODS.forEach(function (m) {
    /* 匹配 globalData 变量上的方法调用:g.isParentView() / gd.setMode() / globalData.xxx() */
    const re = new RegExp('\\b(globalData|g|gd|appData)\\s*\\.\\s*' + m + '\\s*\\(', 'g');
    const hits = code.match(re);
    if (hits) {
      appMixin += hits.length;
      check(false, rel + ' 把 App 方法当 globalData 字段用了:' + hits[0] +
                   '(应写 app().' + m + '(),方法不在 globalData 里)');
    }
  });
});
if (!appMixin) {
  check(true, '页面没有把 App 方法当 globalData 字段用(共查 ' +
              declared.length + ' 个页面 × ' + APP_METHODS.length + ' 个方法,已剥离注释)');
}

/* ★★ 反向断链检查:定义了的云函数接口必须**真的被调用**(2026-09-23 加)
   依据:initChild 是"创建孩子 + 播种预设任务和奖励"的唯一入口,
   但前端从头到尾**一次都没调用过它** —— 设置页不管有没有孩子都直接调
   settingSave,而 settingSave 查不到孩子就返回「还没有孩子信息。」。
   结果:用户填完昵称点保存,永远只看到这句话,孩子永远建不出来,
   整条首次使用链路是断的。而当时 709 项断言全绿 —— 因为只查了
   "页面用到的云函数存在吗",没查"云函数有人用吗"。
   ★ 单向检查查不出断链,必须双向都查。 */
const pageCodeAll = declared.map(function (rel) {
  return stripComments(read(path.join(SRC, rel)));
}).join('\n');

apiCalls.forEach(function (a) {
  const used = new RegExp('cloud\\.api\\.' + a.key + '\\s*\\(').test(pageCodeAll);
  check(used, 'api.' + a.key + ' → 云函数 ' + a.fn + ' 有页面真的在调用' +
              (used ? '' : '(★ 定义了却没人用,可能是断链)'));
});

/* ============ 11. ★ 数据库写入指令:写对象字段必须用 _.set() 整体替换 ============

   ★ 为什么要有这一节(2026-09-23 补)
   微信云开发的 `update` **传入裸 JS 对象时,语义是"按子字段合并",不是替换**。
   官方 Command.set 文档原文:传 `{ style: { color: 'red' } }` 只会把 style.color
   更新成 red,**不会**把 style 换成新对象。
   也就是说 SDK 会把它展开成 `parentPin.hash` / `parentPin.attempts` 这样的
   **子字段路径**去写;而 parentPin 当前是 null 时,往 null 里建子字段会被拒:
     Cannot create field 'attempts' in element {parentPin: null}
   且是**多条** write errors(有几个子字段就错几条)。
   要让"整个字段 = 这个对象",必须写成 `parentPin: _.set({...})`。

   ★ 这个坑骗过了当时全部断言,而且线上返工了一轮:
     第一轮只把 verifyPin 的返回值从"局部 patch"改成"完整对象",
     以为"整体替换"就够了 —— 重传云函数后**照旧报同一个错**,
     因为 SDK 把那个完整对象又拆成了子字段。**根因在写入指令,不在返回值。** */
const FN_DIR = path.join(ROOT, 'functions');
let bareObjWrites = 0;

listDir(FN_DIR).forEach(function (name) {
  const p = path.join(FN_DIR, name, 'index.js');
  if (!exists(p)) return;
  const code = stripComments(read(p));
  /* 允许:parentPin: null(新建文档时占位)、parentPin: _.set(...)
     不允许:parentPin: v.parentPin / parentPin: sec 这种"裸对象直写" */
  const re = /parentPin:\s*([A-Za-z_$][\w.$]*)/g;
  let m;
  while ((m = re.exec(code))) {
    const val = m[1];
    if (val === 'null' || val === '_.set') continue;
    bareObjWrites++;
    check(false, 'functions/' + name + '/index.js 里「' + m[0].trim() + '」是裸对象写入 —— ' +
                 '云开发会按子字段合并,parentPin 为 null 时必报 Cannot create field(应写 _.set(...))');
  }
});
if (!bareObjWrites) {
  check(true, '写 parentPin 的地方都用了 _.set() 整体替换(已剥离注释)');
}

/* ★ 超时定时器必须被清掉 —— 见 src/lib/cloud.js 里那段说明:
   Promise.race 不会取消**输的那一端**,不清的话每一次**成功的**调用
   也会在 12 秒后照样打一条「[cloud] 调用超时」的红色日志。
   实测这条假报警被当成真故障排查了一轮,必须守住。 */
const cloudSrc = stripComments(read(path.join(SRC, 'lib', 'cloud.js')));
check(/=\s*setTimeout\(/.test(cloudSrc), 'cloud.js 的超时定时器赋给了变量(才有得清)');
check(/clearTimeout\(/.test(cloudSrc), 'cloud.js 用 clearTimeout 清掉了超时定时器(防假报警)');

/* ★ switchTab 的 url 必须是绝对路径(带前导斜杠)
   官方 wx.switchTab 文档示例是 `url: '/index'`。
   去掉斜杠 ⇒ 按**相对当前页面目录**解析 ⇒ 找不到页面 ⇒ 走 fail。
   若同时没写 fail 回调就是**彻底静默**:四个按钮点了毫无反应、控制台也不报错。
   (2026-09-29 真实发生过:组件里写的是 `url: path.replace(/^\//,'')`。

   ★ 断言要覆盖两种形态 —— 第一版只查了"硬编码字符串",漏掉了本次真正的形态
     「**变量被加工**」,属于"只查形状没查语义",必须两者都查。) */
const allSrcFiles = [];
(function walk(dir) {
  listDir(dir).forEach(function (name) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) return walk(p);
    if (/\.(js|wxml)$/.test(name)) allSrcFiles.push(p);
  });
})(SRC);

let checkedSwitchTab = 0;
const tabbarJs = stripComments(read(path.join(SRC, 'custom-tab-bar', 'index.js')));
allSrcFiles.forEach(function (f) {
  const code = stripComments(read(f));
  const re = /switchTab\s*\(\s*\{[\s\S]{0,160}?url:\s*([^,\n}]+)/g;
  let m;
  while ((m = re.exec(code))) {
    const v = m[1].trim();
    checkedSwitchTab++;
    /* 形态一:硬编码字符串 ⇒ 必须以 / 开头 */
    if (/^['"]/.test(v)) {
      check(/^['"]\//.test(v), f.replace(SRC, 'src') + ' 里 switchTab 的 url 不是绝对路径:「'
        + v + '」(必须写成 /pages/xxx/xxx)');
      continue;
    }
    /* 形态二:变量 / 表达式 ⇒ 不允许任何"加工"
       (为什么只查关键字而不精匹配正则:本文件的 stripComments 会把
        正则字面量 `/^\//` 里的双斜杠当地注释删掉,原样匹配不到。
        switchTab 的 url 本该是确定路径,出现 replace/slice/拼接 就是可疑加工。) */
    check(!/(replace|slice|substr|substring)/.test(v) && v.indexOf('+') < 0,
      f.replace(SRC, 'src') + ' 里 switchTab 的 url 做了加工:「' + v
      + '」(相对路径解析会找不到页面,必须传绝对路径)');
  }
});
check(checkedSwitchTab > 0, '扫到了 switchTab 调用(守卫本身没空跑,当前 ' + checkedSwitchTab + ' 处)');

/* 自定义 tabBar 里 switchTab 的 url 通常来自 tabs[].pagePath ⇒ 那些值必须以 / 开头 */
const tabPagePaths = (tabbarJs.match(/pagePath:\s*'([^']+)'/g) || [])
  .map(function (s) { return s.replace(/.*'([^']+)'.*/, '$1'); });
tabPagePaths.forEach(function (p) {
  check(/^\//.test(p), 'custom-tab-bar 的 tabs 里 pagePath 是绝对路径:' + p);
});

/* tabBar 的点击跳转必须看得见失败 —— 静默失败的排查成本极高(见上面那条) */
check(/switchTab\s*\(\{[\s\S]*?fail\s*:/.test(tabbarJs),
  'custom-tab-bar 的 switchTab 写了 fail 回调(跳转失败要有提示,不能静默)');

/* ================= 自定义 tabBar(custom-tab-bar) =================

   ★ 为什么单独立一块
     自定义 tabBar 有三个"静默失效"的坑,任何一个踩了都是
     「底部不见了」或「点了跳错页」,而且编译器不一定报错:
       1) app.json 开了 lazyCodeLoading ⇒ getTabBar() 返回 null、tabBar 直接不显示
          (官方社区实测,基础库 2.21~2.30 都有)
       2) 页面 onShow 没调 getTabBar().setTab(n) ⇒ 切页后高亮停在上一个页面
       3) 组件不占布局流(fixed)⇒ 页面不加底部内边距,末尾内容被盖住 */

const tb = appJson.tabBar || {};

check(tb.custom === true, 'app.json 的 tabBar 开了 custom: true(用自定义 tabBar)');

/* lazyCodeLoading 与自定义 tabBar 冲突:开了按需注入,getTabBar() 会拿到 null */
check(appJson.lazyCodeLoading === undefined,
  'app.json 没有开 lazyCodeLoading(与自定义 tabBar 冲突,会导致 tabBar 不显示)');

check(Array.isArray(tb.list) && tb.list.length >= 2,
  'tabBar.list 至少 2 项(微信要求)');

/* 自定义 tabBar 下 iconPath 仍要填 —— list 是 tabBar 的"身份证",
   组件里的 tabs 是实际渲染用的,两边页码/文字必须对齐 */
const TAB_TEXT = ['打卡', '奖励', '勋章', '我的'];
(tb.list || []).forEach(function (item, i) {
  check(item.text === TAB_TEXT[i],
    'tabBar.list[' + i + '].text 是「' + TAB_TEXT[i] + '」('
    + (item.text || '空') + ' 会让底部导航与组件对不上)');
  [item.iconPath, item.selectedIconPath].forEach(function (ip) {
    check(!!ip && exists(path.join(SRC, ip)),
      'tabBar.list[' + i + '] 的图标文件存在:' + ip);
  });
});

/* 组件四件套齐全 */
['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach(function (f) {
  check(exists(path.join(SRC, 'custom-tab-bar', f)),
    'custom-tab-bar/' + f + ' 存在');
});
const tabCompJson = read(path.join(SRC, 'custom-tab-bar', 'index.json'));
check(/"component"\s*:\s*true/.test(tabCompJson),
  'custom-tab-bar/index.json 声明了 "component": true');

/* 组件里的 tabs 必须和 app.json 的 list 一一对应 */
const tabCompJs = stripComments(read(path.join(SRC, 'custom-tab-bar', 'index.js')));
const compPaths = (tabCompJs.match(/pagePath:\s*'([^']+)'/g) || [])
  .map(function (s) { return s.replace(/.*'([^']+)'.*/, '$1'); });
check(compPaths.length === (tb.list || []).length,
  'custom-tab-bar 里的 pagePath 数量与 app.json 一致('
  + compPaths.length + ' vs ' + (tb.list || []).length + ')');
(tb.list || []).forEach(function (item, i) {
  check(compPaths[i] === '/' + item.pagePath,
    'custom-tab-bar 第 ' + i + ' 项指向 /' + item.pagePath + '(' + (compPaths[i] || '空') + ')');
});

/* 四个 tab 页各自指定高亮索引 —— 漏一个就是"切过去还高亮上一页" */
const TAB_PAGES = [
  { f: 'pages/index/index.js', n: 0 },
  { f: 'pages/reward/reward.js', n: 1 },
  { f: 'pages/medal/medal.js', n: 2 },
  { f: 'pages/mine/mine.js', n: 3 }
];
TAB_PAGES.forEach(function (p) {
  const code = stripComments(read(path.join(SRC, p.f)));
  check(new RegExp('getTabBar\\(\\)\\s*\\.\\s*setTab\\(\\s*' + p.n + '\\s*\\)').test(code),
    p.f + ' 的 onShow 里调了 getTabBar().setTab(' + p.n + ')'
    + '(不调则切页后底部高亮不跟着走)');
  /* getTabBar() 在自定义 tabBar 未就绪时返回 null,必须判空,否则整页 onShow 抛错 */
  check(/getTabBar\(\)\s*\)/.test(code),
    p.f + ' 调 getTabBar() 前做了判空(返回 null 时不能把整页 onShow 带崩)');
  /* 自定义 tabBar 不占布局流,页面必须自己留底部空间 */
  const wxss = stripComments(read(path.join(SRC, p.f.replace(/\.js$/, '.wxss'))));
  check(/padding-bottom:\s*calc\([^)]*safe-area-inset-bottom/.test(wxss),
    p.f.replace(/\.js$/, '.wxss') + ' 的 .page 留了底部内边距 + 安全区'
    + '(自定义 tabBar 是 fixed 定位,不留会把末尾内容盖住)');
});

/* ================= 汇总 ================= */

console.log('\n---------------------------------------');
console.log('  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
} else {
  console.log('  ✓ 全部通过');
}
