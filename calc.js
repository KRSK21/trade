/* 手机端的计算内核 —— 和电脑端 core/pnl.py、core/stats.py 是同一套口径。
 *
 * 为什么要在手机上重算一遍：手机里只有流水，没有电脑的数据库。
 * 要在一周/一月的汇总里看到盈亏，就必须在手机上做 FIFO 配对。
 *
 * 口径（和电脑端一致）：
 *   - 盈亏只算「已结算」的平仓；开仓当天不进胜率
 *   - 策略归到开仓那张单上
 *   - 期货：(平仓价 − 开仓价) × 手数 × 乘数 × 方向 − 手续费
 *   - 配不上的平仓单列，不进胜率
 *
 * 浏览器里挂到 window.TradeCalc，node 里可以 require 出来跑测试。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.TradeCalc = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var EPS = 1e-9;

  // 方向 → 开平 + 多空
  var DIR = {
    买入: { open: true, side: "long" },
    卖出: { open: false, side: "long" },
    多开: { open: true, side: "long" },
    空开: { open: true, side: "short" },
    平多: { open: false, side: "long" },
    平空: { open: false, side: "short" },
  };

  var MULT = {
    鸡蛋: 10, 螺纹钢: 10, 螺纹: 10, 热卷: 10, 铁矿石: 100, 焦炭: 100, 焦煤: 60,
    豆粕: 10, 豆油: 10, 棕榈油: 10, 菜粕: 10, 菜油: 10, 白糖: 10, 棉花: 5,
    玉米: 10, 淀粉: 10, 苹果: 10, 红枣: 5, 生猪: 16,
    黄金: 1000, 白银: 15, 沪铜: 5, 沪铝: 5, 沪锌: 5, 沪铅: 5, 沪镍: 1, 沪锡: 1,
    原油: 1000, 甲醇: 10, 纯碱: 20, 玻璃: 20, PTA: 5, PVC: 5, 塑料: 5,
    聚丙烯: 5, 尿素: 20, 沥青: 10, 燃料油: 10, 纸浆: 10, 烧碱: 30, 氧化铝: 20,
    沪深300: 300, 上证50: 300, 中证500: 200, 中证1000: 200,
    十年国债: 10000, 五年国债: 10000,
  };

  function guessMult(sym) {
    if (!sym) return null;
    var names = Object.keys(MULT).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < names.length; i++) {
      if (sym.indexOf(names[i]) === 0) return MULT[names[i]];
    }
    var letters = String(sym).replace(/[^a-zA-Z]/g, "");
    for (var j = 0; j < names.length; j++) {
      if (letters && letters.indexOf(names[j]) === 0) return MULT[names[j]];
    }
    return null;
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var f = parseFloat(v);
    return isFinite(f) ? f : null;
  }

  function multOf(r) {
    var m = num(r.multiplier);
    if (m && m > 0) return m;
    if (r.account === "future") {
      var g = guessMult(r.symbol);
      return g || 1;
    }
    return 1;
  }

  function dayDiff(a, b) {
    if (!a || !b) return null;
    var d1 = Date.parse(a + "T00:00:00"), d2 = Date.parse(b + "T00:00:00");
    if (isNaN(d1) || isNaN(d2)) return null;
    return Math.round((d2 - d1) / 86400000);
  }

  /* FIFO 配对。rows 可以是任意顺序，内部按 (日期, 原始下标) 排。 */
  function settle(rows) {
    var idxed = rows.map(function (r, i) { return { r: r, i: i }; });
    idxed.sort(function (a, b) {
      var da = String(a.r.trade_date || ""), db = String(b.r.trade_date || "");
      if (da < db) return -1;
      if (da > db) return 1;
      return a.i - b.i;
    });

    var lots = {};          // account|symbol|side -> [lot, ...]
    var settlements = [];   // 每条平仓
    var warnings = [];

    idxed.forEach(function (it) {
      var r = it.r;
      var info = DIR[r.direction];
      if (!info) { warnings.push("未知方向：" + r.direction); return; }
      var key = [r.account, r.symbol, info.side].join("|");
      var mult = multOf(r);

      if (info.open) {
        if (!lots[key]) lots[key] = [];
        lots[key].push({
          rem: num(r.qty) || 0,
          qty: num(r.qty) || 0,
          price: num(r.price) || 0,
          fee: num(r.fee) || 0,
          mult: mult,
          date: String(r.trade_date || "").slice(0, 10),
          strategy: r.strategy || "未标注",
          disc: num(r.discipline) || 0,
          stop: num(r.stop_price),
          target: num(r.target_price),
        });
        return;
      }

      var want = num(r.qty) || 0;
      var left = want;
      var slices = [];
      var queue = lots[key] || [];

      while (left > EPS && queue.length) {
        var lot = queue[0];
        var take = Math.min(left, lot.rem);
        var openQty = lot.qty || 1;
        var closeQty = want || 1;
        var oFee = lot.fee * (take / openQty);
        var cFee = (num(r.fee) || 0) * (take / closeQty);
        var diff = (num(r.price) || 0) - lot.price;
        if (info.side === "short") diff = -diff;
        slices.push({
          open: lot,
          qty: take,
          price: lot.price,
          pnl: diff * take * lot.mult - oFee - cFee,
          date: lot.date,
        });
        lot.rem -= take;
        left -= take;
        if (lot.rem <= EPS) queue.shift();
      }

      if (left > EPS) warnings.push(r.symbol + " " + r.direction + " 有 " + left + " 没有对应开仓单");

      var byStg = {}, dominant = null;
      slices.forEach(function (s) {
        byStg[s.open.strategy] = (byStg[s.open.strategy] || 0) + s.qty;
        if (!dominant || s.qty > dominant.qty) dominant = s;
      });
      var strategy = "未标注", mixed = false;
      var names = Object.keys(byStg);
      if (names.length) {
        strategy = names.reduce(function (a, b) { return byStg[a] >= byStg[b] ? a : b; });
        mixed = names.length > 1;
      } else {
        // 配不上开仓单时，退回平仓单自己填的策略（与电脑端一致；反正不进胜率）
        strategy = r.strategy || "未标注";
      }

      var matched = slices.reduce(function (a, s) { return a + s.qty; }, 0);
      var auto = slices.length ? Math.round(slices.reduce(function (a, s) { return a + s.pnl; }, 0) * 100) / 100 : null;
      var ov = num(r.pnl_override);
      var pnl = ov === null ? auto : ov;

      settlements.push({
        id: it.i,
        account: r.account,
        symbol: r.symbol,
        side: info.side,
        closeDate: String(r.trade_date || "").slice(0, 10),
        openDate: dominant ? dominant.date : null,
        strategy: strategy,
        mixed: mixed,
        qty: want,
        matched: matched,
        unmatched: left,
        pnl: pnl,
        isOverride: ov !== null,
        // 纪律分取开仓那笔的（dominant 是切片，真正的仓位在 .open 上）
        discipline: dominant && dominant.open
          ? (dominant.open.disc || 0)
          : (num(r.discipline) || 0),
        holdDays: dominant ? dayDiff(dominant.date, String(r.trade_date || "").slice(0, 10)) : null,
      });
    });

    // 剩余仓位 = 当前持仓
    var positions = [];
    Object.keys(lots).forEach(function (key) {
      var parts = key.split("|");
      var acc = parts[0], sym = parts[1], side = parts[2];
      var qty = 0, cost = 0, qtyMult = 0, first = null;
      var strategy = "", stop = null, target = null, disc = 0;
      lots[key].forEach(function (lot) {
        if (lot.rem <= EPS) return;
        var m = acc === "future" ? lot.mult : 1;
        qty += lot.rem;
        cost += lot.rem * lot.price * m;
        qtyMult += lot.rem * m;
        if (!first || lot.date < first) first = lot.date;
        strategy = lot.strategy || strategy;
        stop = lot.stop; target = lot.target; disc = lot.disc;
      });
      if (qty > EPS) {
        positions.push({
          account: acc, symbol: sym, side: side, qty: qty,
          avgPrice: qtyMult ? cost / qtyMult : 0,
          cost: cost, openDate: first, strategy: strategy,
          stop: stop, target: target, discipline: disc,
        });
      }
    });
    positions.sort(function (a, b) { return (a.openDate || "") < (b.openDate || "") ? 1 : -1; });

    return { settlements: settlements, positions: positions, warnings: warnings };
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  function aggregate(items) {
    var n = items.length;
    var wins = [], losses = [], total = 0;
    items.forEach(function (s) {
      if (s.pnl === null) return;
      total += s.pnl;
      if (s.pnl > 0) wins.push(s.pnl);
      else if (s.pnl < 0) losses.push(s.pnl);
    });
    var grossWin = wins.reduce(function (a, b) { return a + b; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (a, b) { return a + b; }, 0));
    return {
      n: n,
      total: round2(total),
      winRate: n ? round2((wins.length / n) * 100) : null,
      wins: wins.length,
      losses: losses.length,
      avgWin: wins.length ? round2(grossWin / wins.length) : null,
      avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
      payoff: wins.length && losses.length
        ? round2((grossWin / wins.length) / (grossLoss / losses.length)) : null,
      profitFactor: grossLoss ? round2(grossWin / grossLoss) : null,
      expectancy: n ? round2(total / n) : null,
    };
  }

  /* 区间汇总：start/end 是 'YYYY-MM-DD'，闭区间；空字符串表示不限 */
  function summarize(rows, start, end, todayStr) {
    var book = settle(rows);
    var inRange = function (d) {
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    };
    var ops = rows.filter(function (r) { return inRange(String(r.trade_date || "").slice(0, 10)); });
    var settled = book.settlements.filter(function (s) {
      return s.pnl !== null && inRange(s.closeDate);
    });
    var all = aggregate(settled);

    var byAcc = {};
    ["stock", "future"].forEach(function (acc) {
      byAcc[acc] = aggregate(settled.filter(function (s) { return s.account === acc; }));
    });

    var stgMap = {};
    settled.forEach(function (s) {
      (stgMap[s.strategy] = stgMap[s.strategy] || []).push(s);
    });
    var byStrategy = Object.keys(stgMap).map(function (k) {
      var a = aggregate(stgMap[k]);
      a.strategy = k;
      return a;
    }).sort(function (x, y) { return (y.total - x.total); });

    var low = settled.filter(function (s) { return s.discipline && s.discipline < 3; });
    var lowAgg = aggregate(low);
    var lowLoss = round2(low.reduce(function (a, s) {
      return a + (s.pnl !== null && s.pnl < 0 ? s.pnl : 0);
    }, 0));

    return {
      start: start, end: end,
      operations: ops.length,
      settledCount: settled.length,
      overall: all,
      byAccount: byAcc,
      byStrategy: byStrategy,
      low: { n: lowAgg.n, total: lowAgg.total, loss: lowLoss },
      positions: book.positions,
      warnings: book.warnings,
      settled: settled,
      today: todayStr || null,
    };
  }

  function fmtMoney(x, sign) {
    if (x === null || x === undefined) return "—";
    var s = Math.abs(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!sign) return (x < 0 ? "-" : "") + s;
    return (x > 0 ? "+" : x < 0 ? "-" : "") + s;
  }

  function fmtQty(q) {
    if (q === null || q === undefined) return "—";
    return String(Math.round(q * 10000) / 10000);
  }

  function md(d) {                      // '2026-11-12' → '11月12日'
    if (!d) return "";
    var p = String(d).split("-");
    if (p.length < 3) return d;
    return parseInt(p[1], 10) + "月" + parseInt(p[2], 10) + "日";
  }

  /* 一段可以直接贴给 AI 的汇总文字 */
  function summaryText(sum, rows) {
    var accName = { stock: "股票", future: "期货" };
    var L = [];
    var range = (sum.start && sum.end)
      ? md(sum.start) + "–" + md(sum.end)
      : (sum.start ? md(sum.start) + " 起" : (sum.end ? "截至 " + md(sum.end) : "全部"));
    L.push("【" + range + " 交易汇总】");
    L.push("");
    L.push("操作 " + sum.operations + " 笔，已结算 " + sum.settledCount + " 笔，"
      + "合计 " + fmtMoney(sum.overall.total, true) + " 元"
      + (sum.overall.winRate !== null ? "，胜率 " + sum.overall.winRate + "%" : "")
      + (sum.overall.payoff ? "，盈亏比 " + sum.overall.payoff : "") + "。");

    ["stock", "future"].forEach(function (acc) {
      var a = sum.byAccount[acc];
      if (!a.n) return;
      L.push(accName[acc] + "：" + fmtMoney(a.total, true) + " 元（" + a.n + " 笔，胜率 "
        + a.winRate + "%，平均每笔 " + fmtMoney(a.expectancy) + "）");
    });

    if (sum.byStrategy.length) {
      L.push("");
      L.push("按策略：");
      sum.byStrategy.forEach(function (s) {
        L.push("· " + s.strategy + "：" + s.n + " 笔，" + fmtMoney(s.total, true) + " 元，胜率 "
          + (s.winRate === null ? "—" : s.winRate + "%")
          + "，盈亏比 " + (s.payoff === null ? "—" : s.payoff)
          + (s.n < 5 ? "（样本不足）" : ""));
      });
    }

    if (sum.low.n) {
      L.push("");
      L.push("纪律：≤2 分的交易 " + sum.low.n + " 笔，合计 " + fmtMoney(sum.low.total, true)
        + " 元，其中亏损 " + fmtMoney(Math.abs(sum.low.loss)) + " 元。");
    }

    if (sum.positions.length) {
      L.push("");
      L.push("当前持仓：");
      sum.positions.forEach(function (p) {
        L.push("· " + p.symbol + " " + (p.side === "long" ? "多" : "空") + " "
          + fmtQty(p.qty) + (p.account === "stock" ? " 股" : " 手")
          + "，成本 " + fmtMoney(p.avgPrice) + "，" + p.strategy);
      });
    }

    var bad = sum.warnings;
    if (bad && bad.length) {
      L.push("");
      L.push("待处理：");
      bad.slice(0, 5).forEach(function (w) { L.push("· " + w); });
    }
    return L.join("\n");
  }

  function toCSV(arr) {
    var head = ["交易日期", "账户", "标的", "方向", "价格", "数量", "手续费", "合约乘数",
      "策略", "计划理由", "防守线", "目标位", "纪律评分", "备注"];
    var keys = ["trade_date", "account", "symbol", "direction", "price", "qty", "fee",
      "multiplier", "strategy", "plan_reason", "stop_price", "target_price",
      "discipline", "note"];
    function cell(v) {
      if (v === null || v === undefined) return "";
      var s = String(v);
      if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }
    var out = [head.join(",")];
    arr.forEach(function (r) {
      out.push(keys.map(function (k) {
        var v = r[k];
        if (k === "account") v = v === "stock" ? "股票" : v === "future" ? "期货" : v;
        return cell(v);
      }).join(","));
    });
    return out.join("\r\n");
  }

  return {
    settle: settle,
    summarize: summarize,
    summaryText: summaryText,
    toCSV: toCSV,
    guessMult: guessMult,
    fmtMoney: fmtMoney,
    fmtQty: fmtQty,
    md: md,
  };
});
