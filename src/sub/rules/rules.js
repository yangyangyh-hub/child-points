/* 规则库页 · 逻辑层(原型稿页面2 —— 行为规则库 + 任务管理)

   ★ 这一页承担两个角色,靠模式区分
     孩子模式:只读的"家规清单",看看有哪些行为被记录
     家长模式:可增删改的"任务管理",能开关、改分、加新行为

   ★ 为什么不做成两个页面
     内容完全同源(同一份 taskList),拆开就要维护两套渲染逻辑。
     权限差别只在"操作按钮出不出现",用一个 isParent 就够了 ——
     真正的权限在服务端(taskSave 会校验 _openid)。

   ★ 预设任务不能删,只能关
     它挂在勋章判定上(medalTag)。删掉「每日阅读20分钟」,
     阅读小明星永远解锁不了,而家长不会知道这层因果。
     所以删除按钮只给非预设项,预设项给"关闭"。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');

Page({
  data: {
    loading: true,
    error: '',

    mode: 'child',
    isParent: false,

    tab: 'bonus',          /* bonus | penalty */
    bonus: [],
    penalty: [],
    total: 0,

    /* 表单弹层 */
    editorVisible: false,
    editorMode: 'create',
    editingId: '',
    formName: '',
    formScore: '',
    formCategory: 'study',
    formMedalTag: '',

    categories: [],
    medalTagOptions: [],

    /* 展开已关闭的项 */
    showInactive: false
  },

  onLoad() {
    this.setData({ mode: app().globalData.mode || 'child' });
  },

  onShow() {
    const isParent = app().isParentView();
    const mode = app().globalData.mode || 'child';
    /* 孩子模式只能看加分项 —— 切到孩子时如果正停在扣分栏,拉回来 */
    const patch = { mode: mode, isParent: isParent };
    if (!isParent && this.data.tab === 'penalty') patch.tab = 'bonus';
    this.setData(patch);
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  onShareAppMessage() {
    return { title: '我们的家庭积分规则', path: '/pages/index/index' };
  },

  /* ================= 加载 ================= */

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });

    return cloud.api.taskList({}, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        self.setData({
          loading: false,
          error: (res && res.message) || '加载失败,下拉可以重试'
        });
        return;
      }
      self.setData({
        loading: false,
        error: '',
        bonus: res.bonus || [],
        penalty: res.penalty || [],
        total: res.total || 0,
        categories: res.categories || [],
        medalTagOptions: res.medalTagOptions || []
      });
    })
      /* ★ 兜底:云函数层已保证不抛出,但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true,界面卡在骨架屏(2026-09-23 修)。 */
      .catch(function (err) {
        console.error('[loadAll] 渲染数据时出错', err);
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },
  /* ================= 切换分栏 ================= */

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'penalty' && !this.data.isParent) return;
    this.setData({ tab: tab });
  },

  onToggleInactive() {
    this.setData({ showInactive: !this.data.showInactive });
  },

  /* ================= 开关 ================= */

  onToggleActive(e) {
    const id = e.currentTarget.dataset.id;
    const kind = e.currentTarget.dataset.kind;
    const item = this.findTask(id, kind);
    if (!item) return;

    const next = !item.active;
    const self = this;

    this.gotoParentUnlock(function () {
      cloud.api.taskSave({
        action: 'toggle', taskId: id, active: next
      }, { quiet: true }).then(function (res) {
        if (!res || !res.ok) {
          cloud.toast((res && res.message) || '操作失败');
          return;
        }
        cloud.toast(res.message || (next ? '已开启' : '已关闭'));
        self.loadAll();
      });
    });
  },

  /* ================= 新增 / 编辑 ================= */

  onOpenCreate() {
    const self = this;
    this.gotoParentUnlock(function () {
      self.setData({
        editorVisible: true,
        editorMode: 'create',
        editingId: '',
        formName: '',
        /* 分值一律填正数,正负由当前分栏决定(见 onSaveTask) */
        formScore: '',
        formCategory: 'study',
        formMedalTag: ''
      });
    });
  },

  onOpenEdit(e) {
    const id = e.currentTarget.dataset.id;
    const kind = e.currentTarget.dataset.kind;
    const item = this.findTask(id, kind);
    if (!item) return;

    const self = this;
    this.gotoParentUnlock(function () {
      self.setData({
        editorVisible: true,
        editorMode: 'update',
        editingId: id,
        formName: item.name,
        /* 扣分项的 score 是负数,填在输入框里带负号会让家长困惑,
           所以编辑时显示绝对值,由当前 tab 决定正负 */
        formScore: String(Math.abs(item.score)),
        formCategory: item.category || 'study',
        formMedalTag: item.medalTag || ''
      });
    });
  },

  onCloseEditor() { this.setData({ editorVisible: false }); },

  noop() {},

  onFormName(e) { this.setData({ formName: e.detail.value }); },
  onFormScore(e) { this.setData({ formScore: e.detail.value }); },

  onPickCategory(e) {
    this.setData({ formCategory: e.currentTarget.dataset.key });
  },

  onPickMedalTag(e) {
    const key = e.currentTarget.dataset.key;
    /* 再点一次取消选择 */
    this.setData({ formMedalTag: this.data.formMedalTag === key ? '' : key });
  },

  onSaveTask() {
    const self = this;
    const name = String(this.data.formName || '').trim();
    const raw = parseInt(this.data.formScore, 10);
    const isPenalty = this.data.tab === 'penalty';

    if (!name) { cloud.toast('给这条行为起个名字吧'); return; }
    if (name.length > 20) { cloud.toast('名字最多 20 个字'); return; }
    if (!isFinite(raw) || raw === 0) { cloud.toast('分值要填一个非 0 的整数'); return; }
    if (Math.abs(raw) > 50) { cloud.toast('单项分值不要超过 50 分'); return; }

    /* 方向由当前分栏决定,不让家长自己填负号 —— 少一个犯错的机会 */
    const score = isPenalty ? -Math.abs(raw) : Math.abs(raw);

    const payload = {
      childId: app().globalData.child ? app().globalData.child._id : '',
      name: name,
      score: score,
      category: this.data.formCategory,
      medalTag: this.data.formMedalTag
    };

    if (this.data.editorMode === 'update') {
      payload.action = 'update';
      payload.taskId = this.data.editingId;
    } else {
      payload.action = 'create';
    }

    cloud.loading('保存中');
    cloud.api.taskSave(payload, { quiet: true }).then(function (res) {
      cloud.hideLoading();
      if (!res || !res.ok) {
        cloud.toast((res && res.message) || '保存失败,请重试');
        return;
      }
      cloud.toast('已保存', 'success');
      self.setData({ editorVisible: false });
      self.loadAll();
    });
  },

  /* ================= 删除 ================= */

  onDeleteTask(e) {
    const id = e.currentTarget.dataset.id;
    const kind = e.currentTarget.dataset.kind;
    const item = this.findTask(id, kind);
    if (!item) return;

    /* 预设项直接给说明,不发请求 —— 少一次无效往返 */
    if (item.preset) {
      wx.showModal({
        title: '不能删除',
        content: '「' + item.name + '」是系统自带的行为,和勋章挂钩。可以关闭它,效果一样,而且以后能再打开。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    const self = this;
    this.gotoParentUnlock(function () {
      cloud.confirm('删除「' + item.name + '」?历史打卡记录会保留。', '删除行为')
        .then(function (yes) {
          if (!yes) return;
          cloud.api.taskSave({
            action: 'delete', taskId: id
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

  onRetry() { this.loadAll(); },

  /* ================= 工具 ================= */

  findTask(id, kind) {
    const list = (kind === 'penalty') ? this.data.penalty : this.data.bonus;
    return (list || []).filter(function (t) { return t._id === id; })[0] || null;
  },

  gotoParentUnlock(cb) {
    if (app().isParentView()) { cb(); return; }
    this._pinCb = cb;
    wx.navigateTo({
      url: '/pages/pin/pin?action=verify&next=back',
      fail: function () { cloud.toast('打开密码页失败'); }
    });
  },

  onPinVerified() {
    this.setData({ mode: app().globalData.mode, isParent: app().isParentView() });
    const cb = this._pinCb;
    this._pinCb = null;
    if (typeof cb === 'function') { cb(); return; }
    this.loadAll();
  }
});
