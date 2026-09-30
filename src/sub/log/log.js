/* 成长日志页 · 逻辑层(原型稿页面6)

   ★ 与首页「添加今日备注」写的是同一条记录
     _id = `${childId}_${date}`,同一天再写就是修改。所以这一页既能
     回顾历史,也能补写过去某天的日志(选日期 → 写 → 保存)。

   ★ netPoints 是写入时的**快照**,不是实时算的
     三个月后家长改了一条流水,历史日志里的"当天净得分"不会跟着变 ——
     这条日志的语境属于那天,不该被后来的修正污染。

   ★ 分页用 offset 而不是游标
     logs 是按 date 字符串倒序,不会像流水那样高频插入,offset 足够。
     每页 20 条(PAGE 由云函数定),前端只负责累加。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');
const dateUtil = require('../../utils/date');

Page({
  data: {
    loading: true,
    error: '',
    loadingMore: false,

    list: [],
    total: 0,
    hasMore: false,
    nextOffset: 0,

    /* 编辑弹层 */
    editorVisible: false,
    editingDate: '',
    editingDateText: '',
    editingText: '',
    editingExisting: false,
    maxLen: 300,

    /* 日期选择弹层 */
    pickerVisible: false,
    pickerValue: '',
    maxDate: ''
  },

  onLoad() {
    const today = dateUtil.today();
    this.setData({ maxDate: today, pickerValue: today });
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadMore();
  },

  onShareAppMessage() {
    return { title: '记录孩子成长的每一天', path: '/pages/index/index' };
  },

  /* ================= 加载 ================= */

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });

    return cloud.api.logList({ offset: 0 }, { quiet: true }).then(function (res) {
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
        list: res.list || [],
        total: res.total || 0,
        hasMore: !!res.hasMore,
        nextOffset: res.nextOffset || 0
      });
    })
      /* ★ 兜底:云函数层已保证不抛出,但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true,界面卡在骨架屏(2026-09-23 修)。 */
      .catch(function (err) {
        console.error('[loadAll] 渲染数据时出错', err);
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },
  loadMore() {
    const self = this;
    this.setData({ loadingMore: true });

    return cloud.api.logList({ offset: this.data.nextOffset }, { quiet: true })
      .then(function (res) {
        self.setData({ loadingMore: false });
        if (!res || !res.ok) return;
        self.setData({
          list: self.data.list.concat(res.list || []),
          total: res.total || self.data.total,
          hasMore: !!res.hasMore,
          nextOffset: res.nextOffset || self.data.nextOffset
        });
      });
  },

  /* ================= 写日志 ================= */

  /* 写今天 */
  onOpenToday() {
    const today = dateUtil.today();
    const hit = this.data.list.filter(function (g) { return g.date === today; })[0] || null;
    this.setData({
      editorVisible: true,
      editingDate: today,
      editingDateText: '今天 · ' + (hit ? hit.dateText : dateUtil.monthDayText(today)),
      editingText: hit ? hit.text : '',
      editingExisting: !!hit
    });
  },

  /* 补写某天 */
  onTapItem(e) {
    const id = e.currentTarget.dataset.id;
    const hit = this.data.list.filter(function (g) { return g._id === id; })[0];
    if (!hit) return;
    this.setData({
      editorVisible: true,
      editingDate: hit.date,
      editingDateText: hit.dateText + ' ' + hit.weekday,
      editingText: hit.text,
      editingExisting: true
    });
  },

  onOpenPicker() {
    this.setData({ pickerVisible: true, pickerValue: this.data.editingDate || this.data.maxDate });
  },

  onClosePicker() { this.setData({ pickerVisible: false }); },

  onPickerChange(e) {
    const v = e.detail.value;
    this.setData({ pickerValue: v });
  },

  onPickerConfirm() {
    const v = this.data.pickerValue;
    if (!v) { this.setData({ pickerVisible: false }); return; }

    /* 选了过去某天:如果那天已有日志,把内容带出来,避免覆盖式误操作 */
    const hit = this.data.list.filter(function (g) { return g.date === v; })[0] || null;
    this.setData({
      pickerVisible: false,
      editingDate: v,
      editingDateText: dateUtil.monthDayText(v) + ' ' + dateUtil.weekdayCn(v),
      editingText: hit ? hit.text : '',
      editingExisting: !!hit
    });
  },

  onCloseEditor() { this.setData({ editorVisible: false }); },

  noop() {},

  onLogInput(e) {
    this.setData({ editingText: e.detail.value });
  },

  onSaveLog() {
    const self = this;
    const text = String(this.data.editingText || '').trim();
    const day = this.data.editingDate;

    if (!day) { cloud.toast('先选个日期'); return; }
    if (!text) { cloud.toast('写点什么再保存吧'); return; }

    cloud.loading('保存中');
    cloud.api.logSave({ date: day, text: text }, { quiet: true }).then(function (res) {
      cloud.hideLoading();
      if (!res || !res.ok) {
        cloud.toast((res && res.message) || '保存失败,请重试');
        return;
      }
      cloud.toast(res.created ? '已记录' : '已更新', 'success');
      self.setData({ editorVisible: false });
      self.loadAll();
    });
  },

  /* 清空当天日志(内容清空 = 删除这条,不是留空壳) */
  onClearLog() {
    const self = this;
    const day = this.data.editingDate;
    if (!day) return;

    cloud.confirm('清空这天的日志内容?', '清空').then(function (yes) {
      if (!yes) return;
      /* delete 是保留字,作为对象键名在这里是合法的,但显式构造更清楚 */
      const payload = { date: day, text: '' };
      payload['delete'] = true;
      cloud.api.logSave(payload, { quiet: true }).then(function (res) {
        cloud.toast((res && res.message) || '已清空');
        self.setData({ editorVisible: false });
        self.loadAll();
      });
    });
  },

  onRetry() { this.loadAll(); },

  onGoCheckin() { wx.switchTab({ url: '/pages/index/index' }); }
});
