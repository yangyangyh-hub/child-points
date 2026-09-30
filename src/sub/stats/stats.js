/* 统计页 · 逻辑层(原型稿页面5 —— 成长数据统计)

   ★ 折线图用自绘 canvas(lib/chart.js),Y 轴范围由服务端给
     为什么轴范围要服务端给:前端算一套、服务端算一套,两边一旦不一致,
     图上标着 +20 的点可能画在轴外。口径只在一处定义。

   ★ canvas 数据变化后必须重新取 node
     setData 换数据不会让旧 node 复活 —— chart.js 的 draw 函数持有 ctx,
     所以这里只在**首次**初始化时拿一次 node,以后只调 draw。
     切换 range 时重新 init,因为节点不会变但图表尺寸可能变。

   ★ 孩子模式看不到扣分维度
     trend[].penalty 是 null、topPenalty 是 []、report 里没有 watch 行 ——
     这些都是服务端决定的,前端不做二次过滤。 */

/* ★ 用函数包起来,不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪,那时 getApp() 返回 undefined,
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');

/* 上一次的统计数据,按统计区间分开存(week / month)。
   ★ 为什么用模块级变量而不是 this.xxx:每次 navigateTo 进来都是新页面实例,
     实例上的字段会丢;而 JS 模块在同一份上下文里只求值一次,可以跨实例兜住。
     仅用于"先给用户看到东西",绝不替代真正的请求 —— 后台每次都会静默刷新。 */
const STATS_CACHE = {};
const chart = require('../../lib/chart');

Page({
  data: {
    loading: true,
    error: '',
    empty: false,

    mode: 'child',
    isParent: false,

    range: 'week',           /* week | month(孩子模式强制 week) */
    rangeLabel: '近 7 天',

    startDate: '',
    endDate: '',

    /* 概览四格 */
    netPoints: 0,
    totalBonus: 0,
    totalPenalty: null,
    completionRate: 0,
    checkinDays: 0,
    totalCheckins: 0,
    activeTaskCount: 0,

    topBonus: [],
    topPenalty: [],

    report: null,
    trend: [],

    /* canvas 是否已就绪 —— 未就绪时显示占位,避免画到一半闪 */
    chartReady: false,
    hasTrend: false
  },

  onLoad() {
    this.setData({ mode: app().globalData.mode || 'child' });

    /* ★ 跨实例缓存 —— 这一页是 navigateTo 进来的,每次打开都是**全新的页面实例**,
       页面内的 this._hasData 会被重置,所以必须把上次的统计结果存在模块级变量里。
       有了它:第二次及以后点「成长统计」立刻显示上次的数据,后台再静默更新;
       没有它:每一次都得等一次完整的网络往返 + 云函数查询。 */
    const cached = STATS_CACHE[this.data.range];
    if (cached) {
      this._hasData = true;
      this.applyData(cached);
    }
  },

  onReady() {
    /* 先把 canvas 节点拿到手。数据没到也无所谓,draw 时再判断 */
    this.initChartNode();
  },

  onShow() {
    const isParent = app().isParentView();
    const mode = app().globalData.mode || 'child';
    const patch = { mode: mode, isParent: isParent };
    /* 孩子模式不允许看 30 天(服务端也会强制降级,这里同步避免一次无效请求) */
    if (!isParent && this.data.range === 'month') {
      patch.range = 'week';
      patch.rangeLabel = '近 7 天';
    }
    this.setData(patch);
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(function () { wx.stopPullDownRefresh(); });
  },

  onShareAppMessage() {
    return { title: '孩子的成长数据', path: '/pages/index/index' };
  },

  /* ================= canvas ================= */

  initChartNode() {
    const self = this;
    chart.initChart(this, 'trendChart', function (draw) {
      if (!draw) {
        self.setData({ chartReady: false });
        return;
      }
      self._draw = draw;
      self.setData({ chartReady: true });
      /* 节点就绪时如果数据已到,补画一次 */
      if (self.data.trend && self.data.trend.length) {
        self._draw(self.data.trend, self.data._axis);
      }
    });
  },

  /* ================= 数据 ================= */

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    /* ★ 再次进来不再"清空重来"(详见 medal.js 里同段注释)
       第二次点「成长统计」会立刻显示上一次的数据,后台再静默刷新。 */
    const silent = !!this._hasData;
    if (!silent) this.setData({ loading: true, error: '' });

    return cloud.api.statsData({ range: this.data.range }, { quiet: true })
      .then(function (res) {
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
        /* 缓存按区间存 —— 用户从「近 7 天」切到「近 30 天」时不能拿错数据 */
        STATS_CACHE[self.data.range] = res;
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
    const trend = res.trend || [];
    const hasTrend = trend.some(function (t) { return t.net !== 0 || t.bonus !== 0; });

    this.setData({
      loading: false,
      error: '',
      empty: !!res.empty,
      mode: res.mode || 'child',
      isParent: app().isParentView(),
      range: res.range || this.data.range,
      rangeLabel: (res.range === 'month') ? '近 30 天' : '近 7 天',
      startDate: res.startDate || '',
      endDate: res.endDate || '',

      netPoints: res.netPoints || 0,
      totalBonus: res.totalBonus || 0,
      totalPenalty: (res.totalPenalty === null || res.totalPenalty === undefined)
        ? null : res.totalPenalty,
      completionRate: res.completionRate || 0,
      checkinDays: res.checkinDays || 0,
      totalCheckins: res.totalCheckins || 0,
      activeTaskCount: res.activeTaskCount || 0,

      topBonus: res.topBonus || [],
      topPenalty: res.topPenalty || [],
      report: res.report || null,
      trend: trend,
      hasTrend: hasTrend
    });

    /* 轴范围存实例上:它不是渲染数据,放 data 会白白触发一次 setData */
    this._axis = res.axis || { min: 0, max: 5 };

    const self = this;
    /* 等这一轮 setData 落地再画,否则 canvas 尺寸可能还是旧的 */
    wx.nextTick(function () {
      if (self._draw) self._draw(trend, self._axis);
    });
  },

  /* ================= 切换区间 ================= */

  onSwitchRange(e) {
    const next = e.currentTarget.dataset.range;
    if (next === this.data.range) return;
    this.setData({
      range: next,
      rangeLabel: next === 'month' ? '近 30 天' : '近 7 天'
    });
    /* ★ 主动切换区间必须给用户**明确的反馈**,这里分两种情况:
         - 这个区间上次来过(有缓存)⇒ 立刻把上次结果铺上去,后台再更新,秒开
         - 没来过 ⇒ 显示骨架屏,让用户知道正在加载
       绝不能静默等待 —— 「看得见但点了没反应」是本项目踩过两次的坑。 */
    const rangeCache = STATS_CACHE[next];
    this._hasData = !!rangeCache;
    if (rangeCache) {
      this.applyData(rangeCache);
    } else {
      this.setData({ loading: true, error: '' });
    }
    this.loadAll();
  },

  onRetry() { this.loadAll(); },

  onGoCheckin() { wx.switchTab({ url: '/pages/index/index' }); },

  onGoLog() { wx.navigateTo({ url: '/sub/log/log' }); }
});
