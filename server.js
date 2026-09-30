const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SERVER_NAME = "IAN STOCK API";
const VERSION = "4.0.0";

// ================================
// CACHE
// ================================

const CACHE_TIME = 5 * 60 * 1000;
const quoteCache = {};
const historyCache = {};
const analysisCache = {};

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isTW(symbol) {
  return /^\d{4,6}$/.test(cleanSymbol(symbol));
}

function yahooSymbol(symbol) {
  const s = cleanSymbol(symbol);

  if (s.includes(".")) return s;

  if (/^\d{4,6}$/.test(s)) {
    return s + ".TW";
  }

  return s;
}

function cacheValid(item) {
  if (!item) return false;
  return Date.now() - item.time < CACHE_TIME;
}

function getQuoteCache(symbol) {
  const item = quoteCache[symbol];
  if (!cacheValid(item)) return null;

  return {
    ...item.data,
    cached: true,
    cacheAgeSeconds: Math.floor((Date.now() - item.time) / 1000)
  };
}

function saveQuoteCache(symbol, data) {
  quoteCache[symbol] = {
    time: Date.now(),
    data
  };
}

function getHistoryCache(symbol, range) {
  const key = symbol + ":" + range;
  const item = historyCache[key];

  if (!cacheValid(item)) return null;

  return {
    ...item.data,
    cached: true,
    cacheAgeSeconds: Math.floor((Date.now() - item.time) / 1000)
  };
}

function saveHistoryCache(symbol, range, data) {
  const key = symbol + ":" + range;

  historyCache[key] = {
    time: Date.now(),
    data
  };
}

// ================================
// HTTP JSON
// ================================

async function getJSON(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "IAN-STOCK/4.0"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return await response.json();
}

// ================================
// YAHOO FINANCE QUOTE
// ================================

async function fetchYahooQuote(symbol) {
  const clean = cleanSymbol(symbol);

  if (!clean) {
    return {
      ok: false,
      error: "Stock symbol is required"
    };
  }

  const cached = getQuoteCache(clean);

  if (cached) {
    return cached;
  }

  const ySymbol = yahooSymbol(clean);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=5d&interval=1d&events=history";

  try {
    const data = await getJSON(url);

    const result =
      data &&
      data.chart &&
      data.chart.result &&
      data.chart.result[0];

    if (!result) {
      return {
        ok: false,
        symbol: clean,
        error: "Yahoo Finance returned no data"
      };
    }

    const meta = result.meta || {};

    const price =
      Number(
        meta.regularMarketPrice ??
        meta.previousClose ??
        0
      );

    const previousClose =
      Number(
        meta.previousClose ??
        meta.chartPreviousClose ??
        0
      );

    const change =
      price && previousClose
        ? price - previousClose
        : 0;

    const changePct =
      previousClose
        ? (change / previousClose) * 100
        : 0;

    const quote = {
      ok: true,
      symbol: clean,
      yahooSymbol: ySymbol,
      market: isTW(clean) ? "TW" : "US",
      price,
      previousClose,
      change,
      changePct,
      currency: meta.currency || (isTW(clean) ? "TWD" : "USD"),
      exchange: meta.exchangeName || null,
      exchangeTimezone: meta.exchangeTimezoneName || null,
      marketState: meta.marketState || null,
      latestTradingDay:
        meta.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000)
              .toISOString()
              .slice(0, 10)
          : null
    };

    saveQuoteCache(clean, quote);

    return {
      ...quote,
      cached: false
    };
  } catch (error) {
    return {
      ok: false,
      symbol: clean,
      error: "Yahoo Finance request failed: " + error.message
    };
  }
}

// ================================
// HISTORY
// ================================

function rangeToPeriod(range) {
  switch (range) {
    case "1M":
      return { range: "1mo", interval: "1d" };

    case "3M":
      return { range: "3mo", interval: "1d" };

    case "6M":
      return { range: "6mo", interval: "1d" };

    case "1Y":
      return { range: "1y", interval: "1d" };

    case "2Y":
      return { range: "2y", interval: "1d" };

    case "5Y":
      return { range: "5y", interval: "1wk" };

    default:
      return { range: "1y", interval: "1d" };
  }
}

async function fetchYahooHistory(symbol, selectedRange = "1Y") {
  const clean = cleanSymbol(symbol);
  const range = String(selectedRange || "1Y").toUpperCase();

  const cached = getHistoryCache(clean, range);

  if (cached) {
    return cached;
  }

  const config = rangeToPeriod(range);
  const ySymbol = yahooSymbol(clean);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=" +
    encodeURIComponent(config.range) +
    "&interval=" +
    encodeURIComponent(config.interval) +
    "&events=history";

  try {
    const data = await getJSON(url);

    const result =
      data &&
      data.chart &&
      data.chart.result &&
      data.chart.result[0];

    if (!result) {
      return {
        ok: false,
        symbol: clean,
        error: "No historical data"
      };
    }

    const timestamps = result.timestamp || [];
    const q =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0];

    if (!q) {
      return {
        ok: false,
        symbol: clean,
        error: "Historical quote data unavailable"
      };
    }

    const rows = [];

    for (let i = 0; i < timestamps.length; i++) {
      const close = q.close ? q.close[i] : null;

      if (close == null) continue;

      rows.push({
        time: timestamps[i],
        date: new Date(timestamps[i] * 1000)
          .toISOString()
          .slice(0, 10),
        open: Number(q.open?.[i] ?? 0),
        high: Number(q.high?.[i] ?? 0),
        low: Number(q.low?.[i] ?? 0),
        close: Number(close),
        volume: Number(q.volume?.[i] ?? 0)
      });
    }

    const history = {
      ok: true,
      symbol: clean,
      yahooSymbol: ySymbol,
      market: isTW(clean) ? "TW" : "US",
      currency:
        result.meta?.currency ||
        (isTW(clean) ? "TWD" : "USD"),
      range,
      interval: config.interval,
      count: rows.length,
      data: rows
    };

    saveHistoryCache(clean, range, history);

    return {
      ...history,
      cached: false
    };
  } catch (error) {
    return {
      ok: false,
      symbol: clean,
      error: "History request failed: " + error.message
    };
  }
}

// ================================
// INDICATORS
// ================================

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return (
    slice.reduce((sum, value) => sum + value, 0) /
    period
  );
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier +
      result;
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);

  if (ema12 == null || ema26 == null) {
    return null;
  }

  return ema12 - ema26;
}

function calculateATR(rows, period = 14) {
  if (rows.length <= period) return null;

  const trs = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  return sma(trs, period);
}

function calculateVWAP(rows) {
  if (!rows.length) return null;

  let totalPV = 0;
  let totalVolume = 0;

  for (const row of rows) {
    const typical =
      (row.high + row.low + row.close) / 3;

    const volume = row.volume || 0;

    totalPV += typical * volume;
    totalVolume += volume;
  }

  if (!totalVolume) return null;

  return totalPV / totalVolume;
}

function calculateBollinger(values, period = 20) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  const mean =
    slice.reduce((a, b) => a + b, 0) /
    period;

  const variance =
    slice.reduce(
      (sum, value) =>
        sum + Math.pow(value - mean, 2),
      0
    ) / period;

  const std = Math.sqrt(variance);

  return {
    middle: mean,
    upper: mean + std * 2,
    lower: mean - std * 2
  };
}

// ================================
// SUPPORT / RESISTANCE
// ================================

function calculateSupportResistance(rows) {
  if (!rows.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent = rows.slice(-30);

  const lows = recent
    .map(x => x.low)
    .filter(x => Number.isFinite(x));

  const highs = recent
    .map(x => x.high)
    .filter(x => Number.isFinite(x));

  if (!lows.length || !highs.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs)
  };
}

// ================================
// FULL TECHNICAL ANALYSIS
// ================================

async function buildAnalysis(symbol, range = "1Y") {
  const clean = cleanSymbol(symbol);

  const cacheKey = clean + ":" + range;

  if (
    analysisCache[cacheKey] &&
    cacheValid(analysisCache[cacheKey])
  ) {
    return {
      ...analysisCache[cacheKey].data,
      cached: true
    };
  }

  const history = await fetchYahooHistory(clean, range);

  if (!history.ok) {
    return history;
  }

  const rows = history.data;

  if (rows.length < 30) {
    return {
      ok: false,
      symbol: clean,
      error: "Not enough historical data for analysis"
    };
  }

  const closes = rows.map(x => x.close);

  const current = closes[closes.length - 1];

  const MA5 = sma(closes, 5);
  const MA20 = sma(closes, 20);
  const MA60 = sma(closes, 60);

  const EMA12 = ema(closes, 12);
  const EMA26 = ema(closes, 26);

  const RSI = calculateRSI(closes, 14);
  const MACD = calculateMACD(closes);

  const ATR = calculateATR(rows, 14);

  const VWAP = calculateVWAP(
    rows.slice(-60)
  );

  const Bollinger =
    calculateBollinger(closes, 20);

  const SR =
    calculateSupportResistance(rows);

  const latestVolume =
    rows[rows.length - 1].volume || 0;

  const averageVolume20 =
    sma(
      rows
        .slice(-20)
        .map(x => x.volume || 0),
      Math.min(20, rows.length)
    );

  let trendScore = 50;
  let momentumScore = 50;

  const factors = [];
  const signals = [];
  const risks = [];

  // Trend

  if (
    MA20 != null &&
    MA60 != null &&
    current > MA20 &&
    current > MA60
  ) {
    trendScore += 20;

    factors.push(
      "價格位於 MA20 與 MA60 上方"
    );
  }

  if (
    MA20 != null &&
    MA60 != null &&
    MA20 > MA60
  ) {
    trendScore += 10;

    factors.push(
      "MA20 位於 MA60 上方"
    );
  }

  if (
    EMA12 != null &&
    EMA26 != null &&
    EMA12 > EMA26
  ) {
    momentumScore += 15;

    factors.push(
      "EMA12 高於 EMA26"
    );
  }

  // RSI

  if (RSI != null) {
    if (RSI >= 70) {
      momentumScore -= 10;

      risks.push(
        "RSI 進入偏高區域，需注意短線過熱"
      );
    } else if (RSI >= 50) {
      momentumScore += 10;

      factors.push(
        "RSI 位於 50 以上"
      );
    } else if (RSI < 30) {
      signals.push(
        "RSI 位於偏低區域"
      );
    }
  }

  // MACD

  if (MACD != null) {
    if (MACD > 0) {
      momentumScore += 10;

      factors.push(
        "MACD 位於零軸上方"
      );
    } else {
      momentumScore -= 10;

      risks.push(
        "MACD 位於零軸下方"
      );
    }
  }

  // Volume

  if (
    averageVolume20 &&
    latestVolume > averageVolume20 * 1.5
  ) {
    factors.push(
      "成交量高於近期平均量"
    );

    signals.push(
      "成交量出現明顯放大"
    );
  }

  // VWAP

  if (VWAP != null) {
    if (current > VWAP) {
      factors.push(
        "價格位於 VWAP 上方"
      );
    } else {
      risks.push(
        "價格位於 VWAP 下方"
      );
    }
  }

  // Bollinger

  if (Bollinger) {
    if (current > Bollinger.upper) {
      risks.push(
        "價格高於布林通道上緣"
      );
    }

    if (current < Bollinger.lower) {
      signals.push(
        "價格低於布林通道下緣"
      );
    }
  }

  trendScore = Math.max(
    0,
    Math.min(100, trendScore)
  );

  momentumScore = Math.max(
    0,
    Math.min(100, momentumScore)
  );

  const technicalScore = Math.round(
    trendScore * 0.55 +
    momentumScore * 0.45
  );

  let trendText = "中性";

  if (trendScore >= 70) {
    trendText = "偏多";
  } else if (trendScore <= 35) {
    trendText = "偏空";
  }

  let momentumText = "中性";

  if (momentumScore >= 70) {
    momentumText = "偏強";
  } else if (momentumScore <= 35) {
    momentumText = "偏弱";
  }

  const result = {
    ok: true,
    symbol: clean,
    market: isTW(clean) ? "TW" : "US",
    range,

    current,

    indicators: {
      MA5,
      MA20,
      MA60,
      EMA12,
      EMA26,
      RSI,
      MACD,
      ATR,
      VWAP,
      Bollinger,
      Volume: latestVolume,
      averageVolume20
    },

    supportResistance: SR,

    ai: {
      technicalScore,
      trend: trendText,
      momentum: momentumText,

      mainFactors:
        factors.length
          ? factors
          : ["目前沒有足夠的明確訊號"],

      watchSignals:
        signals.length
          ? signals
          : ["持續觀察價格與成交量變化"],

      risks:
        risks.length
          ? risks
          : ["目前沒有明顯技術面風險訊號"],

      disclaimer:
        "IAN AI 為技術資料整理與研究輔助，不構成投資建議。"
    },

    updatedAt: new Date().toISOString()
  };

  analysisCache[cacheKey] = {
    time: Date.now(),
    data: result
  };

  return {
    ...result,
    cached: false
  };
}

// ================================
// STOCK DATABASE
// ================================

const STOCKS = [
  // Taiwan
  {
    symbol: "2330",
    name: "台積電",
    market: "TW"
  },
  {
    symbol: "2317",
    name: "鴻海",
    market: "TW"
  },
  {
    symbol: "2454",
    name: "聯發科",
    market: "TW"
  },
  {
    symbol: "2303",
    name: "聯電",
    market: "TW"
  },
  {
    symbol: "2308",
    name: "台達電",
    market: "TW"
  },
  {
    symbol: "2382",
    name: "廣達",
    market: "TW"
  },
  {
    symbol: "2603",
    name: "長榮",
    market: "TW"
  },
  {
    symbol: "2615",
    name: "萬海",
    market: "TW"
  },
  {
    symbol: "2881",
    name: "富邦金",
    market: "TW"
  },
  {
    symbol: "2882",
    name: "國泰金",
    market: "TW"
  },
  {
    symbol: "3008",
    name: "大立光",
    market: "TW"
  },
  {
    symbol: "3711",
    name: "日月光投控",
    market: "TW"
  },
  {
    symbol: "6669",
    name: "緯穎",
    market: "TW"
  },

  // US
  {
    symbol: "NVDA",
    name: "NVIDIA",
    market: "US"
  },
  {
    symbol: "AAPL",
    name: "Apple",
    market: "US"
  },
  {
    symbol: "MSFT",
    name: "Microsoft",
    market: "US"
  },
  {
    symbol: "AMZN",
    name: "Amazon",
    market: "US"
  },
  {
    symbol: "GOOGL",
    name: "Alphabet",
    market: "US"
  },
  {
    symbol: "META",
    name: "Meta",
    market: "US"
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    market: "US"
  },
  {
    symbol: "AMD",
    name: "AMD",
    market: "US"
  },
  {
    symbol: "AVGO",
    name: "Broadcom",
    market: "US"
  },
  {
    symbol: "TSM",
    name: "Taiwan Semiconductor",
    market: "US"
  },
  {
    symbol: "NFLX",
    name: "Netflix",
    market: "US"
  },
  {
    symbol: "ORCL",
    name: "Oracle",
    market: "US"
  },
  {
    symbol: "COST",
    name: "Costco",
    market: "US"
  },
  {
    symbol: "PLTR",
    name: "Palantir",
    market: "US"
  }
];

// ================================
// DEFAULT SYMBOLS
// ================================

const DEFAULT_SYMBOLS = [
  "2330",
  "2317",
  "2454",
  "NVDA",
  "AAPL",
  "MSFT",
  "TSLA"
];

// ================================
// API: QUOTES
// ================================

app.get("/api/quotes", async (req, res) => {
  let symbols = DEFAULT_SYMBOLS;

  if (req.query.symbols) {
    symbols = String(req.query.symbols)
      .split(",")
      .map(cleanSymbol)
      .filter(Boolean)
      .slice(0, 20);
  }

  const results = [];

  for (const symbol of symbols) {
    const quote = await fetchYahooQuote(symbol);

    if (quote.ok) {
      results.push(quote);
    }
  }

  res.json({
    ok: true,
    count: results.length,
    results
  });
});

// ================================
// API: SINGLE QUOTE
// ================================

app.get("/api/quote/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);

  const quote = await fetchYahooQuote(symbol);

  if (!quote.ok) {
    return res.status(502).json(quote);
  }

  res.json(quote);
});

// ================================
// API: HISTORY
// ================================

app.get("/api/history/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  const range = String(req.query.range || "1Y");

  const history = await fetchYahooHistory(
    symbol,
    range
  );

  if (!history.ok) {
    return res.status(502).json(history);
  }

  res.json(history);
});

// ================================
// API: ANALYSIS
// ================================

app.get("/api/analysis/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  const range = String(req.query.range || "1Y");

  const analysis = await buildAnalysis(
    symbol,
    range
  );

  if (!analysis.ok) {
    return res.status(502).json(analysis);
  }

  res.json(analysis);
});

// ================================
// API: STOCK
// ================================

app.get("/api/stock/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  const range = String(req.query.range || "1Y");

  const [quote, analysis] =
    await Promise.all([
      fetchYahooQuote(symbol),
      buildAnalysis(symbol, range)
    ]);

  res.json({
    ok: quote.ok || analysis.ok,
    quote,
    analysis
  });
});

// ================================
// API: SEARCH
// ================================

app.get("/api/search", async (req, res) => {
  const keyword = String(
    req.query.q || ""
  )
    .trim()
    .toUpperCase();

  let results = STOCKS;

  if (keyword) {
    results = STOCKS.filter(stock =>
      stock.symbol
        .toUpperCase()
        .includes(keyword) ||
      stock.name
        .toUpperCase()
        .includes(keyword)
    );
  }

  res.json({
    ok: true,
    count: results.length,
    results
  });
});

// ================================
// API: MARKET
// ================================

async function marketQuote(symbol, name) {
  const quote = await fetchYahooQuote(symbol);

  if (!quote.ok) {
    return {
      ok: false,
      symbol,
      name,
      error: quote.error
    };
  }

  return {
    ok: true,
    symbol,
    name,
    price: quote.price,
    change: quote.change,
    changePct: quote.changePct,
    currency: quote.currency,
    latestTradingDay: quote.latestTradingDay
  };
}

app.get("/api/market", async (req, res) => {
  const results = await Promise.all([
    marketQuote(
      "^TWII",
      "台灣加權指數"
    ),
    marketQuote(
      "^IXIC",
      "NASDAQ"
    ),
    marketQuote(
      "^GSPC",
      "S&P 500"
    ),
    marketQuote(
      "TWD=X",
      "USD/TWD"
    )
  ]);

  res.json({
    ok: true,
    data: {
      taiwan: results[0],
      nasdaq: results[1],
      sp500: results[2],
      usdTwd: results[3]
    },
    updatedAt: new Date().toISOString()
  });
});

// ================================
// API: CACHE
// ================================

app.get("/api/cache", (req, res) => {
  const quotes = {};
  const histories = {};

  Object.keys(quoteCache).forEach(symbol => {
    const item = quoteCache[symbol];

    quotes[symbol] = {
      valid: cacheValid(item),
      ageSeconds: Math.floor(
        (Date.now() - item.time) / 1000
      )
    };
  });

  Object.keys(historyCache).forEach(key => {
    const item = historyCache[key];

    histories[key] = {
      valid: cacheValid(item),
      ageSeconds: Math.floor(
        (Date.now() - item.time) / 1000
      )
    };
  });

  res.json({
    ok: true,
    cacheTimeMinutes: CACHE_TIME / 60000,
    quotes,
    histories,
    analysisEntries:
      Object.keys(analysisCache).length
  });
});

// ================================
// API: STATUS
// ================================

app.get("/api/status", async (req, res) => {
  let yahooStatus = "ERROR";
  let yahooDetail = null;

  try {
    const test = await fetchYahooQuote("NVDA");

    if (test.ok) {
      yahooStatus = "OK";
      yahooDetail = "Yahoo Finance quote data is available.";
    } else {
      yahooDetail = test.error;
    }
  } catch (error) {
    yahooDetail = error.message;
  }

  res.json({
    server: SERVER_NAME,
    version: VERSION,
    status: "ONLINE",

    yahooFinance: yahooStatus,

    yahooFinanceDetail:
      yahooDetail,

    alphaVantageConfigured:
      Boolean(
        process.env.ALPHA_VANTAGE_KEY
      ),

    cacheEntries: {
      quotes:
        Object.keys(quoteCache).length,

      history:
        Object.keys(historyCache).length,

      analysis:
        Object.keys(analysisCache).length
    },

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

// ================================
// ROOT
// ================================

app.get("/", (req, res) => {
  res.json({
    service: SERVER_NAME,
    version: VERSION,
    status: "ONLINE",
    message:
      "IAN STOCK API is running."
  });
});

// ================================
// 404
// ================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "API route not found",
    path: req.originalUrl
  });
});

// ================================
// ERROR HANDLER
// ================================

app.use((error, req, res, next) => {
  console.error(
    "IAN STOCK ERROR:",
    error
  );

  res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

// ================================
// START
// ================================

app.listen(PORT, () => {
  console.log(
    `${SERVER_NAME} v${VERSION} running on port ${PORT}`
  );
});
