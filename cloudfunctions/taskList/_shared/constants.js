/* 云函数共享常量 —— 与 src/config.js 保持一致
   ⚠ 两边是同一套口径的两份副本。改一边必须同步改另一边。
   之所以不共享文件,是因为小程序端和云函数端是独立的两个部署单元,
   云函数无法 require 主包里的 src/ 目录。
   tests/deployLoad.test.js 会对账两边的集合名/分类/勋章/上限,改漏了会红。 */

/* 数据库集合名 —— 唯一真相在这里,各云函数不要再各写一份
   (历史上 14 个函数各自复制了一份 COLL,漏一个键运行时才会炸) */
const COLL = {
  children: 'children',
  tasks: 'tasks',
  checkins: 'checkins',
  points: 'point_records',
  redemptions: 'redemptions',
  rewards: 'rewards',
  medals: 'medal_records',
  logs: 'logs'
};

/* 兼容旧写法:函数里历史上把积分流水叫 records */
COLL.records = COLL.points;

const PENALTY_LIMIT = { min: 1, max: 30, def: 15 };
const STREAK_ALLOW_BREAK = 1;

/* 积分体系(R1/R2):
   - 加分  → availablePoints + score, lifetimePoints + score
   - 扣分  → availablePoints + score(lifetimePoints 不动)
   - 兑换  → availablePoints - cost  (lifetimePoints 不动)
   - 撤销冲正 → 按原记录的 kind 反向 */
const KIND = {
  BONUS: 'bonus',         // 加分(只增 total)
  PENALTY: 'penalty',     // 扣分(只减 available)
  REDEEM: 'redeem',       // 兑换(只减 available)
  REVOKE: 'revoke'        // 冲正(按 refKind 决定方向)
};

/* 流水 reason 取值 */
const REASON = {
  CHECKIN: 'checkin',       // 勾选/取消勾选任务
  MANUAL: 'manual',         // 家长手动加减分
  MAKEUP: 'makeup',         // 犯错补救
  REDEEM: 'redeem',         // 兑换奖励
  REVOKE: 'revoke'          // 冲正
};

/* 勋章定义 —— 与 src/config.js 的 MEDALS 一致 */
const MEDALS = [
  { key: 'daily_streak',    name: '每日坚持之星', icon: '🌟', desc: '连续打卡 7 天解锁',
    type: 'checkinStreak', threshold: 7,  allowBreak: 1 },
  { key: 'homework',        name: '作业认真之星', icon: '✏️', desc: '累计 20 天认真完成作业',
    type: 'tagCount', tag: 'homework', threshold: 20 },
  { key: 'self_discipline', name: '自律小达人',   icon: '⏰', desc: '晚上按时睡觉 + 中午午睡,连续 10 天',
    type: 'tagStreak', tags: ['sleep', 'nap'], threshold: 10, allowBreak: 1 },
  { key: 'emotion',         name: '情绪小勇士',   icon: '💛', desc: '连续 15 天不乱发脾气',
    type: 'absence', tag: 'emotion', threshold: 15, allowBreak: 1 },
  { key: 'reading',         name: '阅读小明星',   icon: '📖', desc: '累计阅读打卡 30 次',
    type: 'tagCount', tag: 'reading', threshold: 30 }
];

/* 预设任务 —— 与 src/config.js 的 PRESET_TASKS 一致 */
const PRESET_TASKS = [
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

  { name: '写作业拖拉磨蹭',       score: -3, category: 'study',       medalTag: '' },
  { name: '上课调皮讲话被批评',   score: -5, category: 'study',       medalTag: '' },
  { name: '乱发脾气、哭闹顶嘴',   score: -4, category: 'moral',       medalTag: 'emotion' },
  { name: '乱扔文具、物品凌乱',   score: -2, category: 'chores',      medalTag: '' },
  { name: '看电视/超时玩手机',    score: -3, category: 'life',        medalTag: '' },
  { name: '作业粗心错题过多',     score: -2, category: 'study',       medalTag: 'homework' },
  { name: '和小朋友打闹分寸过度', score: -5, category: 'moral',       medalTag: '' },
  { name: '中午不睡觉',           score: -2, category: 'life',        medalTag: 'nap' }
];

const PRESET_MAKEUPS = [
  { name: '主动道歉',       score: 2, category: 'moral' },
  { name: '额外整理房间',   score: 2, category: 'chores' },
  { name: '额外阅读10分钟', score: 2, category: 'study' }
];

const PRESET_REWARDS = [
  { name: '多看20分钟动画',   cost: 20,  tier: 'small', icon: '📺' },
  { name: '自主选择晚餐菜品', cost: 15,  tier: 'small', icon: '🍽️' },
  { name: '一次亲子游戏时间', cost: 30,  tier: 'small', icon: '🎲' },
  { name: '免一次家务',       cost: 25,  tier: 'small', icon: '🙌' },
  { name: '周末公园出游',     cost: 200, tier: 'large', icon: '🌳' },
  { name: '购买小文具/绘本',  cost: 350, tier: 'large', icon: '📖' },
  { name: '短途游玩/小玩具',  cost: 500, tier: 'large', icon: '🧸' }
];

/* ★ 下面两个也是同一个坑(2026-09-23 由"通用 C.xxx 引用检查"当场抓出,
     和 REWARD_TIERS 同一批漏网的):
       C.GRADES   —— settingSave 校验年级用,undefined ⇒ `undefined.indexOf` 抛错
                     ⇒ **保存孩子资料直接崩**(比 REWARD_TIERS 更严重,那是页面挂,
                        这是"改了存不进去")。
       C.COLUMNS  —— homeData 返回打卡两栏的定义,undefined ⇒ 前端拿不到栏目
                     (不抛错,属于"悄悄退化",更难发现)。 */
const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];

const COLUMNS = [
  { key: 'bonus', label: '今日好习惯加分', sub: '做得好的地方,夸一夸' },
  { key: 'penalty', label: '今日不良行为扣分', sub: '温和提醒,不打击' }
];

/* ★ 奖励分档(原型稿:小额日常 + 大额长期,杜绝一次性花光)
   ★★ 2026-09-23 补:这个常量**前端 config.js 里一直有,服务端却没有**。
     而 `functions/rewardList/index.js` 第 64 行写的是 `C.REWARD_TIERS.filter(...)`
     取档位名称 —— 拿到 undefined 就 `undefined.filter` 直接抛 TypeError,
     整个奖励页永远显示「加载失败,请重试。」。
     **对账测试也没抓到**:已有的跨层对账只比"两边都有的键"，
     不比"服务端用了但服务端没定义、只有前端有"的键 —— 那是盲区，已补断言。
     注意:index.js 里原本还硬编码了一份同样的 tiers 数组,现在统一用这里这一份。 */
const REWARD_TIERS = [
  { key: 'small', label: '小额即时奖励', hint: '日常可用,随时兑现' },
  { key: 'large', label: '大额长期奖励', hint: '攒一攒,更有期待' }
];

const CAT_LABEL = {
  study: '学习', chores: '劳动', independent: '独立',
  life: '生活', sport: '运动', moral: '品德'
};

/* 允许的勋章标签白名单 */
const VALID_MEDAL_TAGS = ['earlyrise', 'homework', 'reading', 'emotion', 'sleep', 'nap'];

const ERR = {
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID: 'INVALID',
  PENALTY_LIMIT: 'PENALTY_LIMIT',
  NOT_ENOUGH: 'NOT_ENOUGH',
  DUPLICATE: 'DUPLICATE',
  PIN_REQUIRED: 'PIN_REQUIRED',
  PIN_WRONG: 'PIN_WRONG',
  PIN_LOCKED: 'PIN_LOCKED',
  /* ★ 密码数据损坏:库里有 hash 但没有 salt ⇒ 任何密码都不可能验过
     (2026-09-23 从用户云开发控制台截图确认:parentPin = {attempts:0, hash:'...'})。
     这种状态**本来就没有保护作用**,但必须能识别出来,否则家长会被永久锁在外面。 */
  PIN_BROKEN: 'PIN_BROKEN'
};

/* 错误码 → 人话。前端直接展示,避免各页面各写一套 */
const ERR_MSG = {
  FORBIDDEN: '没有权限操作这份数据',
  NOT_FOUND: '找不到这条记录',
  INVALID: '参数不合法',
  PENALTY_LIMIT: '今天的扣分已经到上限啦',
  NOT_ENOUGH: '积分不够,再攒一攒吧',
  DUPLICATE: '这条已经记录过了',
  PIN_REQUIRED: '需要家长密码',
  PIN_WRONG: '密码不对,再试一次',
  PIN_LOCKED: '密码错误次数太多,请稍后再试',
  PIN_BROKEN: '家长密码数据异常,请到「设置」里重新设置一个'
};

module.exports = {
  COLL,
  PENALTY_LIMIT, STREAK_ALLOW_BREAK,
  KIND, REASON, ERR, ERR_MSG,
  MEDALS, PRESET_TASKS, PRESET_MAKEUPS, PRESET_REWARDS, REWARD_TIERS,
  CAT_LABEL, VALID_MEDAL_TAGS, GRADES, COLUMNS
};
