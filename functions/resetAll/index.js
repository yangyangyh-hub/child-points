/* 云函数 · resetAll —— 清空全部数据,让小程序回到"刚装好"的状态

   ★ 为什么单独开一个云函数,而不是塞进 settingSave
     这是整个项目里**唯一一个不可逆、且影响全部模块**的操作。
     它的危险等级和"改个昵称""重置今天"完全不是一回事:
       1) 语义要单一 —— 一眼看出"这个函数只会做一件事:全删";
       2) 权限要更硬 —— 重置今天还能在没设密码时放行,清空全部**绝不放行**;
       3) 出错要好查 —— 混在 settingSave 的 if/else 里,将来改设置项很容易误伤它。

   ★★ 三条硬性约定(改这个文件前必读)
     1) **必须服务端校验家长密码**。孩子用的是同一台手机、同一个微信,
        只在前端弹个确认框 = 孩子点两下就能把家长的记录全清掉。
        本项目有过"权限只由前端把关"的教训(taskToggle 的 allowOverLimit),
        这里从一开始就不留这个缺口。
     2) **没设过家长密码时直接拒绝**(返回 PIN_REQUIRED)。
        与 achievement 不同 —— 那里没密码放行是为了"新用户至少能加一条";
        这里放行的代价是全部数据,不值得换那点方便。
     3) **必须带 confirm:true**。前端已经弹过确认框也要带,
        这是防"前端漏确认 / 将来有人直接调接口"的第二道锁。

   ★ 删除范围的口径
     按 `_openid`(而不是 childId)删 —— 本项目 v1 是单孩子,
     按 openid 删才能连"换了孩子、旧数据没清干净"这类孤儿记录一起收掉,
     更符合用户说的"整个小程序恢复初始化"。

   入参:{ confirm:true, pin:'1234' }
   出参:{ ok:true, removed:{...}, removedFiles:n } */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const C = require('./_shared/constants');
const pin = require('./_shared/pin');

/* ★ _shared/constants.js 的 COLL 里没有 scores / honors(那两个是勋章页后加的,
     只有 achievement 自己维护了一份)。这里补齐,保证清空不漏表。
     ⚠ 将来再新增集合,必须同步加到这里和 TARGETS —— 漏一个就是"清空了却残留"。 */
const COLL = Object.assign({}, C.COLL, {
  scores: 'scores',
  honors: 'honors'
});

/* 要清空的业务表(不含 children —— 那条单独最后删,因为删了就查不到密码了) */
const TARGETS = [
  'tasks', 'checkins', 'points', 'redemptions',
  'rewards', 'medals', 'logs', 'scores', 'honors'
];

/* 分批删除:云数据库一次 where().remove() 不适合直接拿海量数据开刀,
   这里每次先取 100 个 _id 再按 _id 删,循环到取空为止。
   MAX_ROUNDS 是保险丝 —— 万一 where 条件失效(比如 _openid 为空),
   没有它就会无限循环,把整个集合清空。 */
const BATCH = 100;
const MAX_ROUNDS = 50;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const ev = event || {};

  /* ★ 第一道锁:必须显式确认 */
  if (ev.confirm !== true) {
    return {
      ok: false, code: 'INVALID', needConfirm: true,
      message: '清空不可恢复,需要在界面上确认一次。'
    };
  }

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = (childRes.data || [])[0] || null;

    /* ---------- 第二道锁:家长密码(仅当存在孩子记录时) ---------- */
    if (child) {
      const cid = child._id;

      if (!pin.pinUsable(child)) {
        return {
          ok: false, code: 'PIN_REQUIRED',
          message: '请先在上面设置一个家长密码,再来清空数据。'
        };
      }

      const v = pin.verifyPin(child, ev.pin);

      /* ★ 校验结果必须写回(错了记次数、对了清零),否则"连错 5 次锁定"形同虚设。
         ★★ 必须 _.set():云开发传裸对象是**按子字段合并**,SDK 会把对象拆成
            parentPin.hash / parentPin.attempts 这样的子路径去写,
            而 parentPin 为 null 时必报 Cannot create field(2026-09-23 官方文档确认)。 */
      if (v && v.parentPin) {
        await db.collection(COLL.children).doc(cid)
          .update({ data: { parentPin: _.set(v.parentPin) } });
      }

      if (!v.ok) {
        const msg = v.code === 'PIN_LOCKED'
          ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
          : (v.code === 'PIN_REQUIRED' ? '需要家长密码。' : '家长密码不对。');
        return { ok: false, code: v.code, message: msg };
      }
    }

    /* ---------- 先把云存储里的图片 id 收出来(删了库就找不到了) ---------- */
    const files = [];
    if (child && /^cloud:\/\//.test(String(child.avatar || ''))) {
      files.push(child.avatar);
    }
    const hRes = await db.collection(COLL.honors)
      .where({ _openid: OPENID }).field({ photo: true }).limit(200).get();
    (hRes.data || []).forEach(function (d) {
      if (/^cloud:\/\//.test(String(d.photo || ''))) files.push(d.photo);
    });

    /* ---------- 逐表删除 ---------- */
    const removed = {};
    for (let i = 0; i < TARGETS.length; i++) {
      const key = TARGETS[i];
      removed[key] = await removeAll(COLL[key], OPENID);
    }
    /* 最后删孩子本身 —— 前面所有校验都依赖它 */
    removed.children = child ? await removeAll(COLL.children, OPENID) : 0;

    /* ---------- 云存储文件(失败不影响结果,只是留几张没人引用的图) ---------- */
    let removedFiles = 0;
    if (files.length) {
      try {
        const r = await cloud.deleteFile({ fileList: files });
        removedFiles = ((r && r.fileList) || []).length;
      } catch (e) {
        console.error('[resetAll] deleteFile failed', e);
      }
    }

    return {
      ok: true,
      changed: true,
      removed: removed,
      removedFiles: removedFiles,
      message: '已清空全部数据,现在回到刚装好的状态。'
    };

  } catch (err) {
    console.error('[resetAll] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '清空失败,请重试。' };
  }
};

/**
 * 按 _openid 清空一张表。
 * @returns {Promise<number>} 实际删除条数
 */
async function removeAll(collName, openid) {
  let removed = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await db.collection(collName)
      .where({ _openid: openid })
      .field({ _id: true })
      .limit(BATCH)
      .get();

    const docs = res.data || [];
    if (!docs.length) break;

    const ids = docs.map(function (d) { return d._id; });
    await db.collection(collName).where({ _id: _.in(ids) }).remove();
    removed += ids.length;

    /* 取回来的比批次数少 ⇒ 已经取空了,不用再查一次 */
    if (ids.length < BATCH) break;
  }
  return removed;
}
