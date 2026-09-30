/* 家长模式 PIN 锁(R3,2026-09-22 yang 拍板)

   ★ 为什么 PIN 存在云数据库,不是 wx.setStorageSync
     放在设备本地等于没锁 —— 换台手机登录同一个微信,PIN 就没了;
     更现实的是:孩子拿家长手机,清个小程序缓存就把锁清了。
     PIN 存在 children 文档里,由云函数校验,才是真的锁。

   ★ 为什么不用明文存
     虽然是家庭内部使用、威胁模型很弱,但明文存"家长密码"是个坏习惯:
     云开发控制台一点就能看到。用 scrypt(PIN + 随机盐)存,成本几乎为零。

   ★ 为什么要限次数
     4 位 PIN 只有 1 万种,不限制的话试 2 分钟就破了。
     连续错 5 次锁 10 分钟。**这条必须由服务端记**,否则前端限次可绕过。

   ★ 诚实说明这不是安全边界
     它防的是"孩子好奇点开",不是"有心人攻击"。
     真要严格隔离要做第二个微信账号 + openid 白名单,那是另一个量级的工程。 */

const crypto = require('crypto');

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 10;

/* scrypt 参数。N 取 16384 在云函数 100ms 内跑完,足够抵御 1 万种穷举 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync(String(pin), s, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  });
  return { hash: buf.toString('hex'), salt: s };
}

/**
 * 定长比较,避免时序侧信道。家庭场景其实无所谓,但这是一行代码的事。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验 PIN。
 * @param {Object} child  children 文档
 * @param {string} pin    用户输入的 4 位
 * @param {number} nowMs  当前时间戳(便于单测)
 * @returns {{ok:boolean, patch?:Object, code?:string}}
 *          ok=true 时 patch 是需要写回 children 的重置字段
 */
/**
 * ★★ patch 必须是**完整的 parentPin 对象**,不能只是要改的那几个字段
 *   (2026-09-23 修,由云函数日志定位)
 *
 *   原来的写法给调用方一个"局部字段补丁",调用方用
 *     parentPin: Object.assign({}, child.parentPin, v.patch)
 *   去合并。两个致命问题:
 *     ① 当 parentPin 还是 null 时(刚创建的孩子就是 null),
 *        Object.assign({}, null, {attempts:0}) = {attempts:0} ——
 *        **hash 和 salt 被整个丢掉**,密码等于没存。
 *     ② 调用方如果把 patch 当成"要写的字段"直接写进数据库,
 *        云开发会报 `Cannot create field 'attempts' in element {parentPin: null}`
 *        —— 不能往 null 里塞子字段。这正是用户遇到的那条报错。
 *
 *   现在统一返回完整对象,调用方改成 `parentPin: _.set(v.parentPin)`。
 *
 *   ★★ 但光"返回完整对象"还不够 —— 调用方**必须用 `_.set()` 包起来**(2026-09-23 补)
 *   云开发的 update 传入**裸 JS 对象**时,语义是"**按子字段合并**",不是替换:
 *     官方 Command.set 文档原文:传 `{ style: { color: 'red' } }` 只会把
 *     style.color 更新成 red,**不会**把 style 换成新对象。
 *   也就是说 SDK 会把它展开成 `parentPin.hash` / `parentPin.attempts`
 *   这样的**子字段路径**去写;而 parentPin 当前是 `null` 时,往 null 里建子字段
 *   被拒 ⇒ 依然报 `Cannot create field 'attempts' in element {parentPin: null}`,
 *   且是**多条** write errors(有几个子字段就错几条)。
 *   `_.set()` 才是"整个字段替换成这个对象"的意思。
 *   → 结论:光改返回值是治不好的,必须连调用方的写入指令一起改。
 *     这一课是用两轮线上报错换来的(第一轮只改了返回值,重传后照旧报错)。 */
function mergeSec(sec, patch) {
  return Object.assign({}, sec, patch);
}

/**
 * 这个孩子**是否真的设过可用的家长密码**。
 *
 * ★ 必须同时有 hash 和 salt 才算(2026-09-23)
 *   只看 hash 的话,那条"损坏"的记录会被当成"已设密码" ⇒
 *   前端弹「输入密码」、而任何密码都不可能通过 ⇒ 用户被彻底锁死、还没有出口。
 *   `homeData` 用它决定下发 hasPin,`setPin` 用它决定走"设置"还是"修改";
 *   前端据此显示「设置家长密码」还是「修改家长密码」。
 */
function pinUsable(child) {
  const sec = child && child.parentPin;
  return !!(sec && sec.hash && sec.salt);
}

function verifyPin(child, pin, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const sec = child && child.parentPin;

  /* 还没设过 PIN —— 视为家长身份,引导去设置。不在这里拦,由调用方决定 */
  if (!sec || !sec.hash) {
    return { ok: true, parentPin: null, code: 'NO_PIN_SET' };
  }

  /* ★ 密码数据损坏:有 hash 但没有 salt(2026-09-23,由用户云开发控制台截图确认)
     用户库里那条 parentPin 长成 `{ attempts: 0, hash: '2d4886e6…' }` —— **少了 salt**。
     而 hashPin() 在 salt 为空时会**现场随机生成**一个盐,算出来的 hash 自然
     永远对不上 ⇒ 任何密码都判错 ⇒ 连错 5 次锁 10 分钟 ⇒ 家长被永久锁在门外,
     而他自己压根没设过密码(是早期写入异常留下的残骸)。
     这里明确识别成 PIN_BROKEN:**不计数**、不写库,由前端引导重新设置一个。
     ★ 为什么不干脆放行:放行等于"谁能把 salt 弄坏谁就绕过密码"。
       正确解法是"损坏 = 视为未设置"(靠 pinUsable())+ 允许重设,
       既恢复可用性,又不新开口子。 */
  if (!sec.salt) {
    return { ok: false, code: 'PIN_BROKEN', parentPin: null };
  }

  /* 是否仍在锁定期内 */
  if (sec.lockedUntil && now < sec.lockedUntil) {
    return {
      ok: false,
      code: 'PIN_LOCKED',
      remainMs: sec.lockedUntil - now,
      parentPin: null
    };
  }

  /* ★ 没带密码 ≠ 密码错(2026-09-23 加,一次线上事故换来的)
     起因:首页「手动加分/扣分」的前端**根本没把 pin 传过来**,
     verifyPin 拿到 undefined 就走下面的"格式不对"分支判成 PIN_WRONG,
     并且 bumpAttempt **累计一次错误** —— 家长什么都没输错,
     连试 5 次就把自己锁死 10 分钟,还得干等。
     这里把"没带密码"单独分成 PIN_REQUIRED:**不计数、不写库**,
     由调用方引导用户去输一次。这样"谁来输密码"是前端的事,
     "密码对不对"才是这里的事,两件事不再互相污染。 */
  if (!String(pin || '').trim()) {
    return { ok: false, code: 'PIN_REQUIRED', parentPin: null };
  }

  /* 输入格式校验:必须正好 4 位数字(空值已在上面拦掉,这里管位数/非数字) */
  if (!/^\d{4}$/.test(String(pin || ''))) {
    return {
      ok: false,
      code: 'PIN_WRONG',
      parentPin: mergeSec(sec, bumpAttempt(sec, now).patch)
    };
  }

  const calc = hashPin(pin, sec.salt);

  if (safeEqual(calc.hash, sec.hash)) {
    return {
      ok: true,
      parentPin: mergeSec(sec, {
        attempts: 0, lockedUntil: null, lastVerifiedAt: new Date(now)
      })
    };
  }

  return {
    ok: false,
    code: 'PIN_WRONG',
    parentPin: mergeSec(sec, bumpAttempt(sec, now).patch)
  };
}

function bumpAttempt(sec, now) {
  const attempts = (Number(sec.attempts) || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    /* 锁定期内把计数清零,解锁后再错就重新数 5 次 */
    return {
      patch: { attempts: 0, lockedUntil: now + LOCK_MINUTES * 60 * 1000 },
      locked: true
    };
  }
  return { patch: { attempts: attempts, lockedUntil: null }, locked: false };
}

/**
 * 设置/修改 PIN。
 * @returns {{hash,salt}} 直接塞进 children.parentPin
 */
function setPin(pin) {
  const r = hashPin(pin);
  return {
    hash: r.hash,
    salt: r.salt,
    attempts: 0,
    lockedUntil: null,
    updatedAt: new Date()
  };
}

/**
 * 孩子模式下,把 children 文档里不该给孩子看的字段剥掉。
 * ★ 这个函数是"双模式隔离"的服务端最后一道防线:
 *   即使前端忘了过滤,或者孩子端改了前端代码,拿到的也是剥过的数据。
 */
function stripForChildMode(child) {
  if (!child) return child;
  const out = Object.assign({}, child);
  delete out.parentPin;          /* 密码哈希绝不能下发到前端 */
  delete out.penaltyLimit;       /* 上限策略不用给孩子看 */
  return out;
}

module.exports = {
  hashPin, verifyPin, setPin, stripForChildMode, pinUsable,
  MAX_ATTEMPTS, LOCK_MINUTES
};
