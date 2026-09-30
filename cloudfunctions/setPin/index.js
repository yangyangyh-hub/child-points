/* 云函数 · setPin —— 家长密码的设置 / 修改 / 验证(R3)

   ★ 为什么单独一个函数
     它是"权限的开关",不该混在业务函数里 —— 否则一个改昵称的请求
     也可能顺带把密码改了,审计时说不清。

   ★ action 三态
     set       首次设置(未设过密码时才允许)
     change    修改(必须提供旧密码)
     verify    仅校验(切到家长模式时用) */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const pin = require('./_shared/pin');

const COLL = { children: 'children' };

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, childId, pin: newPin, oldPin } = event || {};
  const act = action || 'set';
  const now = new Date();

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: false, code: 'NOT_FOUND', message: '还没有孩子信息。' };

    const cid = childId || child._id;
    /* ★ 用 pinUsable():必须 hash + salt **都在**才算"设过密码"(2026-09-23)。
       库里那条残骸只有 hash 没有 salt(见 _shared/pin.js 的说明),如果算作"已设",
       用户就会走进「输入密码 → 任何密码都不对 → 连错 5 次锁定」的死循环。
       算作未设 ⇒ 前端显示「设置家长密码」,直接重设,自愈。 */
    const hasPin = pin.pinUsable(child);

    /* ---------- 仅验证(切模式时调用) ---------- */
    if (act === 'verify') {
      const v = pin.verifyPin(child, newPin);
      if (v.parentPin) {
        await db.collection(COLL.children).doc(cid)
        /* ★★ 必须用 _.set() —— 云开发的 update 传裸对象是"按子字段合并",
           官方 Command.set 文档:传 { style: { color: red } } 只会更新 style.color,
           不会把 style 换成新对象。也就是说 SDK 会把 parentPin 拆成
           parentPin.hash / parentPin.attempts 等子字段路径去写,
           而 parentPin 现在是 null ⇒ 报
           Cannot create field attempts in element {parentPin: null},
           而且是多条 write errors(几个子字段就错几条)。
           _.set() 才表示"整个字段替换成这个对象"(2026-09-23 官方文档确认) */
          .update({ data: { parentPin: _.set(v.parentPin) } });
      }
      if (!v.ok) {
        const msg = v.code === 'PIN_LOCKED'
          ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
          : '密码不对,再试一次。';
        return { ok: false, code: v.code, message: msg, remainMs: v.remainMs || 0 };
      }
      return { ok: true, verified: true, message: '验证通过。' };
    }

    /* ---------- 新密码格式校验 ---------- */
    const np = String(newPin || '');
    if (!/^\d{4}$/.test(np)) {
      return { ok: false, code: 'INVALID', message: '密码必须是 4 位数字。' };
    }
    /* 拒绝过于好猜的(纯重复 / 顺序)。这不是安全边界,但能挡掉最差的选择 */
    if (/^(\d)\1{3}$/.test(np) || ['1234','4321','0123','3210','0000','1111','2222'].indexOf(np) >= 0) {
      return { ok: false, code: 'INVALID', message: '这个密码太容易猜到了,换一个吧。' };
    }

    /* ---------- 修改:必须验旧密码 ---------- */
    if (act === 'change') {
      if (!hasPin) {
        return { ok: false, code: 'INVALID', message: '还没有设置过密码,请直接用"设置密码"。' };
      }
      const v = pin.verifyPin(child, oldPin);
      /* ★ PIN_BROKEN(库里只有 hash、没有 salt)时**放行重设**(2026-09-23):
         损坏的数据本来就验不过任何密码、也就没有保护作用;
         这里不放行的话,家长会被永久锁在门外,只能去云开发控制台手改数据库。
         这是除「忘记密码」之外的第二条自愈路径,判定集中在 _shared/pin.js。 */
      if (!v.ok && v.code !== 'PIN_BROKEN') {
        if (v.parentPin) {
          await db.collection(COLL.children).doc(cid)
            .update({ data: { parentPin: _.set(v.parentPin) } });
        }
        const msg = v.code === 'PIN_LOCKED'
          ? '密码错误次数太多,请 ' + Math.ceil((v.remainMs || 0) / 60000) + ' 分钟后再试。'
          : '原密码不对。';
        return { ok: false, code: v.code, message: msg };
      }
    }

    /* ---------- 设置 ---------- */
    /* ★ 逐步 try —— 把出错的那一步单独标出来(2026-09-23)
       原来整段都在最外层 catch 里,任何一步失败都只回一句
       「操作失败,请重试。」,排查时完全看不出断在哪。
       分成三段后,日志里能直接看到是 scrypt、还是 DB 更新失败。 */
    let sec;
    try {
      sec = pin.setPin(np);
    } catch (e) {
      console.error('[setPin] ①scrypt 哈希失败', e && e.code, e && e.message, e);
      return { ok: false, code: 'SAVE_FAILED', message: '密码加密失败,请重试。' };
    }

    try {
      await db.collection(COLL.children).doc(cid).update({
        data: { parentPin: _.set(sec), updatedAt: now }
      });
    } catch (e) {
      /* ★ 这里最容易出问题:children 集合权限若设成「仅创建者可读写」
         而文档又缺 _openid 字段,更新会被拒。日志里能看到明确原因。 */
      console.error('[setPin] ②DB 更新失败 cid=' + cid, e && e.errCode, e && e.errMsg, e);
      return {
        ok: false, code: 'SAVE_FAILED',
        message: '保存密码失败(' + ((e && (e.errMsg || e.message)) || '未知原因') + ')'
      };
    }

    return {
      ok: true,
      changed: true,
      hasPin: true,
      message: act === 'change' ? '密码已修改。' : '密码已设置。切到孩子模式时就不会看到扣分记录了。'
    };

  } catch (err) {
    console.error('[setPin] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '操作失败,请重试。' };
  }
};
