/* 自定义 tabBar —— 放大图标与文字,并修正切换时的状态残留。

   ★ 三个已知坑(任一踩了都表现为"底部不见了 / 点了没反应"):
   1. 自定义 tabBar 是「每个页面各自一份实例」,切换后 selected 不会自动跟着变
      ⇒ 必须由页面 onShow 调 setTab() 显式指定,否则高亮会停在上一个页面。
   2. 自定义 tabBar 不占布局流(position:fixed) ⇒ 页面内容会被压住,
      ⇒ 各 tab 页根容器要留出 136rpx + 安全区的底部内边距。
   3. 本组件不能与 app.json 的 lazyCodeLoading 同用(官方社区实测:
      开启按需注入后 getTabBar() 返回 null、tabBar 直接不显示)。
   4. switchTab 的 url 必须绝对路径(见 onTap 里的说明)。 */

Component({
  data: {
    selected: 0,
    tabs: [
      {
        pagePath: '/pages/index/index',
        text: '打卡',
        icon: '/assets/tab/check.png',
        iconOn: '/assets/tab/check_on.png'
      },
      {
        pagePath: '/pages/reward/reward',
        text: '奖励',
        icon: '/assets/tab/gift.png',
        iconOn: '/assets/tab/gift_on.png'
      },
      {
        pagePath: '/pages/medal/medal',
        text: '勋章',
        icon: '/assets/tab/medal.png',
        iconOn: '/assets/tab/medal_on.png'
      },
      {
        pagePath: '/pages/mine/mine',
        text: '我的',
        icon: '/assets/tab/mine.png',
        iconOn: '/assets/tab/mine_on.png'
      }
    ]
  },

  methods: {
    /* 页面 onShow 调这个指定当前页,顺便清掉自己页面上的选中态残留 */
    setTab(index) {
      if (this.data.selected === index) return;
      this.setData({ selected: index });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;

      /* ★★ switchTab 的 url 必须带前导斜杠(绝对路径)
         官方 wx.switchTab 文档示例就是 `url: '/index'`。
         曾自作聪明写成 path.replace(/^\//,'') 去掉斜杠 ⇒ 变成相对路径
         (相对当前页面目录解析)⇒ 找不到页面 ⇒ switchTab 走 fail,
         而当时又没写 fail 回调 ⇒ **静默失败,表现就是"点了四个按钮都没反应"**
         (2026-09-29 用户反馈后,对照项目里其余 20 处 switchTab 全为绝对路径才确认)。

         ★ 同理:不要用组件的 selected 去拦截点击 —— 组件的 selected 依赖
         页面 setTab() 生效,一旦那条链路失效,点"当前高亮那一项"就永远跳不动。
         跳转与高亮解耦:点谁就跳谁,重复点同一项 switchTab 本身是 no-op。 */
      wx.switchTab({
        url: path,
        fail: function (err) {
          /* 跳转失败必须让用户看得见 —— 静默失败的排查成本极高 */
          console.error('[tabbar] switchTab 失败:', path, err);
          wx.showToast({ title: '页面跳转失败', icon: 'none' });
        }
      });
    }
  }
});
