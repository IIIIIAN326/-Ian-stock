const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "";

const CACHE_TIME = 10 * 60 * 1000;
const HISTORY_CACHE_TIME = 30 * 60 * 1000;

const quoteCache = new Map();
const historyCache = new Map();
const searchCache = new Map();

/* =========================
   基本工具
========================= */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isTaiwanSymbol(symbol) {
  return /^\d{4,6}$/.test(symbol);
}

function yahooSymbol(symbol) {
  if (isTaiwanSymbol(symbol)) return `${symbol}.TW`;
  return symbol;
}

function stooqSymbol(symbol) {
  symbol = cleanSymbol(symbol);

  if (isTaiwanSymbol(symbol)) {
    return `${symbol.toLowerCase()}.tw`;
  }

  if (symbol.includes(".")) {
    return symbol.toLowerCase();
  }

  return `${symbol.toLowerCase()}.us`;
}

function now() {
  return new Date().toISOString();
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, timeout = 10000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "IAN-STOCK/1.0"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url, timeout = 10000) {
  const text = await fetchText(url, timeout);
  return JSON.parse(text);
}

/* =========================
   Yahoo Finance
========================= */

async function yahooQuote(symbol) {
  const ySymbol = yahooSymbol(symbol);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=5d&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=5d&interval=1d`
  ];

  for (const url of urls) {
    try {
      const data = await fetchJSON(url);

      const result =
        data &&
        data.chart &&
        data.chart.result &&
        data.chart.result[0];

      if (!result) continue;

      const meta = result.meta || {};

      const price =
        safeNumber(meta.regularMarketPrice) ??
        safeNumber(meta.chartPreviousClose);

      const previous =
        safeNumber(meta.previousClose) ??
        safeNumber(meta.chartPreviousClose);

      if (price === null) continue;

      const change =
        previous !== null ? price - previous : null;

      const changePercent =
        previous !== null && previous !== 0
          ? (change / previous) * 100
          : null;

      return {
        symbol,
        name: meta.longName || meta.shortName || symbol,
        price: round(price),
        previousClose: round(previous),
        change: round(change),
        changePercent: round(changePercent),
        currency: meta.currency || (isTaiwanSymbol(symbol) ? "TWD" : "USD"),
        market: isTaiwanSymbol(symbol) ? "TW" : "US",
        source: "Yahoo Finance",
        timestamp: now()
      };
    } catch (error) {
      // 下一個來源
    }
  }

  return null;
}

/* =========================
   Stooq 備援
========================= */

function parseStooqCSV(csv) {
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",");

  return lines.slice(1).map(line => {
    const parts = line.split(",");

    const row = {};

    headers.forEach((header, index) => {
      row[header] = parts[index];
    });

    return row;
  });
}

async function stooqHistory(symbol, days = 365) {
  const sSymbol = stooqSymbol(symbol);

  const end = new Date();
  const start = new Date();

  start.setDate(start.getDate() - days);

  const d1 = start.toISOString().slice(0, 10).replace(/-/g, "");
  const d2 = end.toISOString().slice(0, 10).replace(/-/g, "");

  const url =
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(sSymbol)}` +
    `&d1=${d1}&d2=${d2}&i=d`;

  try {
    const csv = await fetchText(url, 12000);
    const rows = parseStooqCSV(csv);

    return rows
      .map(row => ({
        date: row.Date,
        open: safeNumber(row.Open),
        high: safeNumber(row.High),
        low: safeNumber(row.Low),
        close: safeNumber(row.Close),
        volume: safeNumber(row.Volume)
      }))
      .filter(row => row.close !== null);
  } catch (error) {
    return [];
  }
}

async function stooqQuote(symbol) {
  const rows = await stooqHistory(symbol, 10);

  if (!rows.length) {
    return null;
  }

  const latest = rows[rows.length - 1];
  const previous = rows.length >= 2 ? rows[rows.length - 2] : null;

  const previousClose = previous ? previous.close : null;

  const change =
    previousClose !== null
      ? latest.close - previousClose
      : null;

  const changePercent =
    previousClose !== null && previousClose !== 0
      ? (change / previousClose) * 100
      : null;

  return {
    symbol,
    name: symbol,
    price: round(latest.close),
    previousClose: round(previousClose),
    change: round(change),
    changePercent: round(changePercent),
    open: round(latest.open),
    high: round(latest.high),
    low: round(latest.low),
    volume: latest.volume,
    currency: isTaiwanSymbol(symbol) ? "TWD" : "USD",
    market: isTaiwanSymbol(symbol) ? "TW" : "US",
    source: "Stooq",
    dataType: "daily",
    date: latest.date,
    timestamp: now()
  };
}

/* =========================
   Alpha Vantage
========================= */

async function alphaQuote(symbol) {
  if (!ALPHA_VANTAGE_KEY) {
    return null;
  }

  try {
    const url =
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${encodeURIComponent(ALPHA_VANTAGE_KEY)}`;

    const data = await fetchJSON(url, 12000);

    const quote = data["Global Quote"];

    if (!quote || !quote["05. price"]) {
      return null;
    }

    const price = safeNumber(quote["05. price"]);
    const previousClose = safeNumber(quote["08. previous close"]);

    if (price === null) {
      return null;
    }

    const change =
      previousClose !== null
        ? price - previousClose
        : null;

    const changePercent =
      previousClose !== null && previousClose !== 0
        ? (change / previousClose) * 100
        : null;

    return {
      symbol,
      name: symbol,
      price: round(price),
      previousClose: round(previousClose),
      change: round(change),
      changePercent: round(changePercent),
      volume: safeNumber(quote["06. volume"]),
      currency: isTaiwanSymbol(symbol) ? "TWD" : "USD",
      market: isTaiwanSymbol(symbol) ? "TW" : "US",
      source: "Alpha Vantage",
      timestamp: now()
    };
  } catch (error) {
    return null;
  }
}

/* =========================
   統一報價
========================= */

async function getQuote(symbol) {
  symbol = cleanSymbol(symbol);

  if (!symbol) return null;

  const cached = quoteCache.get(symbol);

  if (
    cached &&
    Date.now() - cached.time < CACHE_TIME
  ) {
    return cached.data;
  }

  // 先使用 Yahoo
  let quote = await yahooQuote(symbol);

  // Yahoo 失敗 → Stooq
  if (!quote) {
    quote = await stooqQuote(symbol);
  }

  // 最後才使用 Alpha Vantage
  if (!quote) {
    quote = await alphaQuote(symbol);
  }

  if (quote) {
    quoteCache.set(symbol, {
      time: Date.now(),
      data: quote
    });
  }

  return quote;
}

/* =========================
   技術指標
========================= */

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (!values.length) return [];

  const multiplier = 2 / (period + 1);

  const result = [];

  let ema = values[0];

  result.push(ema);

  for (let i = 1; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;

    result.push(ema);
  }

  return result;
}

function ema(values, period) {
  if (values.length < period) return null;

  const result = emaSeries(values, period);

  return result[result.length - 1];
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function bollinger(values, period = 20, multiplier = 2) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  const middle =
    slice.reduce((a, b) => a + b, 0) / period;

  const variance =
    slice.reduce(
      (sum, value) =>
        sum + Math.pow(value - middle, 2),
      0
    ) / period;

  const standardDeviation = Math.sqrt(variance);

  return {
    middle,
    upper: middle + multiplier * standardDeviation,
    lower: middle - multiplier * standardDeviation
  };
}

function atr(rows, period = 14) {
  if (rows.length < period + 1) return null;

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

function vwap(rows) {
  let totalVolume = 0;
  let totalValue = 0;

  for (const row of rows) {
    const volume = row.volume || 0;

    const typicalPrice =
      (row.high + row.low + row.close) / 3;

    totalVolume += volume;
    totalValue += typicalPrice * volume;
  }

  if (!totalVolume) return null;

  return totalValue / totalVolume;
}

function macd(values) {
  if (values.length < 26) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);

  const macdSeries = [];

  for (let i = 0; i < values.length; i++) {
    if (i < 25) {
      macdSeries.push(null);
    } else {
      macdSeries.push(
        ema12[i] - ema26[i]
      );
    }
  }

  const clean = macdSeries.filter(
    value => value !== null
  );

  const signalSeries = emaSeries(clean, 9);

  const macdValue =
    clean[clean.length - 1];

  const signal =
    signalSeries[signalSeries.length - 1];

  return {
    macd: macdValue,
    signal,
    histogram:
      macdValue !== null && signal !== null
        ? macdValue - signal
        : null
  };
}

function supportResistance(values) {
  if (!values.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent = values.slice(-60);

  return {
    support: Math.min(...recent),
    resistance: Math.max(...recent)
  };
}

/* =========================
   歷史資料
========================= */

async function getHistory(symbol, days = 365) {
  symbol = cleanSymbol(symbol);

  const cacheKey = `${symbol}_${days}`;

  const cached = historyCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < HISTORY_CACHE_TIME
  ) {
    return cached.data;
  }

  // Stooq 歷史資料
  let rows = await stooqHistory(symbol, days);

  // Stooq 失敗 → Yahoo
  if (!rows.length) {
    try {
      const ySymbol = yahooSymbol(symbol);

      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/` +
        `${encodeURIComponent(ySymbol)}?range=1y&interval=1d`;

      const data = await fetchJSON(url, 12000);

      const result =
        data &&
        data.chart &&
        data.chart.result &&
        data.chart.result[0];

      if (result) {
        const timestamps = result.timestamp || [];
        const quote =
          result.indicators &&
          result.indicators.quote &&
          result.indicators.quote[0];

        if (quote) {
          rows = timestamps.map((timestamp, index) => ({
            date: new Date(timestamp * 1000)
              .toISOString()
              .slice(0, 10),
            open: safeNumber(quote.open[index]),
            high: safeNumber(quote.high[index]),
            low: safeNumber(quote.low[index]),
            close: safeNumber(quote.close[index]),
            volume: safeNumber(quote.volume[index])
          })).filter(row => row.close !== null);
        }
      }
    } catch (error) {
      // 無資料
    }
  }

  historyCache.set(cacheKey, {
    time: Date.now(),
    data: rows
  });

  return rows;
}

/* =========================
   AI 分析
========================= */

function buildAnalysis(symbol, rows, quote) {
  if (!rows.length) {
    return {
      symbol,
      status: "NO_DATA",
      score: null,
      trend: "待資料",
      momentum: "待資料",
      fundamental: "待資料",
      sentiment: "待資料",
      valuation: "待資料",
      risk: "資料不足",
      reasons: [],
      risks: [],
      catalysts: []
    };
  }

  const closes = rows
    .map(row => row.close)
    .filter(v => v !== null);

  const current =
    quote && quote.price !== null
      ? quote.price
      : closes[closes.length - 1];

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const rsiValue = rsi(closes, 14);

  const macdValue = macd(closes);

  const bb = bollinger(closes);

  const supportResistanceValue =
    supportResistance(closes);

  let score = 50;

  const reasons = [];
  const risks = [];
  const catalysts = [];

  if (
    ma5 !== null &&
    ma20 !== null &&
    current > ma5 &&
    ma5 > ma20
  ) {
    score += 10;
    reasons.push("短期均線呈現偏多排列");
  }

  if (
    ma20 !== null &&
    ma60 !== null &&
    current > ma20 &&
    ma20 > ma60
  ) {
    score += 10;
    reasons.push("中期均線維持多方結構");
  }

  if (
    rsiValue !== null &&
    rsiValue >= 50 &&
    rsiValue <= 70
  ) {
    score += 5;
    reasons.push("RSI 位於相對強勢區");
  }

  if (
    macdValue.macd !== null &&
    macdValue.signal !== null &&
    macdValue.macd > macdValue.signal
  ) {
    score += 8;
    reasons.push("MACD 位於訊號線上方");
  }

  if (
    bb &&
    current > bb.middle
  ) {
    score += 5;
    reasons.push("價格位於布林中線上方");
  }

  if (
    rsiValue !== null &&
    rsiValue > 75
  ) {
    score -= 8;
    risks.push("RSI 偏高，短線可能有過熱風險");
  }

  if (
    rsiValue !== null &&
    rsiValue < 30
  ) {
    risks.push("RSI 偏低，市場動能較弱");
  }

  if (
    ma20 !== null &&
    current < ma20
  ) {
    risks.push("價格低於 MA20");
  }

  if (
    supportResistanceValue.resistance !== null &&
    current >=
      supportResistanceValue.resistance * 0.98
  ) {
    risks.push("價格接近近期壓力區");
  }

  if (score > 100) score = 100;
  if (score < 0) score = 0;

  let trend = "中性";

  if (
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
    }
  }

  let momentum = "中性";

  if (
    rsiValue !== null &&
    rsiValue > 55
  ) {
    momentum = "偏強";
  }

  if (
    rsiValue !== null &&
    rsiValue < 45
  ) {
    momentum = "偏弱";
  }

  catalysts.push("持續觀察成交量");
  catalysts.push("觀察 MA20 與 MA60 方向");
  catalysts.push("觀察 RSI 與 MACD 是否同步");

  return {
    symbol,
    status: "OK",
    score,
    trend,
    momentum,
    fundamental: "需搭配財報與公司資料判斷",
    sentiment: "需搭配市場消息判斷",
    valuation: "需搭配本益比、EPS 等資料判斷",
    risk:
      risks.length
        ? risks.join("；")
        : "目前技術面未發現明顯警訊",
    reasons,
    risks,
    catalysts,
    indicators: {
      price: round(current),
      ma5: round(ma5),
      ma20: round(ma20),
      ma60: round(ma60),
      ema12: round(ema12),
      ema26: round(ema26),
      rsi: round(rsiValue),
      macd: round(macdValue.macd),
      macdSignal: round(macdValue.signal),
      macdHistogram: round(macdValue.histogram),
      bollingerUpper: bb ? round(bb.upper) : null,
      bollingerMiddle: bb ? round(bb.middle) : null,
      bollingerLower: bb ? round(bb.lower) : null,
      atr: round(atr(rows)),
      vwap: round(vwap(rows)),
      support: round(supportResistanceValue.support),
      resistance: round(supportResistanceValue.resistance),
      volume: rows[rows.length - 1].volume
    },
    disclaimer:
      "IAN AI 僅提供資訊與技術分析，不代表投資建議，也不保證獲利。"
  };
}

/* =========================
   熱門股票
========================= */

const TW_STOCKS = [
  {
    symbol: "2330",
    name: "台積電"
  },
  {
    symbol: "2317",
    name: "鴻海"
  },
  {
    symbol: "2454",
    name: "聯發科"
  },
  {
    symbol: "2303",
    name: "聯電"
  },
  {
    symbol: "2382",
    name: "廣達"
  },
  {
    symbol: "3034",
    name: "聯詠"
  },
  {
    symbol: "2308",
    name: "台達電"
  },
  {
    symbol: "3231",
    name: "緯創"
  }
];

const US_STOCKS = [
  {
    symbol: "AAPL",
    name: "Apple"
  },
  {
    symbol: "NVDA",
    name: "NVIDIA"
  },
  {
    symbol: "MSFT",
    name: "Microsoft"
  },
  {
    symbol: "AMZN",
    name: "Amazon"
  },
  {
    symbol: "GOOGL",
    name: "Alphabet"
  },
  {
    symbol: "META",
    name: "Meta"
  },
  {
    symbol: "TSLA",
    name: "Tesla"
  }
];

/* =========================
   API
========================= */

app.get("/", (req, res) => {
  res.json({
    name: "IAN STOCK API",
    version: "7.0.0",
    status: "ONLINE",
    message: "IAN STOCK API is running",
    time: now()
  });
});

/* STATUS */

app.get("/api/status", (req, res) => {
  res.json({
    server: "IAN STOCK API",
    version: "7.0.0",
    status: "ONLINE",

    // 舊版前端相容
    yahooFinance: "AVAILABLE_WITH_FALLBACK",
    alphaVantageConfigured:
      Boolean(ALPHA_VANTAGE_KEY),

    // 新版資料來源
    dataSources: {
      yahooFinance:
        "AVAILABLE_WITH_FALLBACK",
      stooq: "AVAILABLE_AS_DAILY_FALLBACK",
      alphaVantageConfigured:
        Boolean(ALPHA_VANTAGE_KEY)
    },

    cacheEntries: quoteCache.size,
    historyCacheEntries: historyCache.size,

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

/* QUOTES */

app.get("/api/quotes", async (req, res) => {
  try {
    let symbols = [];

    if (req.query.symbols) {
      symbols = String(req.query.symbols)
        .split(",")
        .map(cleanSymbol)
        .filter(Boolean);
    }

    if (!symbols.length) {
      symbols = TW_STOCKS
        .slice(0, 8)
        .map(item => item.symbol);
    }

    const results = [];

    for (const symbol of symbols) {
      const quote = await getQuote(symbol);

      if (quote) {
        results.push(quote);
      } else {
        results.push({
          symbol,
          name: symbol,
          price: null,
          previousClose: null,
          change: null,
          changePercent: null,
          source: null,
          status: "NO_DATA"
        });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({
      error: "QUOTE_ERROR",
      message: error.message
    });
  }
});

/* SINGLE QUOTE */

app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);

    const quote = await getQuote(symbol);

    if (!quote) {
      return res.status(404).json({
        error: "NO_DATA",
        symbol
      });
    }

    res.json(quote);
  } catch (error) {
    res.status(500).json({
      error: "QUOTE_ERROR",
      message: error.message
    });
  }
});

/* HISTORY */

app.get("/api/history/:symbol", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);

    const days = Math.min(
      Math.max(
        Number(req.query.days) || 365,
        30
      ),
      2000
    );

    const rows = await getHistory(
      symbol,
      days
    );

    res.json({
      symbol,
      days,
      count: rows.length,
      source:
        rows.length
          ? "Stooq/Yahoo Finance"
          : null,
      data: rows
    });
  } catch (error) {
    res.status(500).json({
      error: "HISTORY_ERROR",
      message: error.message
    });
  }
});

/* ANALYSIS */

app.get("/api/analysis/:symbol", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);

    const quote = await getQuote(symbol);

    const rows = await getHistory(
      symbol,
      365
    );

    const analysis = buildAnalysis(
      symbol,
      rows,
      quote
    );

    res.json({
      ...analysis,
      quote
    });
  } catch (error) {
    res.status(500).json({
      error: "ANALYSIS_ERROR",
      message: error.message
    });
  }
});

/* STOCK */

app.get("/api/stock/:symbol", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);

    const quote = await getQuote(symbol);

    const rows = await getHistory(
      symbol,
      365
    );

    const analysis = buildAnalysis(
      symbol,
      rows,
      quote
    );

    res.json({
      symbol,
      quote,
      history: rows,
      analysis,
      updatedAt: now()
    });
  } catch (error) {
    res.status(500).json({
      error: "STOCK_ERROR",
      message: error.message
    });
  }
});

/* SEARCH */

app.get("/api/search", async (req, res) => {
  const q = String(
    req.query.q || ""
  )
    .trim()
    .toLowerCase();

  if (!q) {
    return res.json([]);
  }

  const cached = searchCache.get(q);

  if (
    cached &&
    Date.now() - cached.time < CACHE_TIME
  ) {
    return res.json(cached.data);
  }

  const all = [
    ...TW_STOCKS.map(item => ({
      ...item,
      market: "TW"
    })),

    ...US_STOCKS.map(item => ({
      ...item,
      market: "US"
    }))
  ];

  const results = all.filter(item =>
    item.symbol
      .toLowerCase()
      .includes(q) ||
    item.name
      .toLowerCase()
      .includes(q)
  );

  searchCache.set(q, {
    time: Date.now(),
    data: results
  });

  res.json(results);
});

/* MARKET */

app.get("/api/market", async (req, res) => {
  const stocks = [
    "2330",
    "2317",
    "2454",
    "2303",
    "2382",
    "3034",
    "2308",
    "3231",
    "AAPL",
    "NVDA",
    "MSFT",
    "TSLA"
  ];

  const results = [];

  for (const symbol of stocks) {
    const quote = await getQuote(symbol);

    if (quote) {
      results.push(quote);
    }
  }

  res.json({
    updatedAt: now(),
    source:
      "Yahoo Finance / Stooq / Alpha Vantage",
    data: results
  });
});

/* CACHE */

app.get("/api/cache", (req, res) => {
  res.json({
    quoteCache: quoteCache.size,
    historyCache: historyCache.size,
    searchCache: searchCache.size,
    time: now()
  });
});

/* 清除 CACHE */

app.post("/api/cache/clear", (req, res) => {
  quoteCache.clear();
  historyCache.clear();
  searchCache.clear();

  res.json({
    status: "CLEARED",
    time: now()
  });
});

/* 404 */

app.use((req, res) => {
  res.status(404).json({
    error: "NOT_FOUND",
    path: req.originalUrl
  });
});

/* ERROR */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "SERVER_ERROR",
    message: err.message
  });
});

/* =========================
   啟動
========================= */

app.listen(PORT, () => {
  console.log("=================================");
  console.log("IAN STOCK API");
  console.log("Version: 7.0.0");
  console.log(`Port: ${PORT}`);
  console.log("Status: ONLINE");
  console.log(
    "Alpha Vantage:",
    ALPHA_VANTAGE_KEY
      ? "CONFIGURED"
      : "NOT CONFIGURED"
  );
  console.log(
    "Yahoo Finance: ENABLED"
  );
  console.log(
    "Stooq fallback: ENABLED"
  );
  console.log("=================================");
});
