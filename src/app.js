/* 儿童成长积分打卡小程序 · app.js
   职责:全局初始化、云开发环境绑定、全局数据容器、双模式状态。

   ★ 关键约束:小程序没有 localStorage 式的同步存储可靠性保证,
     所有业务数据一律走云开发。wx.getStorageSync 只用于"非关键缓存"
     (如上次选中的日期),不作为数据真相来源。

   ★ 关于"模式"(原型稿 §四.3 双模式隔离)
     模式是**界面语义**,不是安全边界 —— 真正的隔离在服务端:
     服务端在孩子模式下根本不返回扣分数据(见 functions/homeData)。
     这里存的 mode 只影响前端渲染哪些模块、以及请求时带不带 mode 参数。

     所以 mode 存本地是可以的:改了它,服务端也不会给你扣分数据。
     这是这一层设计能成立的关键 —— 否则前端开关就是个摆设。

   ★ 家长模式解锁态(pinUnlocked)不同,它**只在内存里**
     不进 storage。理由:如果写进 storage,杀掉小程序再打开就还是解锁态,
     孩子只要等家长用完再打开就绕过去了。放内存 → 每次冷启动都要重输。
     代价是切后台再回来也要重输,这个取舍我选安全侧。 */

const { CLOUD_ENV } = require('./config');

App({
  globalData: {
    /* 当前孩子的完整信息(含双积分)。由首页拉取后填充 */
    child: null,
    /* 是否为首次启动(没有孩子记录) */
    isFirstRun: false,
    /* 云开发是否可用。不可用时页面要降级显示,不能白屏 */
    cloudReady: false,
    /* 'parent' | 'child' */
    mode: 'child',
    /* ★ 仅内存:家长模式本轮是否已解锁。冷启动必为 false */
    pinUnlocked: false,
    /* 是否已设置过家长密码(由服务端下发) */
    hasPin: false,
    /* 启动时间,用于性能观测 */
    launchAt: Date.now()
  },

  onLaunch() {
    this.initCloud();
    this.restoreMode();
  },

  /* 初始化云开发。失败不阻断启动 —— 页面会显示降级提示 */
  initCloud() {
    if (!wx.cloud) {
      console.error('[app] 当前基础库不支持云开发,请升级微信客户端');
      this.globalData.cloudReady = false;
      return;
    }
    try {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: false });
      this.globalData.cloudReady = true;
    } catch (err) {
      console.error('[app] 云开发初始化失败', err);
      this.globalData.cloudReady = false;
    }
  },

  /* 恢复上次的模式。★ 家长模式的"已解锁"状态不恢复 */
  restoreMode() {
    let m = 'child';
    try {
      m = wx.getStorageSync('cp_mode') || 'child';
    } catch (e) { m = 'child'; }
    this.globalData.mode = (m === 'parent') ? 'parent' : 'child';
    /* 恢复成家长模式时,解锁态必须是 false,逼一次验证 */
    this.globalData.pinUnlocked = false;
  },

  /* 切换模式。切到家长模式需要先通过 PIN 验证(由 pin 页负责) */
  setMode(m) {
    const next = (m === 'parent') ? 'parent' : 'child';
    this.globalData.mode = next;
    if (next === 'child') this.globalData.pinUnlocked = false;
    try { wx.setStorageSync('cp_mode', next); } catch (e) {}
    return next;
  },

  /* 当前是否处于"家长身份的家长模式"(能看扣分、能改分) */
  isParentView() {
    return this.globalData.mode === 'parent' && this.globalData.pinUnlocked;
  },

  /* 统一的云函数调用封装。
     为什么统一封装:
     1) 云函数返回结构是 { result: ... },页面里到处写 res.result 容易漏;
     2) 网络失败要统一提示,不能让每个页面各写一套;
     3) 自动带上 mode 参数 —— 否则每个页面都得记得传,漏一个就串味。 */
  callFunction(name, data = {}) {
    const payload = Object.assign({ mode: this.globalData.mode }, data);
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name,
        data: payload,
        success: (res) => resolve(res.result),
        fail: (err) => {
          console.error('[app] 云函数调用失败:', name, err);
          reject(err);
        }
      });
    });
  },

  /* 清空当前孩子缓存(切换资料后调用,强制各页重拉) */
  clearChildCache() {
    this.globalData.child = null;
  }
});
