/* 勋章页 · 逻辑层 —— 三个板块(2026-09-24 重构)

   ★ 三块是什么
     1) 已获得勋章    小程序按打卡数据**自动判定**的(原型稿页面4，数据复用 homeData)
     2) 成绩记录      学校考试/测验成绩，**家长手工录入**(外部数据)
     3) 获得的荣誉    学校或机构颁发的荣誉奖章，**家长手工录入**，可带照片

   ★ 为什么 2、3 要单独走一个云函数，不塞进 homeData
     这两块只在勋章页用到，而 homeData 是首页每次都要拉的全量数据。
     塞进去等于让首页为"只有切到这个标签才看"的内容买单 ——
     首页之前就超时过一次(2026-09-23)，这条有前科。
     所以：首屏只加载勋章(数据 homeData 里本来就有，零成本)，
     **切到哪块才拉哪块**。

   ★ 权限
     两块都给孩子看(成绩是他自己的、荣誉本来就是要给人看的)，
     但**增删改必须家长密码** —— 校验在服务端 achievement 云函数里，
     前端"不显示按钮"只是体验，不算安全边界。

   ★ 记分方式两种(score 分数 / level 等级)
     孩子是一年级，学校常常只给"优秀/良好/加油"，不给分数。
     只做分数的话低年级用不上，所以做成可切换。

   ★★ 照片只认 cloud:// 地址
     chooseImage 给的是临时路径(http://tmp/…)，只在本机本次会话有效，
     存进数据库重启就变裂图 —— 2026-09-23 头像就是这么坏的。
     所以这里**先上传再存 fileID**，云函数那边还会再校验一次前缀。

   ★ 勋章数据来自 homeData,不是单独云函数
     勋章判定要读**全部**打卡记录，而 homeData 本来就要拉全量做连续打卡统计，
     再开一个云函数等于把同一份数据读两遍。直接复用。

   ★ 孩子模式看不到「情绪小勇士」
     它本质是"连续 N 天没犯某个错"的勋章，属于扣分维度。
     过滤在云函数里做(homeData 的 visibleMedals)，前端不做二次过滤 ——
     前端过滤等于把数据送到了孩子手机上再藏，不叫隔离。 */

/* ★ 用函数包起来，不要在这里直接 getApp() ——
   模块加载时机可能早于 App 就绪，那时 getApp() 返回 undefined，
   之后所有 app.xxx 都会炸(2026-09-23 修) */
const app = () => getApp();
const cloud = require('../../lib/cloud');
const dateUtil = require('../../utils/date');

Page({
  data: {
    /* ---------- 顶部标签 ---------- */
    tab: 'medal',                 /* medal | score | honor */

    /* ---------- 块1：勋章(现有) ---------- */
    loading: true,
    error: '',
    child: null,
    mode: 'child',

    unlockedList: [],
    lockedList: [],
    unlockedCount: 0,
    medalTotal: 0,
    percent: 0,
    streak: { current: 0, longest: 0, usedBreaks: 0, allowBreak: 1 },

    detailVisible: false,
    detail: null,

    /* ---------- 块2：成绩 ---------- */
    scoreList: [],
    scoreLoading: false,
    scoreLoaded: false,      /* 已经拉过一次了，切回来不再重复拉 */
    scoreError: '',

    /* ---------- 块3：荣誉 ---------- */
    honorList: [],
    honorLoading: false,
    honorLoaded: false,
    honorError: '',

    /* ---------- 录入弹层(两块共用) ---------- */
    editorVisible: false,
    editorKind: 'score',          /* score | honor */
    editorId: '',                 /* 空 = 新增 */
    saving: false,
    isParent: false,
    levels: ['优秀', '良好', '及格', '加油'],
    form: {
      date: '', subject: '', type: 'score',
      score: '', full: '100', level: '优秀', note: '',
      title: '', org: '', photo: ''
    }
  },

  onLoad() {
    this.setData({ mode: app().globalData.mode || 'child' });
  },

  onShow() {
    /* 自定义 tabBar:高亮索引要本页自己指定(见 custom-tab-bar/index.js 注释) */
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTab(2);
    }
    this.setData({
      mode: app().globalData.mode || 'child',
      isParent: app().isParentView()
    });
    this.loadAll();
  },

  onPullDownRefresh() {
    const t = this.data.tab;
    const jobs = [this.loadAll()];
    if (t === 'score') jobs.push(this.loadScore());
    if (t === 'honor') jobs.push(this.loadHonor());
    Promise.all(jobs).then(function () { wx.stopPullDownRefresh(); });
  },

  onShareAppMessage() {
    const n = this.data.child ? this.data.child.nickname : '宝贝';
    return {
      title: n + '已经拿到 ' + this.data.unlockedCount + ' 枚成长勋章啦',
      path: '/pages/medal/medal'
    };
  },

  /* ==================== 标签切换 ==================== */

  onSwitchTab(e) {
    const t = (e.currentTarget.dataset.tab || 'medal');
    if (t === this.data.tab) return;
    this.setData({ tab: t });
    /* 按需加载：只在该块第一次被打开时拉数据 */
    if (t === 'score' && !this.data.scoreLoaded) this.loadScore();
    if (t === 'honor' && !this.data.honorLoaded) this.loadHonor();
  },

  /* ==================== 块1：勋章 ==================== */

  loadAll() {
    const self = this;
    if (!app().globalData.cloudReady) {
      this.setData({ loading: false, error: '云开发还没准备好,请稍后再试' });
      return Promise.resolve();
    }
    /* ★ 切 tab 回来不再"清空重来"
       以前:每次 onShow ⇒ loading=true ⇒ 画面变骨架屏 ⇒ 等云函数回来才恢复。
       现在:已经有数据时走**静默刷新** —— 用上一屏数据撑住画面,后台拉新的,
             拉到了就地更新。表现为"秒开",且不会让 loading 卡住(失败也只 toast)。
       首次进入 this._hasData 为空 ⇒ 照旧显示骨架屏。 */
    const silent = !!this._hasData;
    if (!silent) this.setData({ loading: true, error: '' });

    return cloud.api.homeData({}, { quiet: true }).then(function (res) {
      if (!res || !res.ok) {
        /* 静默刷新失败 ⇒ **不要**把已有画面换成错误页,否则等于把好数据抹掉 */
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
      /* ★ 兜底：云函数层已保证不抛出，但 applyData 里读到异常结构仍可能抛。
         没有这一段的话 loading 会永远停在 true，界面卡在骨架屏(2026-09-23 修)。
         静默模式下同样保守处理：只 toast，不盖掉当前画面。 */
      .catch(function (err) {
        console.error('[medal] loadAll 渲染数据时出错', err);
        if (silent) {
          wx.showToast({ title: '刷新失败,下拉可重试', icon: 'none' });
          return;
        }
        self.setData({ loading: false, error: '数据加载失败,下拉可以重试' });
      });
  },

  applyData(res) {
    const medals = res.medals || [];
    const unlocked = medals.filter(function (m) { return m.unlocked; });
    const locked = medals.filter(function (m) { return !m.unlocked; });

    /* 未解锁的按进度倒序：最接近解锁的排前面，孩子才有"马上就成了"的感觉 */
    locked.sort(function (a, b) { return (b.percent || 0) - (a.percent || 0); });

    const total = res.medalTotal || medals.length || 0;
    const done = res.medalUnlockedCount || unlocked.length;

    this.setData({
      loading: false,
      error: '',
      child: res.child || app().globalData.child,
      mode: res.mode || 'child',
      unlockedList: unlocked,
      lockedList: locked,
      unlockedCount: done,
      medalTotal: total,
      percent: total > 0 ? Math.round(done / total * 100) : 0,
      streak: res.streak || this.data.streak
    });
  },

  onTapMedal(e) {
    const key = e.currentTarget.dataset.key;
    const all = this.data.unlockedList.concat(this.data.lockedList);
    const hit = all.filter(function (m) { return m.key === key; })[0];
    if (!hit) return;
    this.setData({ detailVisible: true, detail: hit });
  },

  onCloseDetail() { this.setData({ detailVisible: false }); },

  /* ==================== 块2/3：成绩与荣誉 ==================== */

  loadScore() {
    const self = this;
    this.setData({ scoreLoading: true, scoreError: '' });
    return cloud.api.achievement({ kind: 'score', act: 'list' }, { quiet: true })
      .then(function (res) {
        self.setData({
          scoreLoading: false,
          scoreLoaded: true,
          scoreList: (res && res.ok) ? (res.list || []) : [],
          scoreError: (res && res.ok) ? '' : ((res && res.message) || '加载失败,下拉可以重试')
        });
      })
      .catch(function (err) {
        console.error('[medal] loadScore 出错', err);
        self.setData({ scoreLoading: false, scoreLoaded: true, scoreError: '加载失败,下拉可以重试' });
      });
  },

  loadHonor() {
    const self = this;
    this.setData({ honorLoading: true, honorError: '' });
    return cloud.api.achievement({ kind: 'honor', act: 'list' }, { quiet: true })
      .then(function (res) {
        self.setData({
          honorLoading: false,
          honorLoaded: true,
          honorList: (res && res.ok) ? (res.list || []) : [],
          honorError: (res && res.ok) ? '' : ((res && res.message) || '加载失败,下拉可以重试')
        });
      })
      .catch(function (err) {
        console.error('[medal] loadHonor 出错', err);
        self.setData({ honorLoading: false, honorLoaded: true, honorError: '加载失败,下拉可以重试' });
      });
  },

  /* ==================== 录入弹层 ==================== */

  onAddScore() {
    const self = this;
    this.withPin(function () { self.openEditor('score', null); });
  },

  onAddHonor() {
    const self = this;
    this.withPin(function () { self.openEditor('honor', null); });
  },

  onEditItem(e) {
    const self = this;
    const kind = e.currentTarget.dataset.kind || 'score';
    const id = e.currentTarget.dataset.id || '';
    const list = (kind === 'score') ? this.data.scoreList : this.data.honorList;
    const item = list.filter(function (x) { return x._id === id; })[0] || null;
    if (!item) return;
    this.withPin(function () { self.openEditor(kind, item); });
  },

  openEditor(kind, item) {
    this.setData({
      editorVisible: true,
      editorKind: kind,
      editorId: (item && item._id) || '',
      form: {
        date: (item && item.date) || dateUtil.today(),
        subject: (item && item.subject) || '',
        type: (item && item.type) || 'score',
        score: (item && item.score) ? String(item.score) : '',
        full: (item && item.full) ? String(item.full) : '100',
        level: (item && item.level) || '优秀',
        note: (item && item.note) || '',
        title: (item && item.title) || '',
        org: (item && item.org) || '',
        photo: (item && item.photo) || ''
      }
    });
  },

  onCloseEditor() {
    if (this.data.saving) return;
    this.setData({ editorVisible: false });
  },

  onFormInput(e) {
    const k = e.currentTarget.dataset.field;
    if (!k) return;
    const patch = {};
    patch['form.' + k] = e.detail.value;
    this.setData(patch);
  },

  /* 二选一类的字段(分数/等级、等级选项)用这个，不走 input */
  onFormPick(e) {
    const k = e.currentTarget.dataset.field;
    const v = e.currentTarget.dataset.v;
    if (!k) return;
    const patch = {};
    patch['form.' + k] = v;
    this.setData(patch);
  },

  /* 照片：先上传云存储，只把 cloud:// 的 fileID 放进表单 */
  onPickPhoto() {
    const self = this;
    const upload = function (filePath) {
      cloud.loading('上传中');
      wx.cloud.uploadFile({
        cloudPath: 'honor/' + Date.now() + '.jpg',
        filePath: filePath,
        success: function (up) {
          cloud.hideLoading();
          /* ★ 只认 cloud:// 正式地址 —— 临时路径存库会失效(见文件头说明) */
          self.setData({ 'form.photo': up.fileID });
        },
        fail: function (err) {
          cloud.hideLoading();
          console.error('[medal] 荣誉照片上传失败', err);
          cloud.toast('照片上传失败,检查一下网络');
        }
      });
    };

    /* 新接口优先，老基础库回退 —— 两个都留着，别只写一个 */
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1, mediaType: ['image'], sizeType: ['compressed'],
        success: function (r) {
          const f = (r.tempFiles || [])[0];
          if (f) upload(f.tempFilePath);
        }
      });
      return;
    }
    wx.chooseImage({
      count: 1, sizeType: ['compressed'],
      success: function (r) {
        const f = (r.tempFilePaths || [])[0];
        if (f) upload(f);
      }
    });
  },

  onSubmitEditor() {
    if (this.data.saving) return;
    const k = this.data.editorKind;
    const f = this.data.form;

    const payload = {
      kind: k,
      act: this.data.editorId ? 'update' : 'add',
      id: this.data.editorId,
      pin: this._sessionPin || '',
      date: f.date,
      note: f.note
    };

    if (k === 'score') {
      if (!String(f.subject || '').trim()) { cloud.toast('请填写科目'); return; }
      payload.subject = f.subject;
      payload.type = f.type;
      if (f.type === 'score') {
        if (String(f.score || '').trim() === '') { cloud.toast('请填写分数'); return; }
        payload.score = f.score;
        payload.full = f.full;
      } else {
        payload.level = f.level;
      }
    } else {
      if (!String(f.title || '').trim()) { cloud.toast('请填写荣誉名称'); return; }
      payload.title = f.title;
      payload.org = f.org;
      payload.photo = f.photo;
    }

    this.setData({ saving: true });
    cloud.loading('保存中');
    this.doSave(payload, true);
  },

  /* retryAuth=true 表示"密码缺失/不对时，可以再验一次并自动重提"(只重提一次) */
  doSave(payload, retryAuth) {
    const self = this;
    cloud.api.achievement(payload, { quiet: true }).then(function (res) {
      if (res && res.ok) {
        cloud.hideLoading();
        self.setData({ saving: false, editorVisible: false });
        cloud.toast(res.message || '已保存', 'success');
        if (payload.kind === 'score') self.loadScore();
        else self.loadHonor();
        return;
      }

      if (res && (res.code === 'PIN_REQUIRED' || res.code === 'PIN_WRONG') && retryAuth) {
        self._sessionPin = '';
        cloud.toast(res.code === 'PIN_REQUIRED' ? '需要家长密码' : '密码不对,再输一次');
        self.gotoParentUnlock(function (code) {
          if (!code) { cloud.hideLoading(); self.setData({ saving: false }); return; }
          self._sessionPin = code;
          payload.pin = code;
          self.doSave(payload, false);
        });
        return;
      }

      cloud.hideLoading();
      self.setData({ saving: false });
      cloud.toast((res && res.message) || '保存失败');
    });
  },

  /* ==================== 删除 ==================== */

  onRemoveItem(e) {
    const self = this;
    const kind = e.currentTarget.dataset.kind || 'score';
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;

    wx.showModal({
      title: '删除这条记录',
      content: '删掉之后就找不回来了,确定吗?',
      confirmText: '删除',
      confirmColor: '#E2695A',
      success: function (r) {
        if (!r.confirm) return;
        self.withPin(function () { self.doRemove(kind, id, true); });
      }
    });
  },

  doRemove(kind, id, retryAuth) {
    const self = this;
    cloud.loading('删除中');
    cloud.api.achievement({
      kind: kind, act: 'remove', id: id, pin: self._sessionPin || ''
    }, { quiet: true }).then(function (res) {
      cloud.hideLoading();
      if (res && res.ok) {
        cloud.toast('已删除', 'success');
        if (kind === 'score') self.loadScore();
        else self.loadHonor();
        return;
      }
      if (res && (res.code === 'PIN_REQUIRED' || res.code === 'PIN_WRONG') && retryAuth) {
        self._sessionPin = '';
        cloud.toast(res.code === 'PIN_REQUIRED' ? '需要家长密码' : '密码不对,再输一次');
        self.gotoParentUnlock(function (code) {
          if (!code) return;
          self._sessionPin = code;
          self.doRemove(kind, id, false);
        });
        return;
      }
      cloud.toast((res && res.message) || '删除失败');
    });
  },

  /* ==================== 家长身份 ==================== */

  /* 需要家长身份时的统一入口(与首页同一套写法)。
     已经解锁且手上有密码 → 直接用；否则去 PIN 页验证一次。 */
  withPin(cb) {
    if (app().isParentView() && this._sessionPin) { cb(this._sessionPin); return; }
    this.gotoParentUnlock(cb);
  },

  gotoParentUnlock(cb) {
    this._pinCb = cb || null;
    wx.navigateTo({ url: '/pages/pin/pin?action=verify&next=back' });
  },

  /* PIN 页验证成功后回来 —— 由 pin 页调用(prev.onPinVerified(pinCode)) */
  onPinVerified(pinCode) {
    /* ★ 必须接住 pinCode：写操作要靠它给云函数(2026-09-23 首页就是漏了这个) */
    this._sessionPin = pinCode || '';
    const cb = this._pinCb;
    this._pinCb = null;
    this.setData({
      mode: app().globalData.mode,
      isParent: app().isParentView()
    });
    if (typeof cb === 'function') cb(this._sessionPin);
    else this.loadAll();
  },

  /* ==================== 其它 ==================== */

  noop() {},

  onRetry() {
    const t = this.data.tab;
    if (t === 'score') this.loadScore();
    else if (t === 'honor') this.loadHonor();
    else this.loadAll();
  },

  onGoCheckin() { wx.switchTab({ url: '/pages/index/index' }); },

  onGoStats() { wx.navigateTo({ url: '/sub/stats/stats' }); }
});
