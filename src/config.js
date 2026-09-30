/* 儿童成长积分打卡小程序 · 全局配置

   ★ 云环境 ID 只写在这里。不要散落到各个页面 ——
     以后切测试/正式环境只改这一个文件。

   ★ 本文件同时是「前端口径」的唯一定义处:
     预设任务、勋章条件、扣分上限默认值等都从这里取,
     云函数侧有对应的 functions/_shared/constants.js,两边必须一致。 */

module.exports = {
  /* 云开发环境 ID。来自微信开发者工具 → 云开发控制台 */
  CLOUD_ENV: 'cloud1-d5g6qwwtfed18c10c',

  /* 集合名。集中定义避免拼写不一致导致"查不到数据"这种难查的问题。
     ★ 服务端 cloudfunctions/_shared/constants.js 里有一份**同值的 COLL**，
       两边必须完全一致，由 tests/deployLoad.test.js 自动对账。 */
  COLL: {
    children: 'children',
    tasks: 'tasks',
    checkins: 'checkins',
    points: 'point_records',
    redemptions: 'redemptions',
    rewards: 'rewards',
    medals: 'medal_records',
    logs: 'logs'
  },

  /* 任务分类(二级标签)。原型稿的首页是「加分项/扣分项」两栏,
     这 6 类作为两栏内部的细分标签保留 */
  CATEGORIES: [
    { key: 'study', label: '学习', icon: '📚' },
    { key: 'chores', label: '劳动', icon: '🧹' },
    { key: 'independent', label: '独立', icon: '🎒' },
    { key: 'life', label: '生活', icon: '🍚' },
    { key: 'sport', label: '运动', icon: '⚽' },
    { key: 'moral', label: '品德', icon: '💛' }
  ],

  /* 打卡模块的两栏(原型稿页面1 中部) */
  COLUMNS: [
    { key: 'bonus', label: '今日好习惯加分', sub: '做得好的地方,夸一夸' },
    { key: 'penalty', label: '今日不良行为扣分', sub: '温和提醒,不打击' }
  ],

  /* 默认任务模板(原型稿给定的 17 条)
     preset=true 的项系统自带、家长只能开关和改分,不能删除
     medalTag 见 config.MEDAL_RULES,是勋章判定的钩子 */
  PRESET_TASKS: [
    /* ---- 加分项(原型稿 8 条 + R6 新增 2 条) ---- */
    { name: '按时起床',             score: 2,  category: 'life',        medalTag: 'earlyrise' },
    { name: '自主洗漱整理',         score: 2,  category: 'independent', medalTag: '' },
    { name: '认真完成学校作业',     score: 5,  category: 'study',       medalTag: 'homework' },
    { name: '书写工整认真',         score: 3,  category: 'study',       medalTag: 'homework' },
    { name: '每日阅读20分钟',       score: 3,  category: 'study',       medalTag: 'reading' },
    { name: '主动做家务',           score: 2,  category: 'chores',      medalTag: '' },
    { name: '上课得到老师表扬',     score: 5,  category: 'study',       medalTag: '' },
    { name: '情绪稳定不乱发脾气',   score: 3,  category: 'moral',       medalTag: 'emotion' },
    { name: '晚上按时睡觉',         score: 3,  category: 'life',        medalTag: 'sleep' },
    { name: '中午按时午睡',         score: 2,  category: 'life',        medalTag: 'nap' },

    /* ---- 扣分项(原型稿 7 条 + R6 新增 1 条) ---- */
    { name: '写作业拖拉磨蹭',       score: -3, category: 'study',       medalTag: '' },
    { name: '上课调皮讲话被批评',   score: -5, category: 'study',       medalTag: '' },
    { name: '乱发脾气、哭闹顶嘴',   score: -4, category: 'moral',       medalTag: 'emotion' },
    { name: '乱扔文具、物品凌乱',   score: -2, category: 'chores',      medalTag: '' },
    { name: '看电视/超时玩手机',    score: -3, category: 'life',        medalTag: '' },
    { name: '作业粗心错题过多',     score: -2, category: 'study',       medalTag: 'homework' },
    { name: '和小朋友打闹分寸过度', score: -5, category: 'moral',       medalTag: '' },
    { name: '中午不睡觉',           score: -2, category: 'life',        medalTag: 'nap' }
  ],

  /* 补救任务模板(原型稿「核心独创机制」1)
     扣分后可勾选补救,把分赚回来 —— 只加「可用积分」 */
  PRESET_MAKEUPS: [
    { name: '主动道歉',       score: 2, category: 'moral' },
    { name: '额外整理房间',   score: 2, category: 'chores' },
    { name: '额外阅读10分钟', score: 2, category: 'study' }
  ],

  /* 默认奖励模板(原型稿页面3 的 7 条) */
  PRESET_REWARDS: [
    { name: '多看20分钟动画',   cost: 20,  tier: 'small', icon: '📺' },
    { name: '自主选择晚餐菜品', cost: 15,  tier: 'small', icon: '🍽️' },
    { name: '一次亲子游戏时间', cost: 30,  tier: 'small', icon: '🎲' },
    { name: '免一次家务',       cost: 25,  tier: 'small', icon: '🙌' },
    { name: '周末公园出游',     cost: 200, tier: 'large', icon: '🌳' },
    { name: '购买小文具/绘本',  cost: 350, tier: 'large', icon: '📖' },
    { name: '短途游玩/小玩具',  cost: 500, tier: 'large', icon: '🧸' }
  ],

  /* 奖励分档(原型稿:小额日常 + 大额长期,杜绝一次性花光) */
  REWARD_TIERS: [
    { key: 'small', label: '小额即时奖励', hint: '日常可用,随时兑现' },
    { key: 'large', label: '大额长期奖励', hint: '攒一攒,更有期待' }
  ],

  /* ★ 勋章定义(原型稿 5 枚,R6 调整了「自律小达人」)
     type 决定判定算法,见 cloudfunctions/_shared/medal.js
       streak   连续 N 天满足 tag 条件
       count    累计 N 天满足 tag 条件
       absence  连续 N 天无 tag 扣分记录 */
  MEDALS: [
    {
      key: 'daily_streak', name: '每日坚持之星', icon: '🌟',
      desc: '连续打卡 7 天解锁',
      type: 'checkinStreak', threshold: 7, allowBreak: 1
    },
    {
      key: 'homework', name: '作业认真之星', icon: '✏️',
      desc: '累计 20 天认真完成作业',
      type: 'tagCount', tag: 'homework', threshold: 20
    },
    {
      key: 'self_discipline', name: '自律小达人', icon: '⏰',
      desc: '晚上按时睡觉 + 中午午睡,连续 10 天',
      type: 'tagStreak', tags: ['sleep', 'nap'], threshold: 10, allowBreak: 1
    },
    {
      key: 'emotion', name: '情绪小勇士', icon: '💛',
      desc: '连续 15 天不乱发脾气',
      type: 'absence', tag: 'emotion', threshold: 15, allowBreak: 1
    },
    {
      key: 'reading', name: '阅读小明星', icon: '📖',
      desc: '累计阅读打卡 30 次',
      type: 'tagCount', tag: 'reading', threshold: 30
    }
  ],

  /* 单日扣分上限的可选范围与默认值(R4) */
  PENALTY_LIMIT: {
    min: 1,
    max: 30,
    def: 15
  },

  /* 连续打卡允许断签次数(R10:断 1 次不断链,第 2 次从 0 重算) */
  STREAK_ALLOW_BREAK: 1,

  /* 家长模式 PIN 长度 */
  PIN_LENGTH: 4,

  /* 各卡片常驻条数,超出折叠。集中定义便于调整 */
  KEEP: {
    tasks: 6,
    records: 10,
    logs: 3
  },

  /* 年级选项(原型稿页面7:孩子信息设置含年级) */
  GRADES: ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级']
};
