/* 云函数 · taskSave —— 新增 / 修改 / 启停 / 删除任务

   ★ 按文字原型稿重构(2026-09-22)。变化点:
     1) 增加 medalTag(勋章归属标签,R5)—— 家长建任务时选择
     2) active 改为"开关"语义(原型稿页面2「开启/关闭某条行为」)
     3) 预设任务是系统自带:可开关、可改分,但**不可删除**(原型稿页面2)
     4) 支持 kind 参数区分"加分项/扣分项",前端两栏录入更省事

   ★ 为什么预设任务不能删
     它们是勋章判定的依赖(medalTag 挂钩在这些任务上)。
     删掉「每日阅读20分钟」,阅读小明星就永远无法解锁 —— 而家长不会知道
     这层因果关系。改成"可关闭",效果一样但可逆。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const C = require('./_shared/constants');

const COLL = { tasks: 'tasks', children: 'children' };

const VALID_CATS = ['study', 'chores', 'independent', 'life', 'sport', 'moral'];
const MAX_TASKS = 60;      /* 一年级场景够用;防止误操作批量导入 */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, taskId, childId, name, score, category, medalTag, active } = event || {};

  const act = action || (taskId ? 'update' : 'create');

  try {
    /* ---------- 删除 / 启停 / 改分 都要校验归属 ---------- */
    if (taskId) {
      let task;
      try {
        const r = await db.collection(COLL.tasks).doc(taskId).get();
        task = r.data;
      } catch (e) {
        return { ok: false, code: 'NOT_FOUND', message: '任务不存在。' };
      }
      if (!task || task._openid !== OPENID) {
        return { ok: false, code: 'FORBIDDEN', message: '无权操作该任务。' };
      }

      /* ========== 删除 ========== */
      if (act === 'delete') {
        /* ★ 预设任务不可删(原型稿页面2) */
        if (task.preset) {
          return {
            ok: false, code: 'INVALID',
            message: '「' + task.name + '」是系统自带的行为,可以关闭但不能删除。',
            canDeactivate: true
          };
        }
        /* 软删除:改成 active=false,历史打卡记录还要靠 taskId 回查 */
        await db.collection(COLL.tasks).doc(taskId).update({
          data: { active: false, deletedAt: new Date(), updatedAt: new Date() }
        });
        return { ok: true, changed: true, softDeleted: true, message: '已删除,历史打卡记录保留。' };
      }

      /* ========== 启停 ========== */
      if (act === 'toggle' || act === 'deactivate') {
        const next = (act === 'deactivate') ? false : (active !== false);
        await db.collection(COLL.tasks).doc(taskId).update({
          data: { active: next, updatedAt: new Date() }
        });
        return {
          ok: true, changed: true, active: next,
          message: next ? '已开启「' + task.name + '」' : '已关闭「' + task.name + '」,历史记录不受影响。'
        };
      }

      /* ========== 修改 ========== */
      const patch = { updatedAt: new Date() };

      if (name !== undefined) {
        const nm = String(name).trim().slice(0, 20);
        if (!nm) return { ok: false, code: 'INVALID', message: '名称不能为空。' };
        patch.name = nm;
      }

      if (score !== undefined) {
        const sc = Number(score);
        if (!isFinite(sc) || sc === 0) {
          return { ok: false, code: 'INVALID', message: '分值必须是非 0 整数。' };
        }
        if (Math.abs(sc) > 50) {
          return { ok: false, code: 'INVALID', message: '单项分值不要超过 50 分。' };
        }
        patch.score = Math.round(sc);
      }

      if (category !== undefined) {
        patch.category = VALID_CATS.indexOf(category) >= 0 ? category : '';
      }

      if (medalTag !== undefined) {
        /* 空串表示不参与勋章判定 */
        patch.medalTag = C.VALID_MEDAL_TAGS.indexOf(medalTag) >= 0 ? medalTag : '';
      }

      if (active !== undefined) patch.active = !!active;

      await db.collection(COLL.tasks).doc(taskId).update({ data: patch });
      return {
        ok: true, changed: true, taskId: taskId,
        message: '已更新「' + (patch.name || task.name) + '」。'
      };
    }

    /* ================= 新增 ================= */
    if (!childId) return { ok: false, code: 'INVALID', message: '缺少孩子信息。' };

    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID, _id: childId }).limit(1).get();
    if (!(childRes.data || []).length) {
      return { ok: false, code: 'FORBIDDEN', message: '无权为该孩子添加任务。' };
    }

    const nm = String(name || '').trim().slice(0, 20);
    if (!nm) return { ok: false, code: 'INVALID', message: '请填写行为名称。' };

    const sc = Number(score);
    if (!isFinite(sc) || sc === 0) {
      return { ok: false, code: 'INVALID', message: '分值必须是非 0 整数(加分填正数,扣分填负数)。' };
    }
    if (Math.abs(sc) > 50) {
      return { ok: false, code: 'INVALID', message: '单项分值不要超过 50 分。' };
    }

    const cntRes = await db.collection(COLL.tasks)
      .where({ _openid: OPENID, childId: childId, active: true })
      .count();
    if (cntRes.total >= MAX_TASKS) {
      return { ok: false, code: 'INVALID', message: '任务太多了(最多 ' + MAX_TASKS + ' 项),先关掉一些不用的。' };
    }

    /* 同名检测:同名任务会让统计口径混乱 —— 但只提示,不拦(可能是有意的) */
    const dupRes = await db.collection(COLL.tasks)
      .where({ _openid: OPENID, childId: childId, name: nm, active: true })
      .limit(1).get();
    if ((dupRes.data || []).length) {
      return { ok: false, code: C.ERR.DUPLICATE, message: '已有一个叫「' + nm + '」的任务了。' };
    }

    const now = new Date();
    const addRes = await db.collection(COLL.tasks).add({
      data: {
        _openid: OPENID,
        childId: childId,
        name: nm,
        icon: '',
        score: Math.round(sc),
        category: VALID_CATS.indexOf(category) >= 0 ? category : 'study',
        medalTag: C.VALID_MEDAL_TAGS.indexOf(medalTag) >= 0 ? medalTag : '',
        preset: false,
        checkType: 'manual',
        active: true,
        sortOrder: 9000,
        createdAt: now,
        updatedAt: now
      }
    });

    return {
      ok: true, changed: true, created: true, taskId: addRes._id,
      message: '已添加「' + nm + '」' + (sc > 0 ? ' +' : ' ') + Math.round(sc) + ' 分。'
    };

  } catch (err) {
    console.error('[taskSave] failed', err);
    return { ok: false, code: 'SAVE_FAILED', message: '保存失败,请重试。' };
  }
};
