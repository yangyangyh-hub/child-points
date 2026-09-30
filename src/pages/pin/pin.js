/* PIN 页 · 逻辑层(家长密码输入 / 设置 / 修改)

   ★ 三种用途,靠 url 参数区分(不写三个页面,因为交互完全一样)
     action=verify  切到家长模式 / 批准兑换前解锁 —— 单次校验
     action=set     首次设置(未设过密码)
     action=change  修改(先验旧的,再输新的)

   ★ 校验成功后怎么"还"给上一个页面
     不用 globalData 传密码(密码不该在全局停留),
     而是回到上个页面后调它的 onPinVerified(code) ——
     code 只活在这一次调用里,页面自己决定要不要留着。

   ★ PIN 在内存里的痕迹
     app().globalData.pinUnlocked 只表示"这个会话已解锁",不存密码本身。
     冷启动必为 false —— 这是设计,不是遗漏。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');

const PIN_LEN = 4;

Page({
  data: {
    action: 'verify',
    next: 'back',           /* back(回到上个页面) | tab(切回首页) */
    title: '家长验证',
    subtitle: '',
    stage: 'main',          /* change 模式用:main(验旧) | new(设新) | confirm(再输一次) */

    input: '',
    dots: [false, false, false, false],
    submitting: false,
    errorText: '',

    /* 锁定倒计时 */
    locked: false,
    remainText: '',

    /* 修改模式下,暂存已验过的旧密码 */
    oldPin: '',
    firstNewPin: ''
  },

  onLoad(options) {
    const opt = options || {};
    const action = opt.action || 'verify';
    const next = opt.next || 'back';

    const titles = {
      verify: { t: '家长验证', s: '输入密码后进入家长模式' },
      set: { t: '设置家长密码', s: '设一个 4 位数字密码,孩子就不能随便改分了' },
      change: { t: '修改家长密码', s: '先输入现在的密码' }
    };
    const meta = titles[action] || titles.verify;

    this.setData({
      action: action,
      next: next,
      title: meta.t,
      subtitle: meta.s
    });

    /* 没设过密码就想验证 —— 直接引导去设置 */
    if (action === 'verify' && !app().globalData.hasPin) {
      this.setData({
        action: 'set',
        title: titles.set.t,
        subtitle: titles.set.s
      });
    }
  },

  /* ================= 数字键盘 ================= */

  onKey(e) {
    if (this.data.submitting || this.data.locked) return;
    const k = e.currentTarget.dataset.key;

    if (k === 'del') {
      const v = this.data.input.slice(0, -1);
      this.patchInput(v);
      return;
    }
    if (k === 'clear') {
      this.patchInput('');
      return;
    }
    if (!/^\d$/.test(k)) return;
    if (this.data.input.length >= PIN_LEN) return;

    const v = this.data.input + k;
    this.patchInput(v);

    /* 输满 4 位自动提交 —— 少一个"确定"按钮,小朋友/家长都快 */
    if (v.length === PIN_LEN) {
      const self = this;
      setTimeout(function () { self.submit(v); }, 120);
    }
  },

  patchInput(v) {
    const dots = [false, false, false, false];
    for (let i = 0; i < v.length; i++) dots[i] = true;
    this.setData({ input: v, dots: dots, errorText: '' });
  },

  /* ================= 提交 ================= */

  /* 切到家长模式的唯一出口 —— app 负责发内存标志和落 mode */
  enterParentMode() {
    app().globalData.pinUnlocked = true;
    app().setMode('parent');
  },

  submit(code) {
    const action = this.data.action;
    if (action === 'verify') { this.doVerify(code); return; }
    if (action === 'set') { this.doSet(code); return; }
    this.doChange(code);
  },

  doVerify(code) {
    const self = this;
    this.setData({ submitting: true });
    cloud.api.setPin({
      action: 'verify', pin: code,
      childId: (app().globalData.child && app().globalData.child._id) || ''
    }, { quiet: true }).then(function (res) {
      self.setData({ submitting: false });

      if (res && res.ok) {
        self.enterParentMode();
        cloud.toast('已进入家长模式', 'success');

        /* 把密码交回调用方 —— 批准兑换等操作需要原样带上 */
        if (self.data.next === 'tab') {
          wx.switchTab({ url: '/pages/index/index' });
        } else {
          self.backWithPin(code);
        }
        return;
      }

      self.onVerifyFailed(res);
    }).catch(function (err) {
      /* ★ 兜底:不接住的话 submitting 永远 true ⇒ 数字键盘永久禁用,用户点不动
         (2026-09-23 修。cloud.js 已保证不抛出,这里防的是回调内部抛错) */
      console.error('[pin] doVerify 出错', err);
      self.setData({ submitting: false });
      cloud.toast('操作失败,请重试');
    });
  },

  doSet(code) {
    const self = this;
    this.setData({ submitting: true });
    cloud.api.setPin({
      action: 'set', pin: code,
      childId: (app().globalData.child && app().globalData.child._id) || ''
    }, { quiet: true }).then(function (res) {
      self.setData({ submitting: false });
      if (res && res.ok) {
        app().globalData.hasPin = true;
        self.enterParentMode();
        cloud.toast('密码已设置', 'success');
        if (self.data.next === 'tab') {
          wx.switchTab({ url: '/pages/index/index' });
        } else {
          self.backWithPin(code);
        }
        return;
      }
      self.fail((res && res.message) || '设置失败,请重试');
    }).catch(function (err) {
      console.error('[pin] doSet 出错', err);
      self.setData({ submitting: false });
      cloud.toast('设置失败,请重试');
    });
  },

  doChange(code) {
    /* 三步:验旧 → 输新 → 再输一次确认 */
    if (this.data.stage === 'main') {
      const self = this;
      this.setData({ submitting: true });
      /* 用 verify 先确认旧密码正确,再进入输新密码阶段 */
      cloud.api.setPin({
        action: 'verify', pin: code,
        childId: (app().globalData.child && app().globalData.child._id) || ''
      }, { quiet: true }).then(function (res) {
        self.setData({ submitting: false });
        if (res && res.ok) {
          self.setData({
            stage: 'new',
            oldPin: code,
            input: '',
            dots: [false, false, false, false],
            title: '设置新密码',
            subtitle: '再想一个 4 位数字'
          });
          return;
        }
        self.onVerifyFailed(res);
      }).catch(function (err) {
        console.error('[pin] doChange(验旧) 出错', err);
        self.setData({ submitting: false });
        cloud.toast('操作失败,请重试');
      });
      return;
    }

    if (this.data.stage === 'new') {
      if (/^(\d)\1{3}$/.test(code) ||
          ['1234', '4321', '0123', '3210', '0000', '1111', '2222'].indexOf(code) >= 0) {
        this.fail('这个密码太容易猜到了,换一个吧');
        return;
      }
      this.setData({
        stage: 'confirm',
        firstNewPin: code,
        input: '',
        dots: [false, false, false, false],
        title: '再输一次',
        subtitle: '确认一下新密码'
      });
      return;
    }

    /* stage = confirm */
    if (code !== this.data.firstNewPin) {
      this.fail('两次输入不一样,重新输一遍');
      this.setData({ stage: 'new', firstNewPin: '' });
      return;
    }

    const self = this;
    this.setData({ submitting: true });
    cloud.api.setPin({
      action: 'change', pin: code, oldPin: this.data.oldPin,
      childId: (app().globalData.child && app().globalData.child._id) || ''
    }, { quiet: true }).then(function (res) {
      self.setData({ submitting: false });
      if (res && res.ok) {
        cloud.toast('密码已修改', 'success');
        if (self.data.next === 'tab') {
          wx.switchTab({ url: '/pages/index/index' });
        } else {
          self.backWithPin(code);
        }
        return;
      }
      self.fail((res && res.message) || '修改失败,请重试');
      self.setData({ stage: 'main', title: '修改家长密码', subtitle: '先输入现在的密码' });
    }).catch(function (err) {
      console.error('[pin] doChange(改密) 出错', err);
      self.setData({ submitting: false, stage: 'main', title: '修改家长密码', subtitle: '先输入现在的密码' });
      cloud.toast('修改失败,请重试');
    });
  },

  /* 校验失败:区分"密码错"和"被锁定" */
  onVerifyFailed(res) {
    const code = res && res.code;
    if (code === 'PIN_LOCKED') {
      this.startLock(res.remainMs || 0, (res && res.message) || '密码错误次数太多');
      return;
    }
    this.fail((res && res.message) || '密码不对,再试一次');
  },

  fail(msg) {
    this.setData({ input: '', dots: [false, false, false, false], errorText: msg });
    cloud.shake('#pinPad');
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
  },

  /* 锁定倒计时:每秒刷一次,归零后自动解锁 */
  startLock(remainMs, prefix) {
    const self = this;
    let ms = remainMs > 0 ? remainMs : 10 * 60 * 1000;
    if (this._lockTimer) { clearInterval(this._lockTimer); this._lockTimer = null; }

    const render = function () {
      if (ms <= 0) {
        clearInterval(self._lockTimer);
        self._lockTimer = null;
        self.setData({ locked: false, remainText: '', errorText: '' });
        self.patchInput('');
        return;
      }
      const total = Math.ceil(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      self.setData({
        locked: true,
        errorText: prefix || '密码错误次数太多',
        remainText: m + ' 分 ' + (s < 10 ? '0' + s : s) + ' 秒后可重试'
      });
      ms -= 1000;
    };
    render();
    this._lockTimer = setInterval(render, 1000);
  },

  /* ================= 返回上一个页面 ================= */

  backWithPin(pinCode) {
    const pages = getCurrentPages();
    const prev = pages[pages.length - 2];
    if (prev && typeof prev.onPinVerified === 'function') {
      prev.onPinVerified(pinCode);
    }
    wx.navigateBack({
      fail: function () {
        /* 没有上一页(比如从分享链接直接进来)就回首页 */
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  },

  onBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onUnload() {
    if (this._lockTimer) { clearInterval(this._lockTimer); this._lockTimer = null; }
  }
});
