/* 每周成长总结 —— 模板拼装(R8,2026-09-22 yang 拍板)

   ★ 为什么不用大模型
     个人主体、0 运维、21 天工期。接大模型意味着:
     自付 API 费用 + 处理网络超时 + 处理内容安全审核(wx.msgSecCheck)
     + 家长看到一句"AI 生成"的话却不知道为什么这么说。
     模板拼装能覆盖原型稿要的那三类信息(哪项进步、哪项退步、哪项仍需改善),
     且**每一句都能指回具体数字**,家长看了能信。

   ★ 句子怎么写才不生硬
     不说"作业完成度提升 20%"这种报告腔,而说
     「认真完成学校作业 比上周多做了 3 天」—— 家长要的是事实,不是百分比。
     全部输出为**可点的短句数组**,前端按行渲染,后续要加图标/配色也不用改结构。 */

const { CAT_LABEL } = require('./constants');

/* 计算两个时间窗内、按任务维度的完成天数差 */
function compareWindows(thisWeek, lastWeek) {
  const out = [];
  const names = new Set();
  Object.keys(thisWeek || {}).forEach(function (k) { names.add(k); });
  Object.keys(lastWeek || {}).forEach(function (k) { names.add(k); });

  names.forEach(function (name) {
    const now = (thisWeek[name] && thisWeek[name].days) || 0;
    const before = (lastWeek[name] && lastWeek[name].days) || 0;
    out.push({
      name: name,
      category: (thisWeek[name] && thisWeek[name].category) ||
                (lastWeek[name] && lastWeek[name].category) || '',
      score: (thisWeek[name] && thisWeek[name].score) || 0,
      now: now, before: before, diff: now - before
    });
  });
  return out;
}

/* 取 TOP N(按天数降序,只取有量的) */
function topN(rows, n) {
  return rows.filter(function (r) { return r.now > 0; })
             .sort(function (a, b) { return b.now - a.now; })
             .slice(0, n);
}

/**
 * 生成一周的成长总结。
 * @param {Object} p
 * @param {Object} p.thisWeek  本周 `{ 任务名: { days, category, score, penaltyDays } }`
 * @param {Object} p.lastWeek  上周(同结构)
 * @param {number} p.netPoints 本周净得分
 * @param {number} p.bonusTotal 本周加分合计
 * @param {number} p.penaltyTotal 本周扣分合计(正数)
 * @param {number} p.checkinDays 本周打卡天数
 * @param {string} p.weekLabel 如 "9月15日–9月21日"
 * @returns {{headline:string, lines:Array<{kind,text}>, empty:boolean}}
 */
function buildWeeklyReport(p) {
  const rows = compareWindows(p.thisWeek, p.lastWeek);
  const bonusRows = rows.filter(function (r) { return r.score > 0; });
  const penaltyRows = rows.filter(function (r) { return r.score < 0; });

  const lines = [];
  const checkinDays = Number(p.checkinDays) || 0;

  /* ---- 1. 头部:一句话概括这周 ---- */
  let headline;
  if (checkinDays === 0) {
    headline = '这周还没有打卡记录';
  } else if (checkinDays >= 6) {
    headline = '这周几乎每天都坚持下来了,很棒';
  } else if (checkinDays >= 4) {
    headline = '这周坚持了 ' + checkinDays + ' 天,基本稳定';
  } else {
    headline = '这周打卡 ' + checkinDays + ' 天,下周可以再多一点';
  }

  /* ---- 2. 做得好的地方(高频加分 TOP3,带环比) ---- */
  const topBonus = topN(bonusRows, 3);
  topBonus.forEach(function (r, i) {
    let text;
    if (r.before === 0) {
      text = r.name + ' 做到了 ' + r.now + ' 天' + (i === 0 ? ',这周新开始保持的习惯' : '');
    } else if (r.diff > 0) {
      text = r.name + ' 比上周多做了 ' + r.diff + ' 天';
    } else if (r.diff === 0) {
      text = r.name + ' 保持在 ' + r.now + ' 天,和上周一样稳定';
    } else {
      text = r.name + ' 做了 ' + r.now + ' 天,比上周少 ' + Math.abs(r.diff) + ' 天';
    }
    lines.push({ kind: 'good', text: text });
  });

  /* ---- 3. 需要注意的地方(高频扣分 TOP3) ---- */
  const topPenalty = topN(penaltyRows, 3);
  topPenalty.forEach(function (r) {
    let text;
    if (r.now === 0) return;
    if (r.before > 0 && r.diff < 0) {
      text = r.name + ' 出现了 ' + r.now + ' 次,比上周少了 ' + Math.abs(r.diff) + ' 次,在变好';
      lines.push({ kind: 'good', text: text });
      return;
    }
    if (r.now >= 3) {
      text = r.name + ' 出现了 ' + r.now + ' 次,这是下周可以帮一帮他的地方';
    } else {
      text = r.name + ' 出现了 ' + r.now + ' 次,偶尔一次不用太在意';
    }
    lines.push({ kind: 'watch', text: text });
  });

  /* ---- 4. 积分概览 ---- */
  const net = Number(p.netPoints) || 0;
  const bonus = Number(p.bonusTotal) || 0;
  const penalty = Number(p.penaltyTotal) || 0;
  if (bonus > 0 || penalty > 0) {
    lines.push({
      kind: 'stat',
      text: '本周加分 ' + bonus + ' 分,扣分 ' + penalty + ' 分,净得 ' + (net >= 0 ? '+' : '') + net + ' 分'
    });
  }

  /* ---- 5. 空状态兜底 ---- */
  if (lines.length === 0) {
    return {
      headline: headline,
      lines: [{ kind: 'watch', text: '还没有足够的数据生成分析,多打卡几天就有了' }],
      empty: true
    };
  }

  return { headline: headline, lines: lines, empty: false };
}

module.exports = { buildWeeklyReport, compareWindows };
