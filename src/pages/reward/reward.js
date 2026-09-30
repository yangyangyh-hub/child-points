/* 奖励页 · 逻辑层(原型稿页面3 —— 奖励兑换商城)

   ★ 与旧版的区别(2026-09-22 重构)
     1) 余额看 **availablePoints**(可用积分),不是 totalPoints。
        双积分体系:兑换只花可用积分,累计总积分是荣誉,不动。
     2) 兑换改 **两步式**:孩子提交申请(pending) → 家长批准才扣分。
        旧版是"点一下直接扣",孩子端没人把关。
     3) 奖励按 small / large 两档分组,用云函数返回的 tiers 标签,不在前端硬编码。
     4) 家长模式多一个「待确认」列表,批准需要 PIN。

   ★ 前端 affordable 只用于置灰,真正的余额校验在云函数 redeemReward 里。 */

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
    mode: 'child',
    isParent: false,

    /* 钱包 */
    availablePoints: 0,
    lifetimePoints: 0,

    /* 奖励分组:[{ key, label, hint, list: [] }] */
    groups: [],
    rewardCount: 0,

    /* 兑换记录 */
    records: [],
    pendingCount: 0,
    recordsExpanded: false,
    visibleRecords: [],
    hiddenRecordCount: 0,

    /* 家长编辑弹层 */
    editorVisible: false,
    editorMode: 'create',      /* create | update */
    editingId: '',
    formName: '',
    formCost: '',
    formTier: 'small',
    formStock: '',
    tierOptions: [],

    /* 展开/收起奖励分组 */
    expandedGroup: ''
  },

  onLoad() {
    this.setData({ mode: app().globalData.mode || 'child' });
  },

  onShow() {
    /* 自定义 tabBar:高亮索引要本页自己指定(见 custom-tab-bar/index.js 注释) */
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTab(1);
    }
    this.setData({
      mode: app().globalData.mode || 'child',
      isParent: app().isParentView(),
      /* 切回孩子模式时,如果家长弹层还开着,关掉 —— 避免越权操作界面残留 */
      editorVisible: app().isParentView() ? this.data.editorVisible : false
    });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  onShareAppMessage() {
    return { title: '用小星星换奖励啦', path: '/pages/reward/reward' };
  },

  /* ================= 数据加载 ================= */

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    /* 首次进来自带 loading,不闪 */
    if (!this.data.child && !app().globalData.child) {
      /* 什么都不做 */
    } else {
      this.setData({ loading: true, error: '' });
    }
    /* ★ 切 tab 回来不再"清空重来"(详见 medal.js 里同段注释) */
    const silent = !!this._hasData;
    if (silent) this.setData({ loading: false });

    return cloud.api.rewardList({}, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        /* 静默刷新失败 ⇒ 不要把好的画面换成错误页 */
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
  /* 一次性 setData:减少跨线程通信次数(小程序 setData 是性能瓶颈) */
  applyData(res) {
    const tiers = res.tiers || [];
    const rewards = res.rewards || [];

    /* 按消费档位分组,空档不显示 —— 不给孩子一个空的"大额奖励"分组 */
    const groups = [];
    tiers.forEach(function (t) {
      const list = rewards.filter(function (r) { return r.tier === t.key; });
      if (!list.length) return;
      groups.push({
        key: t.key,
        label: t.label || t.key,
        hint: t.hint || '',
        list: list.map(function (r) {
          return {
            _id: r._id,
            name: r.name,
            icon: r.icon || '🎁',
            cost: r.cost,
            tier: r.tier,
            tierLabel: r.tierLabel,
            preset: r.preset,
            unlimited: r.unlimited,
            stock: r.stock,
            soldOut: r.soldOut,
            affordable: r.affordable,
            gap: r.gap,
            /* 家长能看到已下架的奖励(否则下架后就找不回上架入口) */
            active: r.active !== false,
            /* 一句话说清这条能不能换,避免孩子盯着灰按钮不知道该干嘛 */
            stateText: r.soldOut
              ? '已兑完'
              : (r.affordable ? '' : ('还差 ' + r.gap + ' 分'))
          };
        })
      });
    });

    /* 没有分档信息的奖励兜底进"其他",防止数据异常时整页空白 */
    const orphan = rewards.filter(function (r) {
      return !tiers.some(function (t) { return t.key === r.tier; });
    });
    if (orphan.length) {
      groups.push({
        key: 'other', label: '其他奖励', hint: '',
        list: orphan.map(function (r) {
          return {
            _id: r._id, name: r.name, icon: r.icon || '🎁', cost: r.cost,
            tier: r.tier, tierLabel: r.tierLabel, preset: r.preset,
            unlimited: r.unlimited, stock: r.stock, soldOut: r.soldOut,
            affordable: r.affordable, gap: r.gap,
            active: r.active !== false,
            stateText: r.soldOut ? '已兑完' : (r.affordable ? '' : ('还差 ' + r.gap + ' 分'))
          };
        })
      });
    }

    this.setData({
      loading: false,
      error: '',
      child: app().globalData.child || this.data.child,
      mode: res.mode || 'child',
      isParent: app().isParentView(),
      availablePoints: res.availablePoints || 0,
      lifetimePoints: res.lifetimePoints || 0,
      groups: groups,
      rewardCount: rewards.length,
      records: res.records || [],
      pendingCount: res.pendingCount || 0,
      tierOptions: tiers
    });

    this.applyRecordFold();
  },

  applyRecordFold() {
    const list = this.data.records || [];
    const keep = 5;
    const show = this.data.recordsExpanded ? list : list.slice(0, keep);
    this.setData({
      visibleRecords: show,
      hiddenRecordCount: Math.max(0, list.length - keep)
    });
  },

  /* ================= 兑换(两步式) ================= */

  onTapReward(e) {
    const id = e.currentTarget.dataset.id;
    const reward = this.findReward(id);
    if (!reward) return;

    if (reward.soldOut) { cloud.toast('这个奖励已经兑完啦'); return; }

    /* 孩子端余额不够:不弹确认框,直接提示还差多少 —— 少一步无效操作 */
    if (!reward.affordable) {
      cloud.toast('还差 ' + reward.gap + ' 分,再攒一攒吧');
      return;
    }

    const self = this;

    /* 家长模式下已解锁,可以直接批准,少绕一圈 */
    if (this.data.isParent && app().globalData.pinUnlocked) {
      cloud.confirm('家长直接为孩子兑换「' + reward.name + '」?会扣 ' + reward.cost + ' 分。', '兑换确认')
        .then(function (yes) {
          if (yes) self.doRequest(reward, true);
        });
      return;
    }

    cloud.confirm('用 ' + reward.cost + ' 分换「' + reward.name + '」?\n提交后要等家长确认才会扣分。', '申请兑换')
      .then(function (yes) {
        if (yes) self.doRequest(reward, false);
      });
  },

  /**
   * 提交兑换申请。
   * @param {Object}  reward
   * @param {boolean} asParent  true = 已是家长身份,提交后立刻批准(一步到位)
   */
  doRequest(reward, asParent) {
    const self = this;
    const child = this.data.child;
    if (!child || !child._id) { cloud.toast('还没找到孩子信息'); return; }

    cloud.loading('提交中');
    cloud.api.redeemReward({
      action: 'request',
      childId: child._id,
      rewardId: reward._id
    }, { quiet: true }).then(function (res) {
      cloud.hideLoading();
      if (!res || !res.ok) {
        cloud.toast((res && res.message) || '提交失败,请重试');
        return;
      }
      const rid = res.redemptionId;
      if (!asParent) {
        cloud.toast('已提交给家长确认');
        self.loadAll();
        return;
      }
      /* 家长一步到位:提交完立刻批准。
         这里不重复弹确认框,但**不能省掉 PIN** —— 云函数 requirePin 会校验。
         会话内有密码就带上;没有(比如从首页切模式进来,PIN 页是回首页的,
         没经过本页)就走 PIN_REQUIRED 分支现场问一次。
         两条路都通,不用在本页维护"是否已解锁"的标志。 */
      self.doApprove(rid, null, true);
    });
  },

  /* ================= 家长审批 ================= */

  onTapApprove(e) {
    const id = e.currentTarget.dataset.id;
    const rec = this.findRecord(id);
    if (!rec) return;
    this.doApprove(id, rec, false);
  },

  /**
   * 批准兑换。
   * @param {string} id
   * @param {Object} rec      记录对象(用于文案),可为 null
   * @param {boolean} silent  家长一步到位场景,不额外弹确认
   */
  doApprove(id, rec, silent) {
    const self = this;
    const child = this.data.child;
    const name = rec ? rec.rewardName : '';
    const cost = rec ? rec.cost : 0;

    const run = function (pinCode) {
      cloud.loading('处理中');
      cloud.api.redeemReward({
        action: 'approve',
        childId: child._id,
        redemptionId: id,
        pin: pinCode || ''
      }, { quiet: true }).then(function (res) {
        cloud.hideLoading();
        if (!res || !res.ok) {
          if (res && res.code === 'PIN_REQUIRED') {
            self.askPinThen(function (code) { run(code); });
            return;
          }
          cloud.toast((res && res.message) || '操作失败');
          self.loadAll();
          return;
        }
        cloud.toast(res.message || '兑换成功', 'success');
        self.loadAll();
      });
    };

    if (silent) { run(self._sessionPin || ''); return; }

    /* 家长没解锁就先解锁,解锁后再批准 */
    this.gotoParentUnlock(function () {
      cloud.confirm('确认兑换「' + name + '」?会扣 ' + cost + ' 分。', '家长确认')
        .then(function (yes) { if (yes) run(self._sessionPin || ''); });
    });
  },

  /* 云函数要求 PIN 时,现场问一次 */
  askPinThen(cb) {
    cloud.prompt('输入家长密码', '4 位数字').then(function (val) {
      if (val === null) return;
      cb(String(val).trim());
    });
  },

  onTapReject(e) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    this.gotoParentUnlock(function () {
      cloud.confirm('驳回这条兑换申请?积分不会变动。', '驳回申请').then(function (yes) {
        if (!yes) return;
        self.doReject(id);
      });
    });
  },

  /* 驳回同样要带 PIN —— 云函数会校验,前端必须原样传过去 */
  doReject(id) {
    const self = this;
    const run = function (pinCode) {
      cloud.loading('处理中');
      cloud.api.redeemReward({
        action: 'reject',
        childId: self.data.child._id,
        redemptionId: id,
        pin: pinCode || ''
      }, { quiet: true }).then(function (res) {
        cloud.hideLoading();
        if (res && !res.ok && res.code === 'PIN_REQUIRED') {
          self.askPinThen(function (code) { run(code); });
          return;
        }
        cloud.toast((res && res.message) || '已处理');
        self.loadAll();
      });
    };
    run(this._sessionPin || '');
  },

  /* 孩子撤回自己提交的申请(不需要家长身份) */
  onTapCancel(e) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    cloud.confirm('撤回这条兑换申请?', '撤回').then(function (yes) {
      if (!yes) return;
      cloud.api.redeemReward({
        action: 'cancel', childId: self.data.child._id, redemptionId: id
      }, { quiet: true }).then(function (res) {
        cloud.toast((res && res.message) || '已撤回');
        self.loadAll();
      });
    });
  },

  /* ================= 家长维护奖励 ================= */

  onOpenCreate() {
    const self = this;
    this.gotoParentUnlock(function () {
      self.setData({
        editorVisible: true,
        editorMode: 'create',
        editingId: '',
        formName: '',
        formCost: '',
        formTier: 'small',
        formStock: ''
      });
    });
  },

  onOpenEdit(e) {
    const id = e.currentTarget.dataset.id;
    const reward = this.findReward(id);
    if (!reward) return;
    const self = this;
    this.gotoParentUnlock(function () {
      self.setData({
        editorVisible: true,
        editorMode: 'update',
        editingId: id,
        formName: reward.name,
        formCost: String(reward.cost),
        formTier: reward.tier,
        formStock: reward.unlimited ? '' : String(reward.stock)
      });
    });
  },

  onCloseEditor() { this.setData({ editorVisible: false }); },

  noop() {},

  onFormName(e) { this.setData({ formName: e.detail.value }); },
  onFormCost(e) { this.setData({ formCost: e.detail.value }); },
  onFormStock(e) { this.setData({ formStock: e.detail.value }); },

  onPickTier(e) {
    this.setData({ formTier: e.currentTarget.dataset.key });
  },

  onSaveReward() {    const self = this;
    const name = String(this.data.formName || '').trim();
    const cost = parseInt(this.data.formCost, 10);
    const stockRaw = String(this.data.formStock || '').trim();

    if (!name) { cloud.toast('给奖励起个名字吧'); return; }
    if (name.length > 16) { cloud.toast('名字最多 16 个字'); return; }
    if (!isFinite(cost) || cost <= 0) { cloud.toast('所需积分要填大于 0 的整数'); return; }

    const payload = {
      action: this.data.editorMode,
      childId: this.data.child._id,
      name: name,
      cost: cost,
      tier: this.data.formTier
    };
    /* 不填 = 不限量(-1);填 0 表示暂时兑完也要保留意图 */
    payload.stock = stockRaw === '' ? -1 : Math.max(0, parseInt(stockRaw, 10) || 0);
    if (this.data.editorMode === 'update') payload.rewardId = this.data.editingId;

    cloud.loading('保存中');
    cloud.api.rewardSave(payload, { quiet: true }).then(function (res) {
      cloud.hideLoading();
      if (!res || !res.ok) {
        cloud.toast((res && res.message) || '保存失败');
        return;
      }
      cloud.toast('已保存', 'success');
      self.setData({ editorVisible: false });
      self.loadAll();
    });
  },

  onToggleRewardActive(e) {
    const id = e.currentTarget.dataset.id;
    const reward = this.findReward(id);
    if (!reward) return;
    const next = !reward.active;
    const self = this;
    cloud.confirm(next ? '重新上架「' + reward.name + '」?' : '下架「' + reward.name + '」?', '确认')
      .then(function (yes) {
        if (!yes) return;
        cloud.api.rewardSave({
          action: 'toggle', childId: self.data.child._id,
          rewardId: id, active: next
        }, { quiet: true }).then(function (res) {
          cloud.toast((res && res.ok) ? (next ? '已上架' : '已下架') : ((res && res.message) || '操作失败'));
          self.loadAll();
        });
      });
  },

  onDeleteReward(e) {
    const id = e.currentTarget.dataset.id;
    const reward = this.findReward(id);
    if (!reward) return;
    const self = this;

    this.gotoParentUnlock(function () {
      cloud.confirm('删除「' + reward.name + '」?已有的兑换记录不会受影响。', '删除奖励')
        .then(function (yes) {
          if (!yes) return;
          cloud.api.rewardSave({
            action: 'delete', childId: self.data.child._id, rewardId: id
          }, { quiet: true }).then(function (res) {
            if (res && !res.ok) {
              cloud.toast(res.message || '删除失败');
              return;
            }
            cloud.toast('已删除');
            self.loadAll();
          });
        });
    });
  },

  /* ================= 交互杂项 ================= */

  onToggleGroup(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ expandedGroup: this.data.expandedGroup === key ? '' : key });
  },

  onToggleRecords() {
    this.setData({ recordsExpanded: !this.data.recordsExpanded });
    this.applyRecordFold();
  },

  onRetry() { this.loadAll(); },

  onGoCheckin() { wx.switchTab({ url: '/pages/index/index' }); },

  /* ================= 工具 ================= */

  findReward(id) {
    const groups = this.data.groups || [];
    for (let i = 0; i < groups.length; i++) {
      const hit = (groups[i].list || []).filter(function (r) { return r._id === id; })[0];
      if (hit) return hit;
    }
    return null;
  },

  findRecord(id) {
    return (this.data.records || []).filter(function (r) { return r._id === id; })[0] || null;
  },

  /**
   * 需要家长身份时的统一入口。
   * 已解锁直接回调;未解锁跳 PIN 页,验证通过后由 onPinVerified 回调。
   */
  gotoParentUnlock(cb) {
    if (app().isParentView()) { cb(); return; }
    this._pinCb = cb;
    wx.navigateTo({
      url: '/pages/pin/pin?action=verify&next=back',
      fail: function () { cloud.toast('打开密码页失败'); }
    });
  },

  /* pin 页验证成功后返还(页面栈切回时由 pin 页调用) */
  onPinVerified(pinCode) {
    /* 只存实例属性,不进 data —— PIN 不该出现在渲染层的数据快照里 */
    this._sessionPin = pinCode || '';
    const cb = this._pinCb;
    this._pinCb = null;
    this.setData({ mode: app().globalData.mode, isParent: app().isParentView() });
    if (typeof cb === 'function') cb();
  }
});
