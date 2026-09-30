/* 云函数调用层 —— 页面只跟这一层打交道,不直接写 wx.cloud.callFunction

   ★ 为什么再包一层(app.js 里已经有一次封装)
     app.js 的封装负责"带上 mode + 解开 result";这一层负责**业务语义**:
     统一错误提示、统一 ok=false 的处理、把错误码翻成人话。
     页面里就不用每次都写 if (!res.ok) wx.showToast(...)。

   ★ 关于 toast 的取舍
     错误提示默认弹(showToast),但可以通过 quiet 关掉 —— 因为有些场景
     页面自己要用更醒目的方式呈现(比如扣分超限要弹 Modal 让家长选"突破")。 */

const app = () => getApp();

/* 超时阈值。12 秒:云函数冷启动实测 1~3 秒,留足余量又不至于让用户干等 */
const TIMEOUT_MS = 12000;

/* 错误码 → 人话兜底。服务端一般已经给了 message,这里只兜没给的 */
const CODE_MSG = {
  FORBIDDEN: '没有权限操作这份数据',
  NOT_FOUND: '找不到这条记录',
  INVALID: '参数不合法',
  PENALTY_LIMIT: '今天的扣分已经到上限啦',
  NOT_ENOUGH: '积分不够,再攒一攒吧',
  DUPLICATE: '这条已经记录过了',
  PIN_REQUIRED: '需要家长密码',
  PIN_WRONG: '密码不对,再试一次',
  PIN_LOCKED: '密码错误次数太多,请稍后再试',
  /* 库里的密码数据坏了(有 hash 无 salt)⇒ 任何密码都验不过。
     这种状态没有保护作用,需要引导家长去设置页重新设一个。 */
  PIN_BROKEN: '家长密码数据异常,请到「设置」里重新设置一个',
  NETWORK: '网络不太好,请重试',
  LOAD_FAILED: '加载失败,请重试',
  SAVE_FAILED: '保存失败,请重试',
  TX_FAILED: '操作失败,请重试'
};

/**
 * 调用云函数。
 *
 * ★★ 本函数**永不抛出** —— 这是它存在的意义之一（2026-09-23 修）
 *   历史 bug：loadAll() 里只有 .then 没有 .catch，一旦这里抛出异常，
 *   页面的 loading 就永远停在 true，界面卡在骨架屏、一个字都不显示。
 *   而抛出**确实会发生**，且在三种情况下是**同步抛**（连 .then 都进不去）：
 *     1) getApp() 返回 undefined —— App 还没就绪
 *     2) app.callFunction 不存在 —— app.js 加载失败
 *     3) wx.cloud 不存在 —— 基础库太低不支持云开发
 *   同步抛错发生在 Promise 构造之前，调用方**无法用 .catch 兜住**，
 *   所以必须在**这里**兜住。改动见下方 try/catch。
 *
 * @param {string} name  云函数名
 * @param {Object} data  入参
 * @param {Object} [opt] { quiet: 不在失败时自动 toast }
 * @returns {Promise<Object>} 云函数返回体(已含 ok 字段)，**失败时返回 {ok:false} 而非抛出**
 */
function call(name, data, opt) {
  const options = opt || {};
  const FAIL = { ok: false, code: 'NETWORK', message: '网络不太好,请重试' };

  /* ★ 第一道防线:把"取 app 实例 + 发起调用"整体包起来。
     这三行里任何一行都可能同步抛错，必须在这里拦住。 */
  let pending;
  try {
    const instance = app();
    if (!instance || typeof instance.callFunction !== 'function') {
      console.error('[cloud] App 实例不可用,无法调用', name, instance);
      if (!options.quiet) toast('云开发还没准备好,请重开小程序');
      return Promise.resolve({ ok: false, code: 'NETWORK', message: '云开发还没准备好,请重开小程序' });
    }
    pending = instance.callFunction(name, data || {});
  } catch (err) {
    console.error('[cloud] 发起调用时同步出错', name, err);
    if (!options.quiet) toast('云开发初始化失败,请重开小程序');
    return Promise.resolve({ ok: false, code: 'NETWORK', message: '云开发初始化失败,请重开小程序' });
  }

  /* ★ 第二道防线:异步失败(网络、云函数不存在、云函数内部异常) */
  const chain = Promise.resolve(pending).then(function (res) {
    if (!res) {
      if (!options.quiet) toast('服务没有响应,请重试');
      return { ok: false, code: 'EMPTY', message: '服务没有响应' };
    }
    if (res.ok === false && !options.quiet) {
      toast(res.message || CODE_MSG[res.code] || '操作失败');
    }
    return res;
  }).catch(function (err) {
    console.error('[cloud] 调用失败', name, err);
    if (!options.quiet) toast('网络不太好,请重试');
    return FAIL;
  });

  /* ★ 第三道防线:超时(2026-09-23 加)
     前两道防线挡的是"失败",这一道挡的是"永远不返回"。
     云调用可能既不 resolve 也不 reject(网络半开、云函数冷启动挂住),
     这时调用方的 .then 和 .catch 都永远不触发,loading 就永远停在 true,
     界面卡在骨架屏、一个字都没有 —— 用户完全不知道发生了什么。
     Promise.race 保证无论另一端怎样,这里一定在 TIMEOUT_MS 后落一个结果。
     ★ 它还有诊断价值:如果加了超时后界面**依然**是骨架屏,
       说明页面 JS 压根没执行到这一步,问题在编译/WXML 层,不在云调用。 */
  let timer = null;
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () {
      console.error('[cloud] 调用超时', name, TIMEOUT_MS + 'ms');
      resolve({ ok: false, code: 'TIMEOUT', message: '加载有点慢,下拉可以重试' });
    }, TIMEOUT_MS);
  });

  /* ★ 必须清掉定时器(2026-09-23 修,有自己的 bug 史):
     Promise.race 只是"谁先落谁算数",**输的那一端不会被取消**。
     不清的话,每一次**成功**的调用也会在 12 秒后照样打出
     「[cloud] 调用超时 xxx 12000ms」的红色日志 ——
     实测被当成真报错排查了一轮。它不是功能故障,但会把日志变成噪音,
     把真正的超时淹掉。 */
  return Promise.race([chain, timeout]).then(function (r) {
    if (timer) { clearTimeout(timer); timer = null; }
    return r;
  });
}

function toast(msg, icon) {
  wx.showToast({ title: String(msg || ''), icon: icon || 'none', duration: 2000 });
}

function loading(msg) {
  wx.showLoading({ title: msg || '加载中', mask: true });
}
function hideLoading() {
  try { wx.hideLoading(); } catch (e) {}
}

/* ---------- 各云函数的语义化包装 ---------- */

const api = {
  /* 首页 */
  homeData(data, opt) { return call('homeData', data, opt); },
  /* ★ 原 refreshChild(childId) 已删除(2026-09-23):定义了但**没有任何页面调用**。
     本想用于"勾选后只刷积分数字",但首页 refreshToday 还需要
     bonusTotal / penaltyRemain / streak 这些今日统计,childOnly 分支不返回,
     所以只能走全量 homeData ⇒ 这个轻量接口没有真实使用场景,属死代码。
     服务端 homeData 的 childOnly 分支保留(无害,将来真需要时可用)。 */

  /* 首次创建 */
  initChild(data) { return call('initChild', data); },

  /* ★ 打卡与改分 */
  taskToggle(data, opt) { return call('taskToggle', data, opt); },
  adjustPoints(data, opt) { return call('adjustPoints', data, opt); },

  /* 行为规则库 */
  taskList(data) { return call('taskList', data); },
  taskSave(data) { return call('taskSave', data); },

  /* 奖励 */
  rewardList(data) { return call('rewardList', data); },
  rewardSave(data) { return call('rewardSave', data); },
  redeemReward(data, opt) { return call('redeemReward', data, opt); },

  /* 统计 */
  statsData(data) { return call('statsData', data); },

  /* 日志 */
  logSave(data) { return call('logSave', data); },
  logList(data) { return call('logList', data); },

  /* 设置与密码 */
  settingSave(data) { return call('settingSave', data); },
  setPin(data, opt) { return call('setPin', data, opt); },

  /* 成绩记录 / 获得荣誉(2026-09-24 新增,只在勋章页用)
     一个云函数管两块:kind='score'|'honor',act='list'|'add'|'update'|'remove' */
  achievement(data, opt) { return call('achievement', data, opt); },

  /* ★ 清空全部数据(2026-09-29 新增,只在设置页用)
     整个项目唯一不可逆的操作:删掉孩子资料 + 全部打卡/积分/奖励/勋章/日志/成绩/荣誉。
     服务端强制校验家长密码,且必须带 confirm:true —— 前端必须先弹确认再调。
     调用方要负责把 globalData.child 清掉并回首页,否则界面还停留在"有孩子"的状态。 */
  resetAll(data, opt) { return call('resetAll', data, opt); }
};

/* ---------- 二次确认。统一文案风格,避免各页面自己拼 ---------- */
function confirm(content, title) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '确认一下',
      content: String(content || ''),
      confirmText: '确定',
      cancelText: '再想想',
      success: function (r) { resolve(!!r.confirm); },
      fail: function () { resolve(false); }
    });
  });
}

/* 输入框。textarea 用 wx.showModal 的 editable 只能单行,故简单场景够用 */
function prompt(title, placeholder, value) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title,
      editable: true,
      placeholderText: placeholder || '',
      content: value || '',
      success: function (r) { resolve(r.confirm ? (r.content || '') : null); },
      fail: function () { resolve(null); }
    });
  });
}

/* 底部选择。返回下标,取消返回 -1 */
function choose(list, title) {
  return new Promise(function (resolve) {
    wx.showActionSheet({
      itemList: list.slice(0, 6),
      alertText: title || '',
      success: function (r) { resolve(r.tapIndex); },
      fail: function () { resolve(-1); }
    });
  });
}

/* 抖动动画提示(用于 PIN 输错)—— 比 toast 更贴合"输密码"的交互 */
function shake(selector) {
  wx.createSelectorQuery().select(selector).node && wx.vibrateShort &&
    wx.vibrateShort({ type: 'medium' });
}

module.exports = { call, api, toast, loading, hideLoading, confirm, prompt, choose, shake, CODE_MSG };
