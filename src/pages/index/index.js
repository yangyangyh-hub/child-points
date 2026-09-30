/* 首页(打卡主页)—— 原型稿页面1

   版面结构(从上到下):
     1. 顶部:头像 / 昵称 / 年级 / 模式切换按钮
     2. 核心数据大卡:可用积分 · 累计总积分 · 今日得分 · 连续打卡
     3. 中部:今日成长打卡 —— 两栏(今日好习惯加分 / 今日不良行为扣分)
     4. 底部三按钮:保存今日打卡记录 · 添加今日备注 · 查看可兑换奖励

   ★ 一条重要的实现约定
     渲染函数**互不调用**,统一由 renderAll() 调度。
     原因:互相调用会形成隐式依赖链,改一个渲染函数可能悄悄影响另一个,
     而且容易出现"某页没刷新"的诡异 bug。
     静态自检脚本会检查这一点(注释里也不许出现 renderXxx() 的调用写法)。 */

const config = require('../../config');
const dateUtil = require('../../utils/date');
const cloud = require('../../lib/cloud');

const app = () => getApp();

Page({
  data: {
    /* 加载态:首屏用骨架屏而不是空白 */
    loading: true,
    error: '',

    /* 孩子 */
    child: null,
    initial: '宝',                /* 头像文字:WXML 不支持字符串下标,在 JS 里算好 */
    grade: '',

    /* 双积分(R1) */
    availablePoints: 0,
    lifetimePoints: 0,

    /* 今日 */
    date: '',
    dateText: '',
    bonusTotal: 0,
    penaltyTotal: 0,
    netPoints: 0,
    penaltyLimit: 0,
    penaltyRemain: 0,
    penaltyPercent: 0,

    /* 连续打卡(R10) */
    streak: { current: 0, longest: 0, usedBreaks: 0, allowBreak: 1 },
    streakNote: '',

    /* 任务两栏 */
    bonusTasks: [],
    penaltyTasks: [],
    bonusExpanded: false,
    penaltyExpanded: false,
    bonusVisible: [],
    penaltyVisible: [],

    /* 日期横排 */
    dateStrip: [],
    centerDate: '',

    /* 勋章与日志 */
    medalUnlocked: 0,
    medalTotal: 5,
    recentLogs: [],

    /* 模式 */
    mode: 'child',
    isParent: false,
    hasPin: false,

    /* 弹层 */
    adjustVisible: false,
    adjustKind: 'bonus',
    adjustValue: '',
    adjustNote: '',
    adjustLimitVisible: false,
    logVisible: false,
    logText: '',
    medalToast: null,

    /* 补分弹窗 */
    makeupVisible: false,
    makeupList: []
  },

  onLoad() {
    const today = dateUtil.today();
    this.setData({
      date: today,
      centerDate: today,
      dateText: dateUtil.monthDayText(today) + ' ' + dateUtil.weekdayCn(today),
      dateStrip: dateUtil.buildDateStrip(today, 3),
      mode: app().globalData.mode,
      isParent: app().isParentView(),
      makeupList: config.PRESET_MAKEUPS
    });
  },

  /* 每次显示都重拉 —— 从奖励页兑换回来,积分必须变 */
  onShow() {
    /* 自定义 tabBar:每个页面各有一份组件实例,切页后高亮不会自动跟着变
       ⇒ 必须在这里显式指定当前页索引。取不到就直接跳过,不能让打卡页崩掉。 */
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTab(0);
    }
    const g = app().globalData;
    this.setData({
      mode: g.mode,
      /* ★ isParentView() 是 App 上的方法,不在 globalData 里。
         曾误写成 g.isParentView() ⇒ 一进首页就 TypeError ⇒
         loadAll() 根本执行不到 ⇒ loading 永远 true ⇒ 骨架屏卡死
         (2026-09-23 由用户 Console 报错定位并修复) */
      isParent: app().isParentView(),
      hasPin: !!g.hasPin
    });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  onShareAppMessage() {
    return {
      title: '宝贝成长积分打卡 · 一起养成好习惯',
      path: '/pages/index/index'
    };
  },

  /* ==================== 数据加载 ==================== */

  loadAll() {
    const self = this;
    const d = this.data.date;

    return cloud.api.homeData({
      date: d,
      mode: this.data.mode
    }).then(res => {
      if (!res || !res.ok) {
        self.setData({ loading: false, error: (res && res.message) || '加载失败' });
        return;
      }

      /* 首次使用 → 显示引导 */
      if (res.needInit || !res.child) {
        app().globalData.isFirstRun = true;
        self.setData({ loading: false, error: '' });
        return;
      }

      app().globalData.child = res.child;
      app().globalData.hasPin = !!res.hasPin;
      app().globalData.isFirstRun = false;

      self.applyData(res);
    })
      /* ★ 兜底:云函数层已保证不抛出,但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true,界面卡在骨架屏(2026-09-23 修)。 */
      .catch(function (err) {
        console.error('[loadAll] 渲染数据时出错', err);
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },
  /* 把服务端返回体落成视图数据。只 setData 一次 */
  applyData(res) {
    /* 昵称首字(WXML 不支持 child.nickname[0],必须在这里算) */
    const initial = (res.child.nickname || '宝').charAt(0);

    const limit = Number(res.today.penaltyLimit) || 0;
    const remain = Number(res.today.penaltyRemain) || 0;
    const used = Math.max(0, limit - remain);

    const bonus = res.bonusTasks || [];
    const penalty = res.penaltyTasks || [];

    const self = this;
    this.setData({
      loading: false,
      error: '',

      child: res.child,
      initial: initial,
      grade: res.child.grade || '',

      availablePoints: res.availablePoints || 0,
      lifetimePoints: res.lifetimePoints || 0,

      bonusTotal: res.today.bonusTotal || 0,
      penaltyTotal: res.today.penaltyTotal || 0,
      netPoints: res.today.netPoints || 0,
      penaltyLimit: limit,
      penaltyRemain: remain,
      penaltyPercent: limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0,

      streak: res.streak || { current: 0, longest: 0, usedBreaks: 0, allowBreak: 1 },
      streakNote: this.streakNote(res.streak),

      bonusTasks: bonus,
      penaltyTasks: penalty,
      bonusVisible: this.sliceVisible(bonus, this.data.bonusExpanded, config.KEEP.tasks),
      penaltyVisible: this.sliceVisible(penalty, this.data.penaltyExpanded, config.KEEP.tasks),

      medalUnlocked: res.medalUnlockedCount || 0,
      medalTotal: res.medalTotal || 5,
      recentLogs: res.logs || [],

      mode: res.mode || 'child',
      isParent: app().isParentView(),
      hasPin: !!res.hasPin
    });
  },

  /* 连续打卡的说明文案 —— 把"允许断 1 次"这个规则讲清楚,家长才知道怎么算 */
  streakNote(s) {
    if (!s || !s.current) return '';
    if (s.usedBreaks >= s.allowBreak) {
      return '已经用掉 ' + s.allowBreak + ' 次断签机会,再断就要重新数了';
    }
    return '还可以断 ' + (s.allowBreak - s.usedBreaks) + ' 次';
  },

  sliceVisible(list, expanded, keep) {
    if (expanded) return list;
    return list.slice(0, keep);
  },

  /* ==================== 打卡 ==================== */

  onToggleTask(e) {
    const ds = e.currentTarget.dataset;
    const task = (ds.kind === 'bonus' ? this.data.bonusTasks : this.data.penaltyTasks)
      .filter(t => t._id === ds.id)[0];
    if (!task) return;

    const self = this;
    /* 本地先翻转,给即时反馈(云函数失败会回滚) */
    this.patchTaskDone(task._id, !task.done);

    cloud.api.taskToggle({
      childId: this.data.child._id,
      taskId: task._id,
      date: this.data.date,
      done: !task.done
    }, { quiet: true }).then(res => {
      if (!res || !res.ok) {
        /* 回滚 */
        self.patchTaskDone(task._id, task.done);

        /* ★ 扣分超限:不是错误,是要家长做决定 */
        if (res && res.code === 'PENALTY_LIMIT') {
          self.askOverLimit(res, {
            childId: self.data.child._id,
            taskId: task._id,
            date: self.data.date,
            done: true
          });
          return;
        }
        cloud.toast((res && res.message) || '操作失败');
        return;
      }

      /* 成功:轻量刷新积分数字,并提示新勋章 */
      self.afterPointChange(res);
    });
  },

  /* 本地翻转某一项的 done,并同步 visible 列表 */
  patchTaskDone(taskId, done) {
    const patch = {};
    ['bonus', 'penalty'].forEach(kind => {
      const listKey = kind + 'Tasks';
      const list = this.data[listKey].map(t => {
        if (t._id !== taskId) return t;
        return Object.assign({}, t, { done: done });
      });
      patch[listKey] = list;
    });
    const expandedKey = this.data.bonusExpanded;
    /* visible 列表由完整列表派生,统一重算避免两处不一致 */
    const bonus = patch.bonusTasks;
    const penalty = patch.penaltyTasks;
    patch.bonusVisible = this.sliceVisible(bonus, expandedKey, config.KEEP.tasks);
    patch.penaltyVisible = this.sliceVisible(penalty, this.data.penaltyExpanded, config.KEEP.tasks);
    this.setData(patch);
  },

  /* 积分变动后:更新双积分 + 提示勋章 + 刷新今日统计 */
  afterPointChange(res) {
    const patch = {};
    if (typeof res.availablePoints === 'number') patch.availablePoints = res.availablePoints;
    if (typeof res.lifetimePoints === 'number') patch.lifetimePoints = res.lifetimePoints;
    if (res.newMedals && res.newMedals.length) {
      const m = res.newMedals[0];
      patch.medalToast = { icon: m.icon || '🏅', name: m.name };
      setTimeout(() => this.setData({ medalToast: null }), 3200);
    }
    this.setData(patch);
    /* 今日合计与上限余量需要重算 —— 用一次轻量请求,不去全量刷整页 */
    this.refreshToday();
  },

  refreshToday() {
    const self = this;
    cloud.api.homeData({ date: this.data.date, mode: this.data.mode }, { quiet: true })
      .then(res => {
        if (!res || !res.ok || !res.child) return;
        const limit = Number(res.today.penaltyLimit) || 0;
        const remain = Number(res.today.penaltyRemain) || 0;
        const used = Math.max(0, limit - remain);
        self.setData({
          bonusTotal: res.today.bonusTotal || 0,
          penaltyTotal: res.today.penaltyTotal || 0,
          netPoints: res.today.netPoints || 0,
          penaltyRemain: remain,
          penaltyPercent: limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0,
          streak: res.streak || self.data.streak,
          streakNote: self.streakNote(res.streak),
          medalUnlocked: res.medalUnlockedCount || 0
        });
      });
  },

  /* ==================== 扣分超限 ==================== */

  /* ★ 上限提醒(2026-09-24 按用户要求改成"提醒 + 两个选项")
     原来写的是"要不要以家长身份突破上限?" —— 那是**问家长要不要用特权**,
     家长看到会很为难(像在鼓励扣分)。改成先把**事实**说清楚:
     今天已经扣了多少、上限是多少,然后给两个明确的选择。
       不扣分了   ← 默认,这次就算了
       仍要扣分   ← 需要家长密码(服务端校验,不是前端说了算) */
  askOverLimit(res, payload) {
    const self = this;
    const limit = Number(res.limit || 0);
    const need = Math.abs(Number(res.need || 0));
    const used = Math.max(0, limit - Number(res.remain || 0));

    wx.showModal({
      title: '已经到今天的扣分上限了',
      content: '今天已经扣了 ' + used + ' 分,上限是 ' + limit + ' 分。\n' +
               '这一项要再扣 ' + need + ' 分。\n\n' +
               '这次还要扣吗?',
      confirmText: '仍要扣分',
      cancelText: '不扣分了',
      /* "仍要扣分"是继续扣,用警示色而不是主色 —— 别让它看起来像推荐操作 */
      confirmColor: '#E2695A',
      success(r) {
        if (!r.confirm) {
          /* 选"不扣分了":什么都不做,也不弹提示(界面本来就没变化,提示反而是噪音) */
          return;
        }
        self.doOverLimit(payload, true);
      }
    });
  },

  doOverLimit(payload, retryAuth) {
    const self = this;
    cloud.api.taskToggle(Object.assign({}, payload, {
      allowOverLimit: true,
      /* ★ 突破上限必须带密码:服务端 taskToggle 会校验(2026-09-24 补)。
         以前这里不传 pin,服务端也不查 —— 等于前端说了算。 */
      pin: self._sessionPin || ''
    }), { quiet: true }).then(function (res) {
      if (res && res.ok) {
        self.patchTaskDone(payload.taskId, true);
        self.afterPointChange(res);
        cloud.toast('已按家长权限记录');
        return;
      }
      /* 需要/输错密码 → 再验一次后自动重试(只重试一次) */
      if (res && (res.code === 'PIN_REQUIRED' || res.code === 'PIN_WRONG') && retryAuth) {
        self._sessionPin = '';
        cloud.toast(res.code === 'PIN_REQUIRED' ? '需要家长密码' : '密码不对,再输一次');
        self.gotoParentUnlock(function (code) {
          if (!code) return;
          self._sessionPin = code;
          self.doOverLimit(payload, false);
        });
        return;
      }
      cloud.toast((res && res.message) || '操作失败');
    });
  },

  /* ==================== 手动加/扣分 ==================== */

  onOpenAdjust(e) {
    const kind = (e.currentTarget.dataset.kind === 'penalty') ? 'penalty' : 'bonus';
    const self = this;

    const open = function () {
      self.setData({ adjustVisible: true, adjustKind: kind, adjustValue: '', adjustNote: '' });
    };

    /* 没设过家长密码 → 云函数不会要密码,直接开 */
    if (!app().globalData.hasPin) { open(); return; }

    /* 本会话已经验过一次 → 直接用那次拿到的密码 */
    if (self._sessionPin) { open(); return; }

    /* ★ 否则必须先验一次,并**把密码接住**(2026-09-23 修)
       云函数 adjustPoints 在设过密码时强制校验 pin;前端不先拿到,
       提交就会被判 PIN_WRONG —— 而旧代码还会把它算成"输错"累计次数,
       连试 5 次把家长自己锁死 10 分钟。这是用户截图里 1/2/4 号问题的共同根因。 */
    cloud.toast('先输入一次家长密码');
    this.gotoParentUnlock(function (code) {
      if (code) self._sessionPin = code;
      if (self._sessionPin) open();
    });
  },

  onCloseAdjust() { this.setData({ adjustVisible: false }); },

  // 弹层面板上的空处理器：吞掉点击，避免冒泡到遮罩触发关闭
  noop() {},

  onAdjustInput(e) {
    this.setData({ adjustValue: e.detail.value });
  },
  onAdjustNoteInput(e) {
    this.setData({ adjustNote: e.detail.value });
  },

  /* 快捷分值 */
  onAdjustQuick(e) {
    this.setData({ adjustValue: String(e.currentTarget.dataset.v) });
  },

  onSubmitAdjust() {
    const raw = Math.abs(Math.round(Number(this.data.adjustValue) || 0));
    if (!raw) { cloud.toast('请填写分值'); return; }

    this.doAdjust({
      childId: this.data.child._id,
      change: (this.data.adjustKind === 'penalty') ? -raw : raw,
      reason: 'manual',
      note: this.data.adjustNote,
      date: this.data.date,
      pin: this._sessionPin || ''
    }, true);
  },

  /* @param {boolean} retryAuth 密码缺失/不对时,是否再验一次并自动重提
     (只重提一次 —— 否则用户在 PIN 页反复返回会造成重复提交) */
  doAdjust(payload, retryAuth) {
    const self = this;
    cloud.api.adjustPoints(payload, { quiet: true }).then(function (res) {
      if (res && res.ok) {
        self.setData({ adjustVisible: false });
        self.afterPointChange(res);
        cloud.toast(res.message || '已记录');
        return;
      }

      /* 扣分超限:不是错误,是要家长做决定 */
      if (res && res.code === 'PENALTY_LIMIT') {
        self.setData({ adjustVisible: false });
        self.askOverLimit(res, {
          childId: self.data.child._id,
          change: payload.change,
          reason: 'manual',
          note: self.data.adjustNote,
          date: self.data.date
        });
        return;
      }

      /* ★ 需要密码 / 密码失效(比如家长刚改过密码) → 再验一次,拿到新的自动重提 */
      if (res && (res.code === 'PIN_REQUIRED' || res.code === 'PIN_WRONG') && retryAuth) {
        self._sessionPin = '';
        cloud.toast(res.code === 'PIN_REQUIRED' ? '需要家长密码' : '密码不对,再输一次');
        self.gotoParentUnlock(function (code) {
          if (!code) return;                 /* 用户中途放弃 → 停在弹层,不提交 */
          self._sessionPin = code;
          payload.pin = code;
          self.doAdjust(payload, false);
        });
        return;
      }

      cloud.toast((res && res.message) || '操作失败');
    });
  },

  /* 超限时用 adjustPoints 突破(与任务勾选走不同分支) */
  /* ==================== 补救 ==================== */

  onOpenMakeup() {
    const self = this;
    const open = function () { self.setData({ makeupVisible: true }); };

    /* 与手动加减分同一套规矩(补救也是改分,同属家长权限)—— 2026-09-23 修:
       没设过密码 → 云函数不校验;本会话验过 → 直接用;否则先验一次并把密码接住。 */
    if (!app().globalData.hasPin) { open(); return; }
    if (self._sessionPin) { open(); return; }

    if (!app().isParentView()) cloud.toast('补救记录需要家长确认');
    else cloud.toast('先输入一次家长密码');
    this.gotoParentUnlock(function (code) {
      if (code) self._sessionPin = code;
      if (self._sessionPin) open();
    });
  },
  onCloseMakeup() { this.setData({ makeupVisible: false }); },

  onPickMakeup(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.makeupList[idx];
    if (!item) return;
    this.doMakeup(item, true);
  },

  doMakeup(item, retryAuth) {
    const self = this;
    cloud.api.adjustPoints({
      childId: this.data.child._id,
      change: Math.abs(item.score),
      reason: 'makeup',
      note: item.name,
      date: this.data.date,
      pin: self._sessionPin || ''
    }, { quiet: true }).then(function (res) {
      if (res && res.ok) {
        self.setData({ makeupVisible: false });
        self.afterPointChange(res);
        cloud.toast('补救 +' + Math.abs(item.score) + ' 分,做得很好');
        return;
      }
      /* 需要/输错密码 → 再验一次后自动重提(与手动加减分同样的处理) */
      if (res && (res.code === 'PIN_REQUIRED' || res.code === 'PIN_WRONG') && retryAuth) {
        self._sessionPin = '';
        cloud.toast(res.code === 'PIN_REQUIRED' ? '需要家长密码' : '密码不对,再输一次');
        self.gotoParentUnlock(function (code) {
          if (!code) return;
          self._sessionPin = code;
          self.doMakeup(item, false);
        });
        return;
      }
      cloud.toast((res && res.message) || '操作失败');
    });
  },

  /* ==================== 日期切换 ==================== */

  onPickDate(e) {
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.setData({
      date: key,
      centerDate: key,
      dateText: dateUtil.monthDayText(key) + ' ' + dateUtil.weekdayCn(key),
      dateStrip: dateUtil.buildDateStrip(key, 3)
    });
    this.loadAll();
  },

  onPrevDay() { this.shiftDate(-1); },
  onNextDay() { this.shiftDate(1); },

  shiftDate(n) {
    const key = dateUtil.addDays(this.data.date, n);
    /* 不允许看未来 —— 未来的打卡没有意义,还会让家长困惑 */
    if (dateUtil.diffDays(dateUtil.today(), key) > 0) {
      cloud.toast('还没到那一天呢');
      return;
    }
    this.onPickDate({ currentTarget: { dataset: { key: key } } });
  },

  onBackToday() {
    this.onPickDate({ currentTarget: { dataset: { key: dateUtil.today() } } });
  },

  /* ==================== 展开/折叠 ==================== */

  onToggleExpand(e) {
    const kind = e.currentTarget.dataset.kind;
    if (kind === 'bonus') {
      const v = !this.data.bonusExpanded;
      this.setData({
        bonusExpanded: v,
        bonusVisible: this.sliceVisible(this.data.bonusTasks, v, config.KEEP.tasks)
      });
    } else {
      const v = !this.data.penaltyExpanded;
      this.setData({
        penaltyExpanded: v,
        penaltyVisible: this.sliceVisible(this.data.penaltyTasks, v, config.KEEP.tasks)
      });
    }
  },

  /* ==================== 今日备注(与成长日志同一张表) ==================== */

  onOpenLog() {
    if (!app().isParentView()) {
      cloud.toast('写记录是家长专属功能');
      this.gotoParentUnlock(null);
      return;
    }
    /* 已经写过就带出来,便于修改 */
    const existing = (this.data.recentLogs || []).filter(g => g.date === this.data.date)[0];
    this.setData({ logVisible: true, logText: existing ? existing.text : '' });
  },
  onCloseLog() { this.setData({ logVisible: false }); },
  onLogInput(e) { this.setData({ logText: e.detail.value }); },

  onSubmitLog() {
    const self = this;
    cloud.api.logSave({
      childId: this.data.child._id,
      date: this.data.date,
      text: this.data.logText
    }, { quiet: true }).then(res => {
      if (!res || !res.ok) { cloud.toast((res && res.message) || '保存失败'); return; }
      self.setData({ logVisible: false });
      cloud.toast(res.message || '已记录');
      /* 刷新最近日志 */
      cloud.api.logList({ childId: self.data.child._id })
        .then(r => { if (r && r.ok) self.setData({ recentLogs: (r.list || []).slice(0, 3) }); });
    });
  },

  /* ==================== 模式切换 ==================== */

  onSwitchMode() {
    const next = (this.data.mode === 'parent') ? 'child' : 'parent';
    const self = this;

    if (next === 'child') {
      app().setMode('child');
      /* ★ 切回孩子模式必须把会话密码丢掉(2026-09-23):否则孩子拿到手机时,
         家长刚才解锁用的那串密码还留在内存里,下次改分根本不用再输。 */
      this._sessionPin = '';
      this.setData({ mode: 'child', isParent: false, date: dateUtil.today(), centerDate: dateUtil.today() });
      this.loadAll();
      cloud.toast('已切到孩子模式');
      return;
    }

    /* 切到家长模式:必须验密码(没设过就先设) */
    if (!this.data.hasPin) {
      wx.showModal({
        title: '先设置家长密码',
        content: '家长模式能看到扣分记录、也能改分。设一个 4 位密码,孩子就看不到了。',
        confirmText: '去设置',
        success(r) {
          if (r.confirm) wx.navigateTo({ url: '/pages/pin/pin?action=set&next=parent' });
        }
      });
      return;
    }

    this.gotoParentUnlock(function () {
      self.setData({ mode: 'parent', isParent: true });
      self.loadAll();
    });
  },

  /* 去 PIN 页面验证。callback 在验证成功后执行,并**收到本次的密码**。
     密码只交给回调、存进页面实例变量,不进 data、不进 storage。 */
  gotoParentUnlock(cb) {
    this._pinCb = cb || null;
    wx.navigateTo({ url: '/pages/pin/pin?action=verify&next=back' });
  },

  /* ==================== 导航 ==================== */

  goReward() { wx.switchTab({ url: '/pages/reward/reward' }); },
  goStats() { wx.navigateTo({ url: '/sub/stats/stats' }); },
  goRules() { wx.navigateTo({ url: '/sub/rules/rules' }); },
  goMedal() { wx.switchTab({ url: '/pages/medal/medal' }); },
  goLog() { wx.navigateTo({ url: '/sub/log/log' }); },
  goSetting() { wx.navigateTo({ url: '/sub/setting/setting' }); },

  /* ==================== 首次使用 ==================== */

  onCreateChild() {
    wx.navigateTo({ url: '/sub/setting/setting?first=1' });
  },

  onRetry() {
    this.setData({ loading: true, error: '' });
    this.loadAll();
  },

  /* PIN 页验证成功后回来 —— 由 pin 页调用(prev.onPinVerified(pinCode)) */
  onPinVerified(pinCode) {
    /* ★ 必须接住 pinCode(2026-09-23 修,线上事故)
       旧代码写成 onPinVerified() —— 参数被丢掉,于是「手动加减分」永远拿不到密码,
       云函数一律判 PIN_WRONG,还把失败次数记在账上,家长自己都被锁死 10 分钟。
       ★ 只存实例属性 _sessionPin:不进 data(渲染层数据快照里不该有密码),
         也不进 storage(那样杀掉小程序还是解锁态,孩子等家长用完就能进)。 */
    this._sessionPin = pinCode || '';
    const cb = this._pinCb;
    this._pinCb = null;
    this.setData({ mode: 'parent', isParent: true });
    if (typeof cb === 'function') cb(this._sessionPin);
    else this.loadAll();
  }
});
