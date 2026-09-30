/* 云函数 · achievement —— 「成绩记录」与「获得荣誉」

   ★ 为什么一个函数管两块
     两块都是"家长手工录入、孩子只读"的外部数据，字段短、操作也完全一样
     （列表 / 增 / 改 / 删）。拆成两个云函数等于把同一套逻辑抄两遍，
     用户还要多上传一次。用 kind 区分即可。

   ★ 两块数据的性质（重要，决定了权限设计）
     它们**不是**小程序内部按打卡算出来的数据，而是外部世界的记录：
       scores  学校考试/测验成绩（家长录入）
       honors  学校或机构颁发的荣誉、奖章（家长录入，可带照片）
     所以：孩子**能看**（成绩是他自己的、荣誉就是要给人看的），
     但**增删改必须家长密码** —— 校验在服务端，前端不显示按钮不算数。

   ★ 支持两种记分方式（2026-09-24）
     孩子是一年级，学校常常不给分数，只给"优秀/良好/加油"这类等级。
     所以 kind 用 score(分数) / level(等级) 两种，页面里可切换。
     别只做分数 —— 那会让低年级用户用不上。

   入参：{ kind:'score'|'honor', act:'list'|'add'|'update'|'remove',
           id?, childId?, pin?, ...字段 } */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const pin = require('./_shared/pin');

const COLL = {
  children: 'children',
  scores: 'scores',
  honors: 'honors'
};

const KIND_COLL = { score: COLL.scores, honor: COLL.honors };
const KIND_NAME = { score: '成绩', honor: '荣誉' };

const LIMIT = {
  subject: 10, note: 50, title: 24, org: 24,
  maxScore: 1000, maxFull: 1000, list: 200
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const ev = event || {};
  const kind = (ev.kind === 'honor') ? 'honor' : 'score';
  const act = ev.act || 'list';
  const coll = KIND_COLL[kind];
  const now = new Date();

  try {
    /* ---------- 先确认"这个孩子是这个家长的" ---------- */
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = (childRes.data || [])[0] || null;
    if (!child) return { ok: false, code: 'NOT_FOUND', message: '还没有孩子信息。' };

    const cid = ev.childId || child._id;
    /* ★ 忽略/校验前端传来的 childId：传了就必须和孩子记录对得上 */
    if (ev.childId && ev.childId !== child._id) {
      return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
    }

    /* ==================== 查询 ==================== */
    if (act === 'list') {
      const res = await db.collection(coll)
        .where({ _openid: OPENID, childId: cid })
        .orderBy('date', 'desc')
        .limit(LIMIT.list).get();
      return {
        ok: true,
        kind: kind,
        list: (res.data || []).map(function (d) { return shape(kind, d); })
      };
    }

    /* ==================== 写操作：都要家长密码 ==================== */
    const chk = checkPin(child, ev.pin);

    /* ★ 校验结果要写回 children(错了记次数、对了清零)，否则"限次"形同虚设。
       ★ 必须 _.set():云开发传裸对象是**按子字段合并**,SDK 会拆成
         parentPin.hash / parentPin.attempts 这样的子路径去写,
         而 parentPin 是 null 时必报 Cannot create field(2026-09-23 官方文档确认)。
       ★ 这里用 `_.set(chk.v.parentPin)` 而不是先把 parentPin 透传出来再写 ——
         和 setPin / adjustPoints 等其它函数保持同一写法,
         也让静态断言("parentPin: 后面必须是 _.set(")能一直罩得住。 */
    if (chk.v && chk.v.parentPin) {
      await db.collection(COLL.children).doc(cid)
        .update({ data: { parentPin: _.set(chk.v.parentPin) } });
    }

    if (!chk.ok) return { ok: false, code: chk.code, message: chk.message };

    /* ---------- 删除 ---------- */
    if (act === 'remove') {
      const id = String(ev.id || '');
      if (!id) return { ok: false, code: 'INVALID', message: '缺少要删除的记录。' };
      const own = await ownDoc(coll, id, OPENID);
      if (!own.ok) return own;
      await db.collection(coll).doc(id).remove();
      return { ok: true, changed: true, message: '已删除这条' + KIND_NAME[kind] + '记录。' };
    }

    /* ---------- 新增 / 修改：先校验字段 ---------- */
    const f = validate(kind, ev);
    if (!f.ok) return { ok: false, code: 'INVALID', message: f.message };

    if (act === 'update') {
      const id = String(ev.id || '');
      if (!id) return { ok: false, code: 'INVALID', message: '缺少要修改的记录。' };
      const own = await ownDoc(coll, id, OPENID);
      if (!own.ok) return own;

      await db.collection(coll).doc(id).update({
        data: Object.assign({}, f.data, { updatedAt: now })
      });
      return {
        ok: true, changed: true, id: id, kind: kind,
        item: Object.assign({ _id: id }, own.doc, f.data),
        message: '已保存' + KIND_NAME[kind] + '记录。'
      };
    }

    /* ---------- 新增 ---------- */
    const addRes = await db.collection(coll).add({
      data: Object.assign({
        _openid: OPENID,
        childId: cid,
        createdAt: now,
        updatedAt: now
      }, f.data)
    });
    return {
      ok: true, changed: true, created: true, kind: kind,
      id: addRes._id,
      item: Object.assign({ _id: addRes._id, childId: cid }, f.data),
      message: '已添加' + KIND_NAME[kind] + '记录。'
    };

  } catch (err) {
    console.error('[achievement] failed', kind, act, err);
    return { ok: false, code: 'SAVE_FAILED', message: '保存失败,请重试。' };
  }
};

/* ------------------------------------------------------------------ */

/**
 * 家长密码校验。
 *
 * ★ 没设过密码时放行 —— 否则新用户一条记录都加不了（2026-09-24）
 *   设过密码就必须传；空值走 verifyPin 的 PIN_REQUIRED（不计数）。
 *
 * ★ 返回 v（verifyPin 的原始结果），**不把 parentPin 掏出来**。
 *   写入统一由调用方写 `parentPin: _.set(chk.v.parentPin)`
 *   —— 这样"写库"这件事只有一个形状，静态断言也只需要认一种写法。
 */
function checkPin(child, inputPin) {
  if (!pin.pinUsable(child)) return { ok: true, v: null };

  const v = pin.verifyPin(child, inputPin);
  if (v.ok) return { ok: true, v: v };

  const msg = v.code === 'PIN_LOCKED'
    ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
    : (v.code === 'PIN_REQUIRED' ? '需要家长密码。' : '家长密码不对。');
  return { ok: false, code: v.code, message: msg, v: v };
}

/* 确认这条记录确实属于当前用户 */
async function ownDoc(coll, id, OPENID) {
  let doc;
  try {
    const r = await db.collection(coll).doc(id).get();
    doc = r.data;
  } catch (e) {
    return { ok: false, code: 'NOT_FOUND', message: '这条记录不存在。' };
  }
  if (!doc || doc._openid !== OPENID) {
    return { ok: false, code: 'FORBIDDEN', message: '无权操作。' };
  }
  return { ok: true, doc: doc };
}

/**
 * 字段校验 + 组装写入数据。
 * ★ photo 只接受 cloud:// 开头的地址 —— 微信 chooseMedia 给的是临时路径
 *   （http://tmp/…），只在本机本次会话有效，存进库重启就变裂图
 *   （2026-09-23 头像就是这么坏的，这里从源头堵住）。
 */
function validate(kind, ev) {
  const date = String(ev.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: '请选一个日期。' };
  }

  const note = String(ev.note || '').trim().slice(0, LIMIT.note);

  if (kind === 'score') {
    const subject = String(ev.subject || '').trim().slice(0, LIMIT.subject);
    if (!subject) return { ok: false, message: '请填写科目。' };

    const k = (ev.type === 'level') ? 'level' : 'score';
    const data = { date: date, subject: subject, type: k, note: note };

    if (k === 'score') {
      const sc = Number(ev.score);
      if (!isFinite(sc) || sc < 0) return { ok: false, message: '分数要填一个数字。' };
      if (sc > LIMIT.maxScore) return { ok: false, message: '分数太大了,检查一下。' };
      const full = Number(ev.full);
      data.score = Math.round(sc * 10) / 10;
      data.full = (isFinite(full) && full > 0 && full <= LIMIT.maxFull) ? Math.round(full) : 100;
      data.level = '';
    } else {
      const lv = String(ev.level || '').trim().slice(0, 6);
      if (!lv) return { ok: false, message: '请选一个等级。' };
      data.score = 0;
      data.full = 0;
      data.level = lv;
    }
    return { ok: true, data: data };
  }

  /* honor */
  const title = String(ev.title || '').trim().slice(0, LIMIT.title);
  if (!title) return { ok: false, message: '请填写荣誉名称。' };

  const photoRaw = String(ev.photo || '').trim();
  const photo = /^cloud:\/\//.test(photoRaw) ? photoRaw.slice(0, 400) : '';

  return {
    ok: true,
    data: {
      date: date,
      title: title,
      org: String(ev.org || '').trim().slice(0, LIMIT.org),
      photo: photo,
      note: note
    }
  };
}

/* 服务端整形：前端不直接吃数据库字段 */
function shape(kind, d) {
  if (!d) return d;
  if (kind === 'score') {
    return {
      _id: d._id,
      date: d.date || '',
      subject: d.subject || '',
      type: (d.type === 'level') ? 'level' : 'score',
      score: Number(d.score) || 0,
      full: Number(d.full) || 0,
      level: d.level || '',
      note: d.note || ''
    };
  }
  return {
    _id: d._id,
    date: d.date || '',
    title: d.title || '',
    org: d.org || '',
    photo: d.photo || '',
    note: d.note || ''
  };
}
