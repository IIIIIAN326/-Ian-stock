const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

/* =========================================================
   IAN STOCK API V10
   Taiwan + US stocks
   Quote / History / Technical Analysis
   ========================================================= */

const cache = new Map();
const CACHE_TIME = 15000;

const TW_STOCKS = {
  "2330": "台積電",
  "2317": "鴻海",
  "2454": "聯發科",
  "2303": "聯電",
  "2382": "廣達",
  "3711": "日月光投控",
  "2412": "中華電",
  "2881": "富邦金",
  "2882": "國泰金",
  "2891": "中信金",
  "1303": "南亞",
  "1301": "台塑",
  "2002": "中鋼",
  "2603": "長榮",
  "2618": "長榮航",
  "3037": "欣興",
  "3231": "緯創",
  "2357": "華碩",
  "6669": "緯穎",
  "3017": "奇鋐"
};

const US_STOCKS = {
  NVDA: "NVIDIA",
  AAPL: "Apple",
  MSFT: "Microsoft",
  AMZN: "Amazon",
  GOOGL: "Alphabet",
  META: "Meta",
  TSLA: "Tesla",
  AVGO: "Broadcom",
  AMD: "AMD",
  NFLX: "Netflix"
};

/* =========================================================
   基本工具
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.time > CACHE_TIME) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cacheSet(key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });
}

/* =========================================================
   Yahoo Finance
   ========================================================= */

async function yahooChart(symbol, range = "6mo", interval = "1d") {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    `?range=${range}&interval=${interval}&events=history`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Yahoo HTTP ${r.status}`);
  }

  const json = await r.json();

  if (
    !json ||
    !json.chart ||
    !json.chart.result ||
    !json.chart.result[0]
  ) {
    throw new Error("Yahoo no data");
  }

  return json.chart.result[0];
}

/* =========================================================
   Taiwan TWSE
   ========================================================= */

async function twseQuote(symbol) {
  const url =
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp" +
    `?ex_ch=tse_${encodeURIComponent(symbol)}.tw` +
    "&json=1";

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`TWSE HTTP ${r.status}`);
  }

  const json = await r.json();

  if (!json.msgArray || !json.msgArray.length) {
    throw new Error("TWSE no data");
  }

  const q = json.msgArray[0];

  const price =
    num(q.z) ??
    num(q.pz) ??
    num(q.y);

  const previous =
    num(q.y) ??
    num(q.pz);

  let change = null;
  let changePct = null;

  if (price !== null && previous !== null && previous !== 0) {
    change = price - previous;
    changePct = (change / previous) * 100;
  }

  return {
    symbol,
    name: q.n || TW_STOCKS[symbol] || symbol,
    market: "TW",
    price,
    previousClose: previous,
    change,
    changePct,
    volume: num(q.v),
    source: "TWSE"
  };
}

/* =========================================================
   US / Yahoo Quote
   ========================================================= */

async function usQuote(symbol) {
  const data = await yahooChart(symbol, "5d", "1d");

  const meta = data.meta || {};

  const price =
    num(meta.regularMarketPrice) ??
    num(meta.previousClose);

  const previous =
    num(meta.previousClose);

  let change = null;
  let changePct = null;

  if (price !== null && previous !== null && previous !== 0) {
    change = price - previous;
    changePct = (change / previous) * 100;
  }

  let volume = null;

  try {
    const volumes = data.indicators.quote[0].volume || [];
    volume = volumes[volumes.length - 1] || null;
  } catch {}

  return {
    symbol,
    name: US_STOCKS[symbol] || meta.longName || symbol,
    market: "US",
    price,
    previousClose: previous,
    change,
    changePct,
    volume,
    source: "Yahoo Finance"
  };
}

/* =========================================================
   通用 Quote
   ========================================================= */

async function getQuote(symbol) {
  symbol = String(symbol || "")
    .trim()
    .toUpperCase();

  if (!symbol) {
    throw new Error("Missing symbol");
  }

  const cached = cacheGet("quote:" + symbol);

  if (cached) {
    return cached;
  }

  let result;

  if (/^\d{4,6}$/.test(symbol)) {
    result = await twseQuote(symbol);
  } else {
    result = await usQuote(symbol);
  }

  cacheSet("quote:" + symbol, result);

  return result;
}

/* =========================================================
   History
   ========================================================= */

async function getHistory(symbol) {
  symbol = String(symbol || "")
    .trim()
    .toUpperCase();

  const key = "history:" + symbol;

  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  let yahooSymbol = symbol;

  /*
    台股：
    2330 -> 2330.TW
  */
  if (/^\d{4,6}$/.test(symbol)) {
    yahooSymbol = symbol + ".TW";
  }

  const data = await yahooChart(
    yahooSymbol,
    "1y",
    "1d"
  );

  const timestamps = data.timestamp || [];

  const quote =
    data.indicators &&
    data.indicators.quote &&
    data.indicators.quote[0];

  if (!quote) {
    throw new Error("History data unavailable");
  }

  const result = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = num(quote.close?.[i]);

    if (close === null) continue;

    result.push({
      date: new Date(timestamps[i] * 1000)
        .toISOString()
        .slice(0, 10),

      open: num(quote.open?.[i]),
      high: num(quote.high?.[i]),
      low: num(quote.low?.[i]),
      close,
      volume: num(quote.volume?.[i])
    });
  }

  cacheSet(key, result);

  return result;
}

/* =========================================================
   技術指標
   ========================================================= */

function sma(values, period) {
  if (values.length < period) return null;

  return avg(values.slice(-period));
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);

  let ema =
    avg(values.slice(0, period));

  const result = [ema];

  for (let i = period; i < values.length; i++) {
    ema =
      values[i] * k +
      ema * (1 - k);

    result.push(ema);
  }

  return result;
}

function ema(values, period) {
  const series = emaSeries(values, period);

  if (!series.length) return null;

  return series[series.length - 1];
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

function bollinger(values, period = 20) {
  if (values.length < period) {
    return {
      middle: null,
      upper: null,
      lower: null
    };
  }

  const arr = values.slice(-period);
  const middle = avg(arr);

  const variance =
    avg(
      arr.map(v =>
        Math.pow(v - middle, 2)
      )
    );

  const sd = Math.sqrt(variance);

  return {
    middle,
    upper: middle + 2 * sd,
    lower: middle - 2 * sd
  };
}

function atr(history, period = 14) {
  if (history.length <= period) return null;

  const trs = [];

  for (let i = 1; i < history.length; i++) {
    const h = history[i].high;
    const l = history[i].low;
    const pc = history[i - 1].close;

    if (
      h === null ||
      l === null ||
      pc === null
    ) {
      continue;
    }

    const tr = Math.max(
      h - l,
      Math.abs(h - pc),
      Math.abs(l - pc)
    );

    trs.push(tr);
  }

  return sma(trs, period);
}

function macd(values) {
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);

  if (
    e12 === null ||
    e26 === null
  ) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const e12Series = emaSeries(values, 12);
  const e26Series = emaSeries(values, 26);

  const offset =
    e12Series.length -
    e26Series.length;

  const macdSeries = [];

  for (
    let i = 0;
    i < e26Series.length;
    i++
  ) {
    const a =
      e12Series[i + offset];

    const b =
      e26Series[i];

    macdSeries.push(a - b);
  }

  const signalSeries =
    emaSeries(macdSeries, 9);

  const signal =
    signalSeries.length
      ? signalSeries[signalSeries.length - 1]
      : null;

  const macdValue =
    macdSeries[macdSeries.length - 1];

  return {
    macd: macdValue,
    signal,
    histogram:
      signal === null
        ? null
        : macdValue - signal
  };
}

/* =========================================================
   Support / Resistance
   ========================================================= */

function supportResistance(history) {
  const closes = history
    .map(x => x.close)
    .filter(Number.isFinite);

  if (!closes.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    closes.slice(-60);

  return {
    support: Math.min(...recent),
    resistance: Math.max(...recent)
  };
}

/* =========================================================
   VWAP
   ========================================================= */

function calculateVWAP(history) {
  let totalPV = 0;
  let totalVolume = 0;

  for (const d of history.slice(-60)) {
    if (
      !Number.isFinite(d.high) ||
      !Number.isFinite(d.low) ||
      !Number.isFinite(d.close) ||
      !Number.isFinite(d.volume)
    ) {
      continue;
    }

    const typical =
      (d.high + d.low + d.close) / 3;

    totalPV += typical * d.volume;
    totalVolume += d.volume;
  }

  if (!totalVolume) return null;

  return totalPV / totalVolume;
}

/* =========================================================
   Technical Analysis
   ========================================================= */

function technicalAnalysis(history) {
  const closes = history
    .map(x => x.close)
    .filter(Number.isFinite);

  const current =
    closes.length
      ? closes[closes.length - 1]
      : null;

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const RSI = rsi(closes, 14);

  const MACD = macd(closes);

  const BB =
    bollinger(closes, 20);

  const ATR =
    atr(history, 14);

  const VWAP =
    calculateVWAP(history);

  const SR =
    supportResistance(history);

  let trend = "資料不足";

  if (
    current !== null &&
    ma20 !== null &&
    ma60 !== null
  ) {
    if (
      current > ma20 &&
      ma20 > ma60
    ) {
      trend = "偏多";
    } else if (
      current < ma20 &&
      ma20 < ma60
    ) {
      trend = "偏空";
    } else {
      trend = "震盪";
    }
  }

  let momentum = "資料不足";

  if (RSI !== null) {
    if (RSI >= 70) {
      momentum = "過熱";
    } else if (RSI <= 30) {
      momentum = "超賣";
    } else if (RSI >= 50) {
      momentum = "偏強";
    } else {
      momentum = "偏弱";
    }
  }

  /*
    Informational composite only.
    不代表投資建議。
  */

  let score = null;

  if (
    current !== null &&
    ma5 !== null &&
    ma20 !== null &&
    ma60 !== null &&
    RSI !== null
  ) {
    score = 50;

    if (current > ma20) score += 10;
    if (current > ma60) score += 10;
    if (ma5 > ma20) score += 10;

    if (RSI > 50) score += 5;
    if (RSI < 30) score += 5;

    if (
      MACD.macd !== null &&
      MACD.signal !== null &&
      MACD.macd > MACD.signal
    ) {
      score += 10;
    }

    score =
      Math.max(
        0,
        Math.min(100, score)
      );
  }

  return {
    current,

    MA5: ma5,
    MA20: ma20,
    MA60: ma60,

    EMA12: ema12,
    EMA26: ema26,

    RSI,

    MACD,

    Bollinger: BB,

    ATR,

    VWAP,

    Support: SR.support,
    Resistance: SR.resistance,

    trend,
    momentum,

    score,

    dataPoints: history.length
  };
}

/* =========================================================
   API：Quotes
   ========================================================= */

app.get("/api/quotes", async (req, res) => {
  const symbols = [
    "2330",
    "2317",
    "2454",
    "NVDA",
    "AAPL",
    "MSFT"
  ];

  const results = [];

  for (const symbol of symbols) {
    try {
      const q = await getQuote(symbol);

      results.push(q);
    } catch (err) {
      console.error(
        "Quote error:",
        symbol,
        err.message
      );

      /*
        即使某一檔失敗，
        其他股票還是繼續。
      */
    }

    /*
      避免來源 API 瞬間被打太快
    */
    await sleep(150);
  }

  res.json(results);
});

/* =========================================================
   API：單一股票
   ========================================================= */

app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const symbol =
      req.params.symbol
        .trim()
        .toUpperCase();

    const quote =
      await getQuote(symbol);

    res.json(quote);
  } catch (err) {
    console.error(
      "/api/quote error:",
      err.message
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   API：歷史
   ========================================================= */

app.get("/api/history/:symbol", async (req, res) => {
  try {
    const history =
      await getHistory(
        req.params.symbol
      );

    res.json({
      symbol:
        req.params.symbol
          .toUpperCase(),
      count: history.length,
      data: history
    });
  } catch (err) {
    console.error(
      "/api/history error:",
      err.message
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   API：分析
   ========================================================= */

app.get("/api/analysis/:symbol", async (req, res) => {
  try {
    const symbol =
      req.params.symbol
        .trim()
        .toUpperCase();

    const history =
      await getHistory(symbol);

    const quote =
      await getQuote(symbol);

    const analysis =
      technicalAnalysis(history);

    res.json({
      symbol,
      quote,
      analysis,
      disclaimer:
        "IAN AI Score 為資訊整理與技術指標計算，不構成投資建議。"
    });
  } catch (err) {
    console.error(
      "/api/analysis error:",
      err.message
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   API：Stock 完整資料
   ========================================================= */

app.get("/api/stock/:symbol", async (req, res) => {
  try {
    const symbol =
      req.params.symbol
        .trim()
        .toUpperCase();

    const quote =
      await getQuote(symbol);

    const history =
      await getHistory(symbol);

    const analysis =
      technicalAnalysis(history);

    res.json({
      symbol,
      quote,
      history,
      analysis
    });
  } catch (err) {
    console.error(
      "/api/stock error:",
      err.message
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================================================
   API：搜尋
   ========================================================= */

app.get("/api/search", async (req, res) => {
  const q =
    String(req.query.q || "")
      .trim()
      .toLowerCase();

  if (!q) {
    return res.json([]);
  }

  const result = [];

  for (const [symbol, name] of Object.entries(TW_STOCKS)) {
    if (
      symbol.toLowerCase().includes(q) ||
      name.toLowerCase().includes(q)
    ) {
      result.push({
        symbol,
        name,
        market: "TW"
      });
    }
  }

  for (const [symbol, name] of Object.entries(US_STOCKS)) {
    if (
      symbol.toLowerCase().includes(q) ||
      name.toLowerCase().includes(q)
    ) {
      result.push({
        symbol,
        name,
        market: "US"
      });
    }
  }

  res.json(result);
});

/* =========================================================
   API：市場
   ========================================================= */

app.get("/api/market", async (req, res) => {
  const symbols = [
    "2330",
    "2317",
    "2454",
    "NVDA",
    "AAPL",
    "MSFT"
  ];

  const data = [];

  for (const symbol of symbols) {
    try {
      data.push(
        await getQuote(symbol)
      );
    } catch {}
  }

  res.json({
    updatedAt:
      new Date().toISOString(),
    data
  });
});

/* =========================================================
   API：Cache
   ========================================================= */

app.get("/api/cache", (req, res) => {
  res.json({
    entries: cache.size
  });
});

/* =========================================================
   API：Status
   ========================================================= */

app.get("/api/status", (req, res) => {
  res.json({
    server: "IAN STOCK API",
    version: "10.0.0",
    status: "ONLINE",

    yahooFinance:
      "AVAILABLE",

    twse:
      "AVAILABLE",

    alphaVantageConfigured:
      Boolean(process.env.ALPHA_VANTAGE_KEY),

    cacheEntries:
      cache.size,

    indicators: [
      "MA5",
      "MA20",
      "MA60",
      "EMA12",
      "EMA26",
      "RSI",
      "MACD",
      "Bollinger Bands",
      "ATR",
      "VWAP",
      "Volume",
      "Support",
      "Resistance"
    ],

    endpoints: [
      "/api/quotes",
      "/api/quote/:symbol",
      "/api/history/:symbol",
      "/api/analysis/:symbol",
      "/api/stock/:symbol",
      "/api/search",
      "/api/market",
      "/api/cache",
      "/api/status"
    ],

    note:
      "API keys are never returned."
  });
});

/* =========================================================
   Error Handler
   ========================================================= */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal Server Error"
  });
});

/* =========================================================
   Start
   ========================================================= */

app.listen(PORT, () => {
  console.log(
    `IAN STOCK API V10 running on port ${PORT}`
  );
});
