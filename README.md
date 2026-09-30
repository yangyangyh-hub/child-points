# 儿童成长积分打卡小程序 · 项目说明

> 位置:`D:\workbuddy\net\child-points\`
> 创建:2026-09-22

## 这是什么

给一年级小学生做的一个积分打卡小程序。家长负责操作,孩子看着自己的积分成长。

**独立项目,不引用任何其他项目的代码。**

## 已确定的前提

| 项 | 值 |
|---|---|
| 主体类型 | 个人(不能用微信支付、不能投放广告) |
| 孩子数量 | 单个 |
| AppID | `wx2938ccdd9266f246` |
| 云环境 ID | `cloud1-d5g6qwwtfed18c10c` |
| 技术栈 | 微信小程序原生 + 微信云开发 |
| 规模 | 9 个页面(主包 5 + 分包 4)、**16 个云函数**、**10 张集合** |

## ★ 现在要你做的事

**看 `docs/上线前操作清单.md`** —— 建集合、设权限、传云函数,只有你能做。

## 目录结构

```
child-points/                        ← ★★ 开发者工具打开这一层
├── project.config.json             ← ★ 项目配置(唯一入口,别删)
├── project.private.config.json     ← 个人配置(工具会自己改)
├── PROJECT.md                      ← 做到哪 / 卡在哪 / 待澄清
├── ARCHITECTURE.md                 ← 架构决策、数据模型、云函数设计
├── README.md                       ← 本文件
│
├── docs/
│   ├── 上线前操作清单.md             ← ★★ 现在看这个
│   └── 数据库权限与索引配置.md        ← 权限的详细原理
│
├── src/                            ← miniprogramRoot:小程序前端源码
│   ├── app.js / app.json / app.wxss / config.js / sitemap.json
│   ├── utils/date.js               ← 日期工具,禁用 toISOString()
│   ├── lib/cloud.js                ← 云函数调用封装(统一错误处理)
│   ├── lib/chart.js                ← 自绘 canvas 折线图
│   ├── pages/                      ← 主包 5 页
│   │   ├── index/                  ← 首页:积分 + 日历 + 打卡
│   │   ├── reward/                 ← 奖励:商城 + 两步式兑换
│   │   ├── medal/                  ← 勋章墙
│   │   ├── pin/                    ← 家长密码(自绘键盘)
│   │   └── mine/                   ← 我的:入口聚合
│   └── sub/                        ← 分包 4 页
│       ├── rules/                  ← 加分/扣分规则管理
│       ├── stats/                  ← 统计:折线图 + TOP3
│       ├── log/                    ← 成长日志(分页)
│       └── setting/                ← 系统设置
│
├── functions/                      ← ★ 云函数源码(只改这里)
│   └── 16 个函数
│
├── cloudfunctions/                 ← cloudfunctionRoot:上传目录
│   ├── _shared/                    ← 共享模块源码(pin/ledger/streak/constants 等)
│   └── 16 个函数副本(含各自的 _shared/,勿手改)
│
└── tests/                          ← 自动检查(891 项断言)
    ├── run-all.js                  ← ★ 一键跑全部
    ├── syncCloud.js                ← functions/ → cloudfunctions/ 同步
    ├── cloudCheck.js               ← 源码与副本一致性(168 项)
    ├── deployLoad.test.js          ← 副本可加载 + 前后端常量对账/C.xxx引用检查(67 项)
    ├── ledger.test.js              ← 积分账本与双积分口径(47 项)
    ├── medal.test.js               ← 勋章判定与预设数据 + 家长 PIN(154 项)
    ├── taskToggle.test.js          ← 打卡开关与扣分上限(22 项)
    ├── pages.test.js               ← 页面逻辑与状态机(44 项)
    ├── resetAll.test.js            ← 清空数据云函数(40 项)
    ├── staticCheck.js              ← 静态合规检查(331 项)
    └── verify-*.js                 ← 3 个"断言有效性探针"(不进日常基线)
```

## 本地能跑的检查

```bash
node tests/run-all.js     # 一键跑全部 891 项
```

**改完代码先跑这个,再去开发者工具里编译** —— 能提前拦掉大部分低级错误。
它还会自动把 `functions/` 同步到 `cloudfunctions/`,省得你手动复制。

单独跑也可以:

```bash
node tests/staticCheck.js     # 静态自检:页面/事件/云函数引用是否对得上
node tests/taskToggle.test.js # 积分算法:扣分方向、幂等、上限
```

## ★ 两条必须记住的约定

1. **改云函数只改 `functions/<函数名>/`**,改完跑 `node tests/run-all.js`。
   `cloudfunctions/` 里的东西是自动生成的,手改会被覆盖。
2. **开发者工具打开 `child-points/` 这一层**(项目根,不是 `src/` 也不是
   `cloudfunctions/`)。根目录的 `project.config.json` 同时声明了
   `miniprogramRoot: "src/"` 和 `cloudfunctionRoot: "cloudfunctions/"`,
   所以**一个窗口**既能编译前端又能右键上传云函数,不用开第二个项目。

## 关键设计约束(改代码时别破坏)

| 约束 | 为什么 |
|---|---|
| **积分只能由云函数改** | 前端可被反编译,前端校验等于没有 |
| **打卡记录用确定性 `_id`** | 云数据库无 unique 索引,先查后写在并发下会重复加分 |
| **`score` 用带符号整数** | 取消扣分任务时 `delta=(done?1:-1)*score` 会算错 |
| **流水只增不改** | 撤销 = 追加负数冲正,不删历史 |
| **日期用本地时区拼接** | `toISOString()` 在中国早上 8 点前会算成昨天 |
| **WXML 里不能写 `str[0]`** | 表达式不支持字符串下标,首字要在 JS 里算好 |
| **双积分不能混用** | 可用积分能减(兑换/扣分),累计积分只增不减 |
| **扣分上限是"绝对值之和 ≤ N"** | 不是"净扣分 ≤ N",算法在 `_shared/ledger.js` |

## 下一步

按 `docs/上线前操作清单.md` 走完,然后回来告诉我结果。
