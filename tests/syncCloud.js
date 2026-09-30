/* 生成:为每个云函数写 package.json,并把 _shared 模块复制进去

   ★ 为什么 _shared 要"复制"而不是"共享"
     微信云函数每个函数都是**独立部署单元** —— 上传时只上传该函数目录。
     云函数运行环境里没有主包的 src/,也无法 import 兄弟目录。
     所以共享代码必须物理复制进每个用到它的函数目录。

   ★ 代价与对策
     代价:改一次 _shared 要重新同步到所有函数。忘了同步会导致行为不一致。
     对策:本脚本是唯一的同步入口;每次改完 _shared 跑一次即可。
     并且 tests/cloudCheck.js 会校验所有副本的 md5 一致。

   ★★ 目录布局与唯一真相(2026-09-22 重构,2026-09-23 改单项目)
     ★ 开发者工具打开的是**项目根 child-points/** 这一层,不是 cloudfunctions/。
       根目录的 project.config.json 里写:
         miniprogramRoot   : "src/"             ← 前端在这儿
         cloudfunctionRoot : "cloudfunctions/"  ← 云函数在这儿
       两者平级且都在项目根下 —— 官方文档推荐的布局。
       于是**一个窗口**既能编译前端、又能右键上传云函数,
       也不再需要弹「后端服务」那一栏(那个只在"新建项目"时出现)。

     微信开发者工具的"上传并部署"只认 cloudfunctionRoot 指向的目录,
     且会**递归扫描子目录**当云函数 —— 所以共享模块放在里面没关系,
     它只是个普通子目录,不会被当成函数(只有含 index.js 的才被识别)。

     因此布局定为:
       src/                     ← 小程序前端,唯一真相(人改)
       functions/<name>/        ← 14 个云函数的源码,只改这里(人改)
       cloudfunctions/_shared/  ← 6 个共享模块的源码,也只改这里(人改)
       cloudfunctions/<name>/   ← 本脚本从 functions/<name>/ 复制生成的部署副本 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'functions');
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const SHARED = path.join(CF_DIR, '_shared');

/* ★ 依赖不再手写 —— 直接从函数源码里读 require
   手写清单会被改漏(本项目已栽过一次:把 streak.js 从 NEEDS 里删了,
   但函数里还在 require,部署后直接 Cannot find module)。
   所以这里扫描 functions/<name>/index.js 里所有
   require('./_shared/xxx') ,再补上各模块自己的前置模块。

   只有"函数明明用得到、但代码里没写 require"这种情况才需要人工介入,
   那种情况用 EXTRA 补,并且脚本会核对 EXTRA 里的项确实有用到。 */
const EXTRA = {
  /* 函数名: ['额外要复制的模块.js'] —— 目前为空 */
};

/* 共享模块之间的依赖图(权威,读自 _shared 各文件的 require) */
const SHARED_DEPS = {
  'constants.js': [],
  'streak.js': ['constants.js'],
  'ledger.js': ['constants.js'],
  'report.js': ['constants.js'],
  'pin.js': [],
  'medal.js': ['constants.js', 'streak.js']
};

/* 扫出某函数直接 require 的 shared 模块 */
function directNeeds(fnDir) {
  const f = path.join(fnDir, 'index.js');
  if (!fs.existsSync(f)) return [];
  const code = fs.readFileSync(f, 'utf8');
  const out = [];
  const re = /require\(\s*['"]\.\/_shared\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = /\.js$/.test(m[1]) ? m[1] : m[1] + '.js';
    if (out.indexOf(name) < 0) out.push(name);
  }
  return out;
}

/* 展开成含全部前置模块的闭包 */
function withDeps(list) {
  const out = [];
  (function add(list) {
    list.forEach(function (f) {
      if (out.indexOf(f) >= 0) return;
      SHARED_DEPS[f] = SHARED_DEPS[f] || [];
      add(SHARED_DEPS[f]);
      if (out.indexOf(f) < 0) out.push(f);
    });
  })(list);
  return out;
}

/* 每个函数的一句话描述,写进 package.json */
const DESC = {
  taskToggle:   '勾选/取消勾选打卡任务;单日扣分上限校验;原子更新打卡、流水、双积分',
  homeData:     '首页数据聚合(双积分/今日得分/连续打卡/勋章/日志),含双模式隔离',
  initChild:    '创建或更新孩子资料,首次播种预设行为规则与奖励',
  adjustPoints: '家长手动加减分 / 犯错补救 / 冲正历史流水,含 PIN 校验与上限保护',
  taskList:     '行为规则库列表(加分项/扣分项两组,含已关闭项)',
  taskSave:     '行为规则的新增/修改/启停/软删除;预设项不可删',
  rewardList:   '奖励商城列表 + 兑换记录,按可用积分计算可兑换性',
  rewardSave:   '奖励的新增/修改/上下架,含库存与分档',
  redeemReward: '兑换奖励:提交申请 → 家长审批 → 扣可用积分(两步式)',
  setPin:       '家长密码的设置/修改/验证',
  settingSave:  '系统设置:孩子资料/扣分上限/打卡提醒/重置今日数据',
  statsData:    '成长数据统计:7日趋势/TOP3/完成率/周报模板拼装',
  logSave:      '成长日志写入(与首页"今日备注"同一张表)',
  logList:      '成长日志分页列表'
};

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/* 递归复制目录;skip 命中的名字整体跳过(用于排除 __pycache__/.DS_Store 等) */
function copyDir(from, to, skip) {
  skip = skip || {};
  if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(function (name) {
    if (skip[name]) return;
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  });
}

/* 清空目录但保留目录本身 */
function emptyDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(function (name) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { emptyDir(p); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
  });
}

function main() {
  const report = [];
  const warns = [];

  const allDirs = fs.readdirSync(FN_DIR).filter(function (d) {
    return fs.statSync(path.join(FN_DIR, d)).isDirectory();
  });

  /* ✓ 自愈:清理历史遗留的 _shared 副本
     早期版本把 _shared 物理复制进每个 functions/<name>/_shared/ ,
     在 functions/ 不再是 cloudfunctionRoot 之后这些副本只会变成
     "改了源码忘了同步"的假象来源,统一删掉,只保留 cloudfunctions/ 下的副本。 */
  let purged = 0;
  allDirs.forEach(function (name) {
    const stale = path.join(FN_DIR, name, '_shared');
    if (fs.existsSync(stale)) { emptyDir(stale); fs.rmdirSync(stale); purged++; }
  });
  if (purged) warns.push('  清理了 ' + purged + ' 个源码目录里的历史 _shared 副本(已不再需要)');

  /* ✓ 共享模块源就是 cloudfunctions/_shared/,它本身就是源码(不是镜像) */
  const sharedSrcDir = SHARED;
  let sharedCount = 0;
  if (!fs.existsSync(sharedSrcDir)) {
    warns.push('  [警告] 找不到共享模块源目录 cloudfunctions/_shared/');
  } else {
    sharedCount = fs.readdirSync(sharedSrcDir).filter(function (f) { return f.endsWith('.js'); }).length;
  }

  /* ✓ 主循环:把每个函数复制成可直接部署的副本 */
  const realFns = allDirs.filter(function (d) { return d !== '_shared'; });

  realFns.forEach(function (name) {
    const srcDir = path.join(FN_DIR, name);
    const dstDir = path.join(CF_DIR, name);

    /* 依赖自动推导:读源码里 require 的 shared 模块 + 人工补充项 */
    const need = directNeeds(srcDir).concat(EXTRA[name] || [])
      .filter(function (v, i, a) { return a.indexOf(v) === i; });
    const needAll = withDeps(need);

    /* 先清空,避免删过的文件残留在部署副本里 */
    emptyDir(dstDir);

    /* 1.1 复制函数本体(排除同步产物,避免把上一轮的 _shared 带过去) */
    copyDir(srcDir, dstDir, { _shared: true, node_modules: true, __pycache__: true });

    /* 1.2 按需复制共享模块(自动补前置模块) */
    const sharedDir = path.join(dstDir, '_shared');
    if (needAll.length) {
      if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
      needAll.forEach(function (f) {
        const src = path.join(sharedSrcDir, f);
        if (!fs.existsSync(src)) throw new Error('缺少共享模块: ' + src + '(函数 ' + name + ' 需要它)');
        fs.copyFileSync(src, path.join(sharedDir, f));
      });
    }

    /* 2. 写 package.json */
    const pkg = {
      name: name,
      version: '1.0.0',
      description: DESC[name] || '',
      main: 'index.js',
      dependencies: { 'wx-server-sdk': '~2.6.3' }
    };
    fs.writeFileSync(path.join(dstDir, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const auto = needAll.length - need.length;
    report.push('  ✓ ' + name + '  ← ' + (needAll.length ? needAll.join(', ') : '(无共享依赖)') +
                (auto > 0 ? '   [+自动补前置 ' + auto + ' 个]' : ''));
  });

  /* 3. 反向检查:cloudfunctions/ 下有没有源码里不存在的孤儿函数 */
  fs.readdirSync(CF_DIR).forEach(function (d) {
    if (d === '_shared') return;
    const p = path.join(CF_DIR, d);
    if (!fs.statSync(p).isDirectory()) return;
    if (realFns.indexOf(d) < 0) warns.push('  [孤儿] cloudfunctions/' + d + ' 没有对应源码,建议手工删除');
  });

  /* 3.5 清理历史遗留:曾经为"双项目"方案生成过这两个文件
     ─────────────────────────────────────────────────────
     ★ 2026-09-23 改为**单项目**方案后,这两个文件不再需要:
       · cloudfunctions/project.config.json —— 当时是为了让工具把
         cloudfunctions/ 单独认成一个项目。现在项目根是 child-points/,
         配置统一写在**根目录**的 project.config.json 里(由人维护,不是脚本生成),
         这个文件留着会让工具产生"两个项目根"的歧义。
       · cloudfunctions/app.json —— 当时是为了喂饱"未找到 app.json"的校验红字。
         现在 cloudfunctionRoot 在项目根之下,工具不会拿它当小程序工程,不需要了。
     上面那条占位 app.json 里的 pages 路径本来就不存在,留着反而是个假线索。 */
  let cleaned = [];
  const cfCfgPath = path.join(CF_DIR, 'project.config.json');
  const cfPrivPath = path.join(CF_DIR, 'project.private.config.json');
  const cfAppPath = path.join(CF_DIR, 'app.json');
  [cfCfgPath, cfPrivPath, cfAppPath].forEach(function (p) {
    if (fs.existsSync(p)) { fs.unlinkSync(p); cleaned.push(path.relative(ROOT, p)); }
  });
  if (cleaned.length) {
    warns.push('  已清理双项目方案的历史遗留文件: ' + cleaned.join(' , '));
  }

  /* 3.6 核对项目根配置(它是单项目方案的入口,缺了工具会走"新建"流程)
     ★ 这个文件由**人**维护,脚本只校验、不覆盖 —— 因为它里面还有
       projectname / packOptions 这些人工意图,脚本生成的会丢掉。 */
  const rootCfgPath = path.join(ROOT, 'project.config.json');
  if (!fs.existsSync(rootCfgPath)) {
    warns.push('  [警告] 缺少项目根 project.config.json —— 开发者工具会走"新建项目"流程并弹出「后端服务」栏');
  } else {
    try {
      const rc = JSON.parse(fs.readFileSync(rootCfgPath, 'utf8'));
      const norm = function (v) { return String(v || '').replace(/^\.\//, '').replace(/\/$/, ''); };
      if (norm(rc.miniprogramRoot) !== 'src') {
        warns.push('  [警告] 根配置 miniprogramRoot = ' + JSON.stringify(rc.miniprogramRoot) + ',应为 "src/"');
      }
      if (norm(rc.cloudfunctionRoot) !== 'cloudfunctions') {
        warns.push('  [警告] 根配置 cloudfunctionRoot = ' + JSON.stringify(rc.cloudfunctionRoot) + ',应为 "cloudfunctions/"');
      }
      warns.push('  项目根 project.config.json 校验通过(miniprogramRoot=src/ , cloudfunctionRoot=cloudfunctions/)');
    } catch (e) {
      warns.push('  [警告] 项目根 project.config.json 解析失败: ' + e.message);
    }
  }

  /* 4. 自检:副本里的相对 require 是否都能解析 */
  let broken = 0;
  realFns.forEach(function (name) {
    const dstDir = path.join(CF_DIR, name);
    const jsFiles = [];
    (function walk(d) {
      fs.readdirSync(d).forEach(function (f) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.js')) jsFiles.push(p);
      });
    })(dstDir);
    jsFiles.forEach(function (p) {
      const s = fs.readFileSync(p, 'utf8');
      const re = /require\(\s*'(\.\/[^']+)'\s*\)/g;
      let m;
      while ((m = re.exec(s))) {
        const target = path.resolve(path.dirname(p), m[1]);
        if (!fs.existsSync(target) && !fs.existsSync(target + '.js')) {
          warns.push('  [断链] ' + path.relative(ROOT, p) + " require('" + m[1] + "') 解析不到");
          broken++;
        }
      }
    });
  });
  if (!broken) warns.push('  [OK] 所有副本的内部 require 均可解析');

  console.log('\n=== 云函数同步完成 ===');
  report.forEach(function (r) { console.log(r); });
  console.log('\n  共 ' + realFns.length + ' 个云函数,共享模块 ' + sharedCount + ' 个');
  console.log('');
  warns.forEach(function (w) { console.log(w); });
  console.log('\n源码目录: functions/          (只改这里)');
  console.log('部署目录: cloudfunctions/      (自动生成,IDE 从这里上传)');
  console.log('★ 开发者工具打开: 项目根 ' + ROOT + '  (不是 cloudfunctions/)');
  console.log('提示:每次修改 functions/ 下的任何文件后都要重跑本脚本。\n');
}

main();
