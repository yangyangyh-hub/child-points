/* 我的页 · 逻辑层(原型稿页面7 —— 个人主页与功能入口)

   ★ 这一页是"导航中转站 + 孩子名片",不承担业务写操作
     改昵称/年级/密码都在 sub/setting 里做,这里只跳转。
     理由:一页只做一件事,后续改设置页不用回头动这里。

   ★ 孩子模式与家长模式的入口不同
     孩子:规则 / 统计 / 日志  (只能看,不能改)
     家长:多出 任务管理(规则页内)/ 系统设置 / 家长密码
     入口的显隐由 isParent 控制,但**服务端仍然会拦**(没解锁拿不到扣分数据)。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');

Page({
  data: {
    loading: true,
    error: '',

    child: null,
    initial: '',
    mode: 'child',
    isParent: false,

    availablePoints: 0,
    lifetimePoints: 0,
    hasPin: false,

    streak: { current: 0, longest: 0 },
    medalUnlockedCount: 0,
    medalTotal: 0,
    taskCount: 0,

    /* 家长密码入口的副标题跟着状态变 */
    pinHint: ''
  },

  onShow() {
    /* 自定义 tabBar:高亮索引要本页自己指定(见 custom-tab-bar/index.js 注释) */
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTab(3);
    }
    const isParent = app().isParentView();
    this.setData({ mode: app().globalData.mode || 'child', isParent: isParent });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  onShareAppMessage() {
    return { title: '一起记录孩子的每一点进步', path: '/pages/index/index' };
  },

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    /* ★ 切 tab 回来不再"清空重来"(详见 medal.js 里同段注释)
       已有数据 ⇒ 静默刷新,画面不闪;首次进入才显示骨架屏。 */
    const silent = !!this._hasData;
    if (!silent) this.setData({ loading: true, error: '' });

    return cloud.api.homeData({}, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        if (silent) {
          wx.showToast({ title: (res && res.message) || '刷新失败', icon: 'none' });
          return;
        }
        self.setData({
          loading: false,
          error: (res && res.message) || '加载失败,下拉可以重试'
        });
        return;
      }
      self.applyData(res);
      self._hasData = true;
    })
      /* ★ 兜底:云函数层已保证不抛出,但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true,界面卡在骨架屏(2026-09-23 修)。 */
      .catch(function (err) {
        console.error('[loadAll] 渲染数据时出错', err);
        if (silent) {
          wx.showToast({ title: '刷新失败,下拉可重试', icon: 'none' });
          return;
        }
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },
  applyData(res) {
    /* 没有孩子记录 → 引导去设置。我的页不能显示成空壳 */
    if (!res.child) {
      this.setData({ loading: false, error: '', child: null });
      return;
    }

    const nickname = res.child.nickname || '宝贝';
    const hasPin = !!res.hasPin;
    app().globalData.hasPin = hasPin;
    app().globalData.child = res.child;

    this.setData({
      loading: false,
      error: '',
      child: res.child,
      initial: nickname.charAt(0),
      mode: res.mode || 'child',
      isParent: app().isParentView(),
      availablePoints: res.availablePoints || 0,
      lifetimePoints: res.lifetimePoints || 0,
      hasPin: hasPin,
      streak: res.streak || this.data.streak,
      medalUnlockedCount: res.medalUnlockedCount || 0,
      medalTotal: res.medalTotal || 0,
      taskCount: res.taskCount || 0,
      pinHint: hasPin ? '已开启,切模式时需要输入' : '还没设置,建议尽快设一个'
    });
  },

  /* ================= 模式切换 ================= */

  onSwitchMode() {
    const self = this;
    if (app().isParentView()) {
      app().setMode('child');
      cloud.toast('已切回孩子模式');
      this.setData({ mode: 'child', isParent: false });
      return;
    }
    /* 切到家长模式:走 PIN 页,成功后回到本页 */
    wx.navigateTo({
      url: '/pages/pin/pin?action=verify&next=back',
      fail: function () { cloud.toast('打开密码页失败'); }
    });
  },

  /* pin 页验证成功后回调 */
  onPinVerified() {
    this.setData({ mode: app().globalData.mode, isParent: app().isParentView() });
    const cb = this._pinCb;
    this._pinCb = null;
    if (typeof cb === 'function') { cb(); return; }
    this.loadAll();
  },

  /* ================= 导航 ================= */

  onGoRules() { wx.navigateTo({ url: '/sub/rules/rules' }); },
  onGoStats() { wx.navigateTo({ url: '/sub/stats/stats' }); },
  onGoLog() { wx.navigateTo({ url: '/sub/log/log' }); },
  /* ★ 2026-09-24 删掉了 onGoReward / onGoMedal:
     这两个是 switchTab 跳底部导航的「奖励」「勋章」,和底部按钮重复。
     奖励页、勋章页都从底部 tab 直接进,不需要从「我的」绕。 */

  onGoSetting() {
    const self = this;
    this.gotoParentUnlock(function () {
      wx.navigateTo({
        url: '/sub/setting/setting',
        fail: function () {
          /* 分包还在下载时会失败,提示重试比白跳更友好 */
          cloud.toast('页面正在加载,请再点一次');
        }
      });
    });
  },

  /* 家长密码:设置 or 修改 */
  onGoPin() {
    const self = this;
    const action = this.data.hasPin ? 'change' : 'set';
    this.gotoParentUnlock(function () {
      wx.navigateTo({
        url: '/pages/pin/pin?action=' + action + '&next=back',
        fail: function () { cloud.toast('打开密码页失败'); }
      });
    });
  },

  onRetry() { this.loadAll(); },

  onCreateChild() {
    /* 首次使用:跳到首页走初始化流程(初始化逻辑只在首页有一份) */
    wx.switchTab({ url: '/pages/index/index' });
  },

  /* ================= 工具 ================= */

  gotoParentUnlock(cb) {
    if (app().isParentView()) { cb(); return; }
    this._pinCb = cb;
    wx.navigateTo({
      url: '/pages/pin/pin?action=verify&next=back',
      fail: function () { cloud.toast('打开密码页失败'); }
    });
  }
});
