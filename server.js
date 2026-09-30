const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERSION = "6.0.0";
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

const SERVER_NAME = "IAN STOCK API";

/* =========================
   CACHE
========================= */

const CACHE_TIME = 10 * 60 * 1000;
const LONG_CACHE_TIME = 60 * 60 * 1000;

const quoteCache = {};
const historyCache = {};
const searchCache = {};
const marketCache = {};

/* =========================
   HELPERS
========================= */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheGet(store, key, maxAge) {
  const item = store[key];

  if (!item) return null;

  const age = Date.now() - item.time;

  if (age > maxAge) return null;

  return {
    ...item.data,
    cached: true,
    cacheAgeSeconds: Math.floor(age / 1000)
  };
}

function cacheSet(store, key, data) {
  store[key] = {
    time: Date.now(),
    data
  };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/* =========================
   SYMBOL CONVERSION
========================= */

function yahooSymbol(symbol) {
  symbol = cleanSymbol(symbol);

  /*
    台股:
    2330 -> 2330.TW
    0050 -> 0050.TW

    美股:
    NVDA -> NVDA
  */

  if (/^\d{4,6}$/.test(symbol)) {
    return symbol + ".TW";
  }

  if (symbol.endsWith(".TW") || symbol.endsWith(".TWO")) {
    return symbol;
  }

  return symbol;
}

/* =========================
   YAHOO CHART
========================= */

async function yahooChart(symbol, range = "1y", interval = "1d") {

  const ys = yahooSymbol(symbol);

  const hosts = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ];

  let lastError = "Yahoo Finance unavailable";

  for (const host of hosts) {

    const url =
      "https://" +
      host +
      "/v8/finance/chart/" +
      encodeURIComponent(ys) +
      "?range=" +
      encodeURIComponent(range) +
      "&interval=" +
      encodeURIComponent(interval) +
      "&includePrePost=false&events=div%2Csplits";

    try {

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        lastError = "Yahoo HTTP " + response.status;
        continue;
      }

      const data = await response.json();

      const result =
        data &&
        data.chart &&
        data.chart.result &&
        data.chart.result[0];

      if (!result) {
        lastError = "Yahoo returned no result";
        continue;
      }

      const timestamps = safeArray(result.timestamp);
      const q =
        result.indicators &&
        result.indicators.quote &&
        result.indicators.quote[0];

      if (!q || timestamps.length === 0) {
        lastError = "Yahoo returned no chart data";
        continue;
      }

      const rows = [];

      for (let i = 0; i < timestamps.length; i++) {

        const close = number(q.close && q.close[i]);

        if (close === null) continue;

        rows.push({
          time: timestamps[i] * 1000,
          open: number(q.open && q.open[i]),
          high: number(q.high && q.high[i]),
          low: number(q.low && q.low[i]),
          close,
          volume: number(q.volume && q.volume[i]) || 0
        });
      }

      if (!rows.length) {
        lastError = "Yahoo returned empty rows";
        continue;
      }

      return {
        ok: true,
        symbol,
        yahooSymbol: ys,
        rows,
        currency:
          result.meta &&
          result.meta.currency
            ? result.meta.currency
            : null,
        exchange:
          result.meta &&
          result.meta.exchangeName
            ? result.meta.exchangeName
            : null,
        source: "Yahoo Finance"
      };

    } catch (error) {
      lastError = error.message;
    }
  }

  return {
    ok: false,
    symbol,
    error: lastError
  };
}

/* =========================
   ALPHA VANTAGE
========================= */

async function alphaQuote(symbol) {

  if (!API_KEY) {
    return {
      ok: false,
      symbol,
      error: "Alpha Vantage API key is not configured"
    };
  }

  const url =
    "https://www.alphavantage.co/query" +
    "?function=GLOBAL_QUOTE" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&apikey=" +
    encodeURIComponent(API_KEY);

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent": "IAN-STOCK"
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        symbol,
        error: "Alpha Vantage HTTP " + response.status
      };
    }

    const data = await response.json();

    if (data.Information) {
      return {
        ok: false,
        symbol,
        error: data.Information
      };
    }

    if (data["Error Message"]) {
      return {
        ok: false,
        symbol,
        error: data["Error Message"]
      };
    }

    const q = data["Global Quote"];

    if (!q || !q["05. price"]) {
      return {
        ok: false,
        symbol,
        error: "Alpha Vantage returned no quote"
      };
    }

    return {
      ok: true,
      symbol,
      price: number(q["05. price"]),
      change: number(q["09. change"]) || 0,
      changePct: number(
        String(q["10. change percent"] || "")
          .replace("%", "")
      ) || 0,
      volume: number(q["06. volume"]) || 0,
      latestTradingDay:
        q["07. latest trading day"] || null,
      source: "Alpha Vantage"
    };

  } catch (error) {

    return {
      ok: false,
      symbol,
      error: error.message
    };
  }
}

/* =========================
   QUOTE
========================= */

async function getQuote(symbol) {

  symbol = cleanSymbol(symbol);

  if (!symbol) {
    return {
      ok: false,
      error: "Symbol required"
    };
  }

  const cached = cacheGet(
    quoteCache,
    symbol,
    LONG_CACHE_TIME
  );

  if (cached) {
    return cached;
  }

  /*
    先 Yahoo chart
    因為不需要 Alpha Vantage 每一支股票都消耗額度
  */

  const chart = await yahooChart(
    symbol,
    "5d",
    "1d"
  );

  if (chart.ok && chart.rows.length) {

    const rows = chart.rows;

    const last = rows[rows.length - 1];

    const previous =
      rows.length >= 2
        ? rows[rows.length - 2]
        : null;

    const price = last.close;

    const change =
      previous
        ? price - previous.close
        : 0;

    const changePct =
      previous && previous.close
        ? (change / previous.close) * 100
        : 0;

    const result = {
      ok: true,
      symbol,
      price,
      change,
      changePct,
      volume: last.volume || 0,
      latestTradingDay:
        new Date(last.time)
          .toISOString()
          .slice(0, 10),
      source: chart.source,
      currency: chart.currency,
      exchange: chart.exchange
    };

    cacheSet(
      quoteCache,
      symbol,
      result
    );

    return result;
  }

  /*
    Yahoo 失敗才嘗試 Alpha Vantage
  */

  const alpha = await alphaQuote(symbol);

  if (alpha.ok) {

    cacheSet(
      quoteCache,
      symbol,
      alpha
    );

    return alpha;
  }

  return {
    ok: false,
    symbol,
    error:
      "All quote sources unavailable",
    sources: {
      yahoo: chart.error,
      alphaVantage: alpha.error
    }
  };
}

/* =========================
   HISTORY
========================= */

async function getHistory(
  symbol,
  range = "1y",
  interval = "1d"
) {

  symbol = cleanSymbol(symbol);

  const key =
    symbol +
    "|" +
    range +
    "|" +
    interval;

  const cached = cacheGet(
    historyCache,
    key,
    LONG_CACHE_TIME
  );

  if (cached) {
    return cached;
  }

  const result = await yahooChart(
    symbol,
    range,
    interval
  );

  if (!result.ok) {
    return {
      ok: false,
      symbol,
      error: result.error,
      rows: []
    };
  }

  const response = {
    ok: true,
    symbol,
    source: result.source,
    currency: result.currency,
    exchange: result.exchange,
    rows: result.rows
  };

  cacheSet(
    historyCache,
    key,
    response
  );

  return response;
}

/* =========================
   TECHNICAL INDICATORS
========================= */

function sma(values, period) {

  if (values.length < period) {
    return null;
  }

  const slice =
    values.slice(
      values.length - period
    );

  return (
    slice.reduce(
      (a, b) => a + b,
      0
    ) / period
  );
}

function ema(values, period) {

  if (values.length < period) {
    return null;
  }

  const k =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {

  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      (avgGain * (period - 1) + gain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function standardDeviation(
  values
) {

  if (!values.length) {
    return null;
  }

  const mean =
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length;

  const variance =
    values.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - mean, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function bollinger(
  values,
  period = 20
) {

  if (values.length < period) {
    return {
      middle: null,
      upper: null,
      lower: null
    };
  }

  const slice =
    values.slice(
      values.length - period
    );

  const middle =
    slice.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const sd =
    standardDeviation(slice);

  return {
    middle,
    upper: middle + 2 * sd,
    lower: middle - 2 * sd
  };
}

function atr(rows, period = 14) {

  if (rows.length <= period) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    const current = rows[i];
    const previous = rows[i - 1];

    const tr =
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high -
          previous.close
        ),
        Math.abs(
          current.low -
          previous.close
        )
      );

    trs.push(tr);
  }

  return sma(trs, period);
}

function vwap(rows) {

  let totalPV = 0;
  let totalVolume = 0;

  for (const row of rows) {

    const typical =
      (
        row.high +
        row.low +
        row.close
      ) / 3;

    const volume =
      row.volume || 0;

    totalPV +=
      typical * volume;

    totalVolume += volume;
  }

  if (!totalVolume) {
    return null;
  }

  return (
    totalPV /
    totalVolume
  );
}

function macd(values) {

  const ema12 =
    ema(values, 12);

  const ema26 =
    ema(values, 26);

  if (
    ema12 === null ||
    ema26 === null
  ) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  /*
    完整 MACD signal
    用每一日 EMA12 - EMA26
  */

  const macdSeries = [];

  for (
    let i = 26;
    i <= values.length;
    i++
  ) {

    const slice =
      values.slice(0, i);

    const e12 =
      ema(slice, 12);

    const e26 =
      ema(slice, 26);

    if (
      e12 !== null &&
      e26 !== null
    ) {
      macdSeries.push(
        e12 - e26
      );
    }
  }

  const current =
    macdSeries[
      macdSeries.length - 1
    ];

  const signal =
    ema(macdSeries, 9);

  return {
    macd: current,
    signal,
    histogram:
      signal === null
        ? null
        : current - signal
  };
}

/* =========================
   SUPPORT / RESISTANCE
========================= */

function supportResistance(rows) {

  if (!rows.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    rows.slice(-60);

  const lows =
    recent
      .map(x => x.low)
      .filter(x => Number.isFinite(x));

  const highs =
    recent
      .map(x => x.high)
      .filter(x => Number.isFinite(x));

  return {
    support:
      lows.length
        ? Math.min(...lows)
        : null,

    resistance:
      highs.length
        ? Math.max(...highs)
        : null
  };
}

/* =========================
   ANALYSIS
========================= */

async function buildAnalysis(symbol) {

  const history =
    await getHistory(
      symbol,
      "1y",
      "1d"
    );

  if (
    !history.ok ||
    !history.rows.length
  ) {

    return {
      ok: false,
      symbol,
      error:
        history.error ||
        "Historical data unavailable"
    };
  }

  const rows =
    history.rows;

  const closes =
    rows
      .map(x => x.close)
      .filter(
        x => Number.isFinite(x)
      );

  const current =
    closes[closes.length - 1];

  const ma5 =
    sma(closes, 5);

  const ma20 =
    sma(closes, 20);

  const ma60 =
    sma(closes, 60);

  const ema12 =
    ema(closes, 12);

  const ema26 =
    ema(closes, 26);

  const RSI =
    rsi(closes, 14);

  const MACD =
    macd(closes);

  const BB =
    bollinger(closes, 20);

  const ATR =
    atr(rows, 14);

  const VWAP =
    vwap(
      rows.slice(-20)
    );

  const SR =
    supportResistance(rows);

  let trend =
    "中性";

  if (
    ma20 !== null &&
    ma60 !== null
  ) {

    if (
      current > ma20 &&
      ma20 > ma60
    ) {
      trend = "偏多";
    }

    if (
      current < ma20 &&
      ma20 < ma60
    ) {
      trend = "偏空";
    }
  }

  let momentum =
    "中性";

  if (
    RSI !== null &&
    RSI >= 50 &&
    MACD.macd !== null &&
    MACD.macd > 0
  ) {
    momentum = "偏強";
  }

  if (
    RSI !== null &&
    RSI < 50 &&
    MACD.macd !== null &&
    MACD.macd < 0
  ) {
    momentum = "偏弱";
  }

  const factors = [];

  if (
    ma20 !== null &&
    current > ma20
  ) {
    factors.push(
      "價格位於 MA20 上方"
    );
  }

  if (
    ma60 !== null &&
    current > ma60
  ) {
    factors.push(
      "價格位於 MA60 上方"
    );
  }

  if (
    RSI !== null
  ) {
    factors.push(
      "RSI " +
      RSI.toFixed(2)
    );
  }

  if (
    MACD.macd !== null
  ) {
    factors.push(
      "MACD " +
      MACD.macd.toFixed(2)
    );
  }

  const watch = [];

  if (
    RSI !== null &&
    RSI >= 70
  ) {
    watch.push(
      "RSI 高於 70，留意過熱"
    );
  }

  if (
    RSI !== null &&
    RSI <= 30
  ) {
    watch.push(
      "RSI 低於 30，留意超賣"
    );
  }

  if (
    SR.resistance !== null
  ) {
    watch.push(
      "近期壓力約 " +
      SR.resistance.toFixed(2)
    );
  }

  if (
    SR.support !== null
  ) {
    watch.push(
      "近期支撐約 " +
      SR.support.toFixed(2)
    );
  }

  return {
    ok: true,
    symbol,

    current,

    trend,
    momentum,

    indicators: {
      MA5: ma5,
      MA20: ma20,
      MA60: ma60,
      EMA12: ema12,
      EMA26: ema26,
      RSI,
      MACD: MACD.macd,
      MACDSignal: MACD.signal,
      MACDHistogram: MACD.histogram,
      BollingerMiddle: BB.middle,
      BollingerUpper: BB.upper,
      BollingerLower: BB.lower,
      ATR,
      VWAP: VWAP,
      Volume:
        rows[rows.length - 1].volume || 0
    },

    support: SR.support,
    resistance: SR.resistance,

    factors,
    watch,

    source: history.source,

    disclaimer:
      "IAN AI 僅提供市場資料與技術指標整理，不構成投資建議。"
  };
}

/* =========================
   SEARCH
========================= */

const popularStocks = [

  /* Taiwan */

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

  /* US */

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
  }
];

/* =========================
   ROUTES
========================= */

/*
  Root
*/

app.get("/", (req, res) => {

  res.json({
    server: SERVER_NAME,
    version: VERSION,
    status: "ONLINE",
    message: "IAN STOCK API is running"
  });

});

/*
  STATUS
*/

app.get("/api/status", async (req, res) => {

  const result = {
    server: SERVER_NAME,
    version: VERSION,
    status: "ONLINE",

    dataSources: {
      yahooFinance:
        "AVAILABLE_WITH_CACHE_AND_FALLBACK",

      alphaVantageConfigured:
        Boolean(API_KEY)
    },

    cacheEntries: {
      quotes:
        Object.keys(quoteCache).length,

      history:
        Object.keys(historyCache).length
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
  };

  res.json(result);
});

/*
  MULTIPLE QUOTES
*/

app.get("/api/quotes", async (req, res) => {

  let symbols = [];

  if (req.query.symbols) {

    symbols =
      String(req.query.symbols)
        .split(",")
        .map(cleanSymbol)
        .filter(Boolean)
        .slice(0, 10);

  }

  if (!symbols.length) {

    symbols = [
      "NVDA",
      "AAPL",
      "MSFT"
    ];

  }

  const results = [];

  /*
    不要同時狂打 API
    一支一支取得
  */

  for (const symbol of symbols) {

    const quote =
      await getQuote(symbol);

    if (quote.ok) {
      results.push(quote);
    }

    /*
      避免免費資料源瞬間被打爆
    */

    await sleep(150);
  }

  res.json(results);

});

/*
  SINGLE QUOTE
*/

app.get("/api/quote/:symbol", async (req, res) => {

  const symbol =
    cleanSymbol(req.params.symbol);

  if (!symbol) {

    return res.status(400).json({
      ok: false,
      error: "Invalid symbol"
    });

  }

  const quote =
    await getQuote(symbol);

  if (!quote.ok) {

    return res.status(200).json({
      ok: false,
      symbol,
      error: quote.error,
      sources: quote.sources || {}
    });

  }

  res.json(quote);

});

/*
  HISTORY
*/

app.get("/api/history/:symbol", async (req, res) => {

  const symbol =
    cleanSymbol(req.params.symbol);

  const range =
    String(req.query.range || "1y");

  const interval =
    String(req.query.interval || "1d");

  const result =
    await getHistory(
      symbol,
      range,
      interval
    );

  res.json(result);

});

/*
  ANALYSIS
*/

app.get("/api/analysis/:symbol", async (req, res) => {

  const symbol =
    cleanSymbol(req.params.symbol);

  const result =
    await buildAnalysis(symbol);

  res.json(result);

});

/*
  STOCK DETAIL
*/

app.get("/api/stock/:symbol", async (req, res) => {

  const symbol =
    cleanSymbol(req.params.symbol);

  const quote =
    await getQuote(symbol);

  const analysis =
    await buildAnalysis(symbol);

  res.json({
    ok: true,
    symbol,
    quote,
    analysis
  });

});

/*
  SEARCH
*/

app.get("/api/search", async (req, res) => {

  const keyword =
    String(req.query.q || "")
      .trim()
      .toUpperCase();

  if (!keyword) {

    return res.json({
      ok: true,
      count: popularStocks.length,
      results: popularStocks
    });

  }

  const results =
    popularStocks.filter(stock =>

      stock.symbol
        .toUpperCase()
        .includes(keyword)

      ||

      stock.name
        .toUpperCase()
        .includes(keyword)

    );

  res.json({
    ok: true,
    count: results.length,
    results
  });

});

/*
  MARKET
*/

app.get("/api/market", async (req, res) => {

  const cached =
    cacheGet(
      marketCache,
      "market",
      CACHE_TIME
    );

  if (cached) {
    return res.json(cached);
  }

  const symbols = [
    {
      key: "TWII",
      symbol: "^TWII",
      name: "台灣加權指數"
    },

    {
      key: "NASDAQ",
      symbol: "^IXIC",
      name: "NASDAQ"
    },

    {
      key: "SP500",
      symbol: "^GSPC",
      name: "S&P 500"
    },

    {
      key: "USDTWD",
      symbol: "TWD=X",
      name: "USD/TWD"
    }
  ];

  const output = {};

  for (const item of symbols) {

    const quote =
      await getQuote(item.symbol);

    output[item.key] = {
      name: item.name,
      ok: quote.ok,
      price:
        quote.ok
          ? quote.price
          : null,

      change:
        quote.ok
          ? quote.change
          : null,

      changePct:
        quote.ok
          ? quote.changePct
          : null,

      source:
        quote.ok
          ? quote.source
          : null
    };

    await sleep(150);
  }

  const result = {
    ok: true,
    market: output,
    updatedAt:
      new Date().toISOString()
  };

  cacheSet(
    marketCache,
    "market",
    result
  );

  res.json(result);

});

/*
  CACHE
*/

app.get("/api/cache", (req, res) => {

  const result = {};

  for (
    const symbol of
    Object.keys(quoteCache)
  ) {

    const item =
      quoteCache[symbol];

    const age =
      Date.now() - item.time;

    result[symbol] = {
      cached:
        age < LONG_CACHE_TIME,

      ageSeconds:
        Math.floor(age / 1000),

      price:
        item.data.price,

      source:
        item.data.source
    };
  }

  res.json({
    quoteCacheTimeMinutes:
      LONG_CACHE_TIME / 60000,

    historyCacheTimeMinutes:
      LONG_CACHE_TIME / 60000,

    quotes: result
  });

});

/* =========================
   404
========================= */

app.use((req, res) => {

  res.status(404).json({
    ok: false,
    error: "API route not found",
    path: req.path
  });

});

/* =========================
   ERROR
========================= */

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

/* =========================
   START
========================= */

app.listen(PORT, () => {

  console.log(
    `${SERVER_NAME} v${VERSION} running on port ${PORT}`
  );

});
