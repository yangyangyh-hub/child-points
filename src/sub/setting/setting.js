/* 设置页 · 逻辑层(原型稿页面7 —— 系统设置中心)

   ★ 四项设置,分三组
     孩子信息(昵称 / 年级 / 头像) · 扣分上限 · 提醒 · 重置
     昵称和年级改完必须**立刻反映到全局** —— 否则回首页还是老名字

   ★ 关于「每日打卡提醒」的能力边界(必须如实告诉家长)
     小程序没有后台定时推送。这里的提醒落地为"下次打开小程序时,
     如果已过提醒时间且今天没打卡,首页给一条提示"。
     它**不会**到点响铃 —— 这一点在界面上要写清楚,不能含糊。

   ★ 重置今日数据必须走两步 + PIN
     第一步发 confirmReset:false 拿到"需要确认"的回应,再由用户二次确认;
     第二步带 confirmReset:true + PIN 真正执行。多这一步是因为它不可逆。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
/* 注:`const app = getApp()` 曾在模块加载时就取,那时 App 可能还没就绪,
   拿到 undefined 之后所有 app.xxx 都会炸。改成函数、用时再取(2026-09-23)。 */
const cloud = require('../../lib/cloud');
const dateUtil = require('../../utils/date');
const config = require('../../config');

Page({
  data: {
    loading: true,
    error: '',
    saving: false,

    /* 孩子信息 */
    nickname: '',
    grade: '',
    avatar: '',

    gradeOptions: [],
    gradeIndex: -1,

    /* 扣分上限 */
    penaltyLimit: 15,
    penaltyLimitMin: 1,
    penaltyLimitMax: 30,
    limitOptions: [],

    /* 提醒 */
    remindEnabled: false,
    remindTime: '19:00',

    /* 重置 */
    resetDate: '',
    resetDateText: '',

    /* 家长密码是否已设置(决定卡片文案:设置 / 修改) */
    hasPin: false
  },

  onLoad() {
    const today = dateUtil.today();

    /* 上限下拉:1–30 全列出来,不给加减按钮 —— 家长一眼能看全范围 */
    const opts = [];
    for (let i = config.PENALTY_LIMIT.min; i <= config.PENALTY_LIMIT.max; i++) {
      opts.push(String(i));
    }

    this.setData({
      resetDate: today,
      resetDateText: dateUtil.monthDayText(today) + ' ' + dateUtil.weekdayCn(today),
      limitOptions: opts,
      gradeOptions: config.GRADES,
      penaltyLimitMin: config.PENALTY_LIMIT.min,
      penaltyLimitMax: config.PENALTY_LIMIT.max
    });
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });

    return cloud.api.homeData({}, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        self.setData({
          loading: false,
          error: (res && res.message) || '加载失败,下拉可以重试'
        });
        return;
      }
      const s = res.settings || {};
      /* ★ 同步全局缓存 —— onSaveBase 要靠它判断"该创建还是该修改"。
         若这里不同步,用户从「我的」等非首页路径进入设置页时,
         globalData.child 可能还是 null,会导致本该修改却走了创建分支。 */
      if (res.child) app().globalData.child = res.child;

      self.setData({
        loading: false,
        error: '',
        nickname: s.nickname || (res.child && res.child.nickname) || '',
        grade: s.grade || (res.child && res.child.grade) || '',
        avatar: s.avatar || (res.child && res.child.avatar) || '',
        gradeIndex: self.data.gradeOptions.indexOf(s.grade || ''),
        penaltyLimit: (s.penaltyLimit === null || s.penaltyLimit === undefined)
          ? 15 : s.penaltyLimit,
        penaltyLimitMin: s.penaltyLimitMin || 1,
        penaltyLimitMax: s.penaltyLimitMax || 30,
        remindEnabled: !!s.remindEnabled,
        remindTime: s.remindTime || '19:00',
        /* 由 homeData 下发,决定「家长密码」卡片是"设置"还是"修改" */
        hasPin: !!res.hasPin
      });
    })
      /* ★ 兜底:云函数层已保证不抛出,但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true,界面卡在骨架屏(2026-09-23 修)。 */
      .catch(function (err) {
        console.error('[loadAll] 渲染数据时出错', err);
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },
  /* ================= 孩子信息 ================= */

  onNicknameInput(e) { this.setData({ nickname: e.detail.value }); },

  onGradeChange(e) {
    const i = Number(e.detail.value);
    this.setData({ gradeIndex: i, grade: this.data.gradeOptions[i] || '' });
  },

  /* 头像:用微信的头像选择器。
     注意:基础库低版本可能不支持 chooseAvatar 的 open-type,
     所以失败时给个明确提示,而不是静默无反应 */
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) { cloud.toast('没有拿到头像,可以稍后再试'); return; }
    this.setData({ avatar: url });
    this.saveAvatar(url);
  },

  saveAvatar(url) {
    const self = this;
    /* 云存储路径按 openid 分目录不是必须(有 _openid 字段),这里用时间戳防重名 */
    cloud.loading('上传中');
    wx.cloud.uploadFile({
      cloudPath: 'avatar/' + Date.now() + '.png',
      filePath: url,
      success: function (up) {
        cloud.hideLoading();
        /* ★ 先本地认下 fileID(2026-09-23 修):
           如果孩子还没创建,下一步 settingSave 会返回「还没有孩子信息。」,
           那个 fileID 就落不下来;而随后 initChild 又会把 chooseAvatar 给的
           **临时路径**存进库 ⇒ 头像重启后失效。
           所以先无条件把 data.avatar 换成真正的 fileID,创建/保存都带它。 */
        self.setData({ avatar: up.fileID });
        cloud.api.settingSave({ avatar: up.fileID }, { quiet: true }).then(function (res) {
          if (res && res.ok) {
            cloud.toast('头像已更新', 'success');
            /* 本地先更新全局,回首页立刻生效 */
            if (app().globalData.child) app().globalData.child.avatar = up.fileID;
            self.setData({ avatar: up.fileID });
          } else if (res && res.code === 'NOT_FOUND') {
            /* 孩子还没建 —— 不是错误,等「保存孩子信息」时一起写进去 */
          } else {
            cloud.toast((res && res.message) || '头像保存失败');
          }
        });
      },
      fail: function (err) {
        cloud.hideLoading();
        console.error('[setting] upload avatar failed', err);
        cloud.toast('头像上传失败,检查一下网络');
      }
    });
  },

  /* ================= 保存 ================= */

  /**
   * 保存孩子信息。
   *
   * ★★ 这里必须区分「首次创建」和「后续修改」两条路(2026-09-23 修)
   *    云函数 settingSave 的第一步就是查 children 集合,查不到就直接返回
   *      { ok:false, code:'NOT_FOUND', message:'还没有孩子信息。' }
   *    也就是说它**只能改,不能建**。而 initChild 才是「建 + 播种预设任务和奖励」的入口。
   *    原实现不管有没有孩子都调 settingSave ⇒ 用户填完昵称点保存,
   *    永远只弹出「还没有孩子信息」,孩子永远建不出来 —— 整条首次使用链路是断的。
   *
   *    判定依据:**看全局缓存里有没有 child**,而不是再去问一次服务端。
   *    首页 loadAll 已经把结果放在 globalData 里了(没有则是 null)。
   */
  onSaveBase() {
    const self = this;
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) { cloud.toast('昵称不能为空'); return; }

    if (this.data.saving) return;
    this.setData({ saving: true });
    cloud.loading('保存中');

    const finish = function () {
      cloud.hideLoading();
      self.setData({ saving: false });
    };

    /* ---- 首次:还没有孩子 → 走 initChild(会顺便播种 18 条任务 + 7 条奖励) ---- */
    if (!app().globalData.child) {
      cloud.api.initChild({
        nickname: nickname,
        grade: this.data.grade,
        /* ★ 只把"云存储里的头像"写进库(2026-09-23 修)
           微信的 chooseAvatar 给的是**临时路径**(形如 http://tmp/xxx.jpeg),
           它只在本机、本次会话内有效。直接存进数据库的后果:
           换个手机/过一阵打开,头像就是个裂图 —— 用户库里那条
           avatar: "http://tmp/w58I7je…jpeg" 就是这么来的。
           下面 saveAvatar() 上传成功后会先把 data.avatar 换成 cloud:// 的 fileID;
           这里再兜一道:不是 cloud:// 的一律不传(传空,不污染数据)。 */
        avatar: /^cloud:\/\//.test(String(this.data.avatar || '')) ? this.data.avatar : '',
        penaltyLimit: this.data.penaltyLimit
      }).then(function (res) {
        finish();
        if (!res || !res.ok) {
          cloud.toast((res && res.message) || '创建失败,请重试');
          return;
        }
        cloud.toast(res.message || '已创建', 'success');
        /* ★ 全局缓存必须更新 —— 否则回首页还是"没有孩子"的欢迎卡 */
        app().globalData.child = res.child;
        if (app().globalData.child) app().globalData.child._id = res.childId;
        app().globalData.isFirstRun = false;
        /* 回首页并强制重拉 */
        wx.navigateBack({
          fail: function () { wx.switchTab({ url: '/pages/index/index' }); }
        });
      }).catch(function (err) {
        finish();
        console.error('[setting] initChild 出错', err);
        cloud.toast('创建失败,请重试');
      });
      return;
    }

    /* ---- 已存在:走 settingSave 正常修改 ---- */
    this.doSave({ nickname: nickname, grade: this.data.grade }, function () {
      finish();
      if (app().globalData.child) app().globalData.child.nickname = nickname;
      cloud.toast('已保存', 'success');
    }, finish);
  },

  onLimitChange(e) {
    const v = Number(this.data.limitOptions[Number(e.detail.value)]);
    this.setData({ penaltyLimit: v });

    this.doSave({ penaltyLimit: v }, function () {
      cloud.toast('上限已改为 ' + v + ' 分', 'success');
    });
  },

  onToggleRemind(e) {
    const on = !!e.detail.value;
    this.setData({ remindEnabled: on });
    this.doSave({ remindEnabled: on }, function () {
      cloud.toast(on ? '已开启提醒' : '已关闭提醒');
    });
  },

  onTimeChange(e) {
    const t = e.detail.value;
    this.setData({ remindTime: t });
    this.doSave({ remindTime: t }, function () {
      cloud.toast('提醒时间已改为 ' + t);
    });
  },

  /**
   * 保存的公共入口。
   * @param {Object} patch
   * @param {Function} [onOk] 成功后回调(用于 toast 文案 / 更新全局缓存)
   */
  /**
   * @param {Object} patch
   * @param {Function} [onOk]   成功后回调
   * @param {Function} [onFail] 失败后回调 —— ★ 必须有,否则调用方若在此期间
   *   开着 loading / saving 标志,失败时没人复位,按钮会永久禁用
   *   (2026-09-23 修:与 pin.js 的 submitting 是同一类问题)
   */
  doSave(patch, onOk, onFail) {
    const self = this;
    cloud.api.settingSave(patch, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        cloud.toast((res && res.message) || '保存失败,请重试');
        if (typeof onFail === 'function') onFail(res);
        return;
      }
      if (res.child && app().globalData.child) {
        Object.assign(app().globalData.child, res.child);
      }
      if (typeof onOk === 'function') onOk(res);
    }).catch(function (err) {
      console.error('[setting] doSave 出错', err);
      cloud.toast('保存失败,请重试');
      if (typeof onFail === 'function') onFail(err);
    });
  },

  /* ================= 重置今日数据 ================= */

  onResetToday() {
    const self = this;

    wx.showModal({
      title: '重置今天的记录',
      content: '会清空 ' + this.data.resetDateText + ' 的全部打卡和加减分记录,' +
               '并把当天的积分退回。\n\n这个操作不能撤销,确定继续吗?',
      confirmText: '继续',
      confirmColor: '#E2695A',
      success: function (r) {
        if (!r.confirm) return;
        self.confirmPinThenReset();
      }
    });
  },

  /* 重置需要 PIN —— 现场输一次 */
  confirmPinThenReset() {
    const self = this;
    cloud.prompt('输入家长密码', '4 位数字').then(function (val) {
      if (val === null) return;
      self.doReset(String(val).trim());
    });
  },

  doReset(pinCode) {
    const self = this;
    cloud.loading('正在重置');

    /* 带上 confirmReset:true 直接执行。云函数的 confirmReset 校验是为了
       防"前端漏了二次确认"的情况,这里已经在界面上确认过了 */
    cloud.api.settingSave({
      action: 'resetToday',
      confirmReset: true,
      resetDate: this.data.resetDate,
      pin: pinCode
    }, { quiet: true }).then(function (res) {
      cloud.hideLoading();

      if (!res || !res.ok) {
        if (res && (res.code === 'PIN_WRONG' || res.code === 'PIN_REQUIRED')) {
          cloud.toast(res.message || '密码不对');
          return;
        }
        if (res && res.code === 'PIN_LOCKED') {
          wx.showModal({
            title: '暂时锁定',
            content: res.message || '密码错误次数太多,请稍后再试。',
            showCancel: false
          });
          return;
        }
        cloud.toast((res && res.message) || '重置失败,请重试');
        return;
      }

      cloud.toast('已重置今天的记录', 'success');
      /* 余额变了,清掉全局缓存让各页重拉 */
      app().clearChildCache();
      self.loadAll();
    });
  },

  /* ================= 清空所有数据 =================

     ★★ 三道锁,缺一不可(2026-09-29)
       ① 这里弹确认框(让人看清要删什么)  ② 现场输家长密码  ③ 服务端再校验一次
       孩子用的是同一台手机同一个微信,只弹框不验密码 = 孩子点两下就能清空全部记录。
       密码校验必须在服务端做 —— 前端不显示按钮不算数(本项目有过同类教训)。

     ★ 清空后要手动把全局状态拨回"首次使用":
       globalData.child = null 且 isFirstRun = true,否则回首页还是老样子。 */
  onResetAll() {
    const self = this;

    wx.showModal({
      title: '清空所有数据',
      content: '会把这个孩子的资料、打卡记录、积分、奖励兑换、勋章、' +
               '成长日志、成绩和荣誉**全部删除**,小程序回到刚装好的样子。\n\n' +
               '删掉之后找不回来,确定要继续吗?',
      confirmText: '我想继续',
      confirmColor: '#E2695A',
      success: function (r) {
        if (!r.confirm) return;

        /* 第二道确认:把后果再说一遍,顺便让人看清自己在做什么。
           两次内容不同 —— 第一次说"会删什么",第二次说"要输密码"。 */
        wx.showModal({
          title: '再确认一次',
          content: '这一步之后就无法恢复了。需要输入家长密码才会真正执行。',
          confirmText: '输入密码',
          confirmColor: '#E2695A',
          success: function (r2) {
            if (!r2.confirm) return;
            self.askPinThenClear();
          }
        });
      }
    });
  },

  askPinThenClear() {
    const self = this;
    cloud.prompt('输入家长密码', '4 位数字').then(function (val) {
      if (val === null) return;
      self.doClear(String(val).trim());
    });
  },

  doClear(pinCode) {
    const self = this;
    cloud.loading('正在清空');

    cloud.api.resetAll({ confirm: true, pin: pinCode }, { quiet: true }).then(function (res) {
      cloud.hideLoading();

      if (!res || !res.ok) {
        if (res && (res.code === 'PIN_WRONG' || res.code === 'PIN_REQUIRED')) {
          cloud.toast(res.message || '密码不对');
          return;
        }
        if (res && res.code === 'PIN_LOCKED') {
          wx.showModal({
            title: '暂时锁定',
            content: res.message || '密码错误次数太多,请稍后再试。',
            showCancel: false
          });
          return;
        }
        cloud.toast((res && res.message) || '清空失败,请重试');
        return;
      }

      cloud.toast('已清空,回到初始状态', 'success');

      /* ★ 全局状态必须拨回"首次使用" —— 只清缓存不够,
         首页靠 isFirstRun 决定显示欢迎卡还是打卡界面 */
      app().clearChildCache();
      app().globalData.isFirstRun = true;

      /* 回首页。★ url 必须带前导斜杠(2026-09-29 踩过:相对路径会静默失败) */
      wx.switchTab({
        url: '/pages/index/index',
        fail: function (err) {
          console.error('[setting] switchTab 失败', err);
          cloud.toast('请手动回到首页');
        }
      });
    });
  },

  onRetry() { this.loadAll(); },

  /* ================= 家长密码 ================= */

  /* 设置 / 修改家长密码 —— 都交给 pin 页,那边已有完整的
     "验旧 → 输新 → 再确认一次"流程,不要在这里重写一遍 */
  onChangePin() {
    const url = this.data.hasPin
      ? '/pages/pin/pin?action=change&next=back'
      : '/pages/pin/pin?action=set&next=back';
    wx.navigateTo({
      url: url,
      fail: function () { cloud.toast('打开密码页失败'); }
    });
  },

  /* 忘记密码 —— 这是一个"必须留出口、但不能自助"的场景:
     密码做了 scrypt 哈希,反推不出来,代码层面没有任何"万能钥匙"。
     唯一的身份证明是"能登录微信云开发控制台"(要开发者账号扫码),
     所以只能去控制台把那个字段清掉。
     ★ 为什么不做一键重置:孩子用的是同一台手机、同一个微信,
       自助重置 = 孩子点一下就能解除全部家长限制,那这把锁就是摆设。 */
  onForgotPin() {
    wx.showModal({
      title: '忘记家长密码了',
      content: '密码存在云端的数据库里、做了加密,反推不出来,所以在这里没法找回。\n\n' +
               '重置要用电脑:打开微信开发者工具 → 云开发控制台 → 数据库 → ' +
               'children 集合 → 找到孩子那条记录 → 把 parentPin 这个字段清空(或删掉)→ 保存。\n\n' +
               '清空后家长密码就回到"未设置",回这一页重新设一个即可。\n' +
               '(控制台不同版本界面略有差别,找不到那一列就把截图发我。)',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
