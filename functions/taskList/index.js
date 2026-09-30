/* 云函数 · taskList —— 行为规则库(原型稿页面2)

   返回「加分项」「扣分项」两组,含预设标记与关闭的项。
   与 homeData 的区别:homeData 只给 active 的、且按两栏给"今日可勾选"的;
   这里给**全部**(含已关闭),因为规则库要能重新打开。 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const C = require('./_shared/constants');

const COLL = { children: 'children', tasks: 'tasks' };

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { childId } = event || {};

  try {
    const childRes = await db.collection(COLL.children)
      .where({ _openid: OPENID }).limit(1).get();
    const child = childRes.data[0] || null;
    if (!child) return { ok: true, bonus: [], penalty: [], total: 0 };

    const cid = childId || child._id;

    /* 规则库要看到全部,包括已关闭的 —— 所以不筛 active */
    const res = await db.collection(COLL.tasks)
      .where({ _openid: OPENID, childId: cid })
      .orderBy('sortOrder', 'asc')
      .orderBy('createdAt', 'asc')
      .limit(200)
      .get();

    const all = (res.data || []).filter(function (t) {
      return t.active !== false || t.deletedAt === undefined || t.deletedAt === null;
    }).map(function (t) {
      const score = Number(t.score) || 0;
      return {
        _id: t._id,
        name: t.name,
        score: score,
        scoreText: (score > 0 ? '+' : '') + score,
        category: t.category || '',
        categoryLabel: C.CAT_LABEL[t.category] || '未分类',
        medalTag: t.medalTag || '',
        medalLabel: medalLabel(t.medalTag),
        preset: !!t.preset,
        active: t.active !== false,
        /* 预设不可删,前端据此隐藏删除按钮并给出说明 */
        canDelete: !t.preset
      };
    });

    return {
      ok: true,
      childId: cid,
      bonus: all.filter(function (t) { return t.score > 0; }),
      penalty: all.filter(function (t) { return t.score < 0; }),
      total: all.length,
      /* 勋章标签的可选列表,前端表单用 */
      medalTagOptions: C.VALID_MEDAL_TAGS.map(function (k) {
        return { key: k, label: medalLabel(k) };
      }),
      categories: Object.keys(C.CAT_LABEL).map(function (k) {
        return { key: k, label: C.CAT_LABEL[k] };
      })
    };

  } catch (err) {
    console.error('[taskList] failed', err);
    return { ok: false, code: 'LOAD_FAILED', message: '加载失败,请重试。' };
  }
};

/* 勋章标签 → 人话。家长建任务时要能看懂这个标签是干什么的 */
function medalLabel(tag) {
  const map = {
    earlyrise: '早起(暂未用于勋章)',
    homework: '作业类 → 作业认真之星',
    reading: '阅读类 → 阅读小明星',
    emotion: '情绪类 → 情绪小勇士',
    sleep: '晚上睡觉 → 自律小达人',
    nap: '中午午睡 → 自律小达人'
  };
  return map[tag] || '';
}
