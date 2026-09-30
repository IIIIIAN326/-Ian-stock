const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERSION = "5.0.0";

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "";

const CACHE_TIME = 5 * 60 * 1000;
const HISTORY_CACHE_TIME = 30 * 60 * 1000;

const cache = new Map();
const historyCache = new Map();

const SERVER_NAME = "IAN STOCK API";

/* =========================================================
   基本工具
========================================================= */

function cleanSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function isTW(symbol) {
  return /^\d{4,6}$/.test(cleanSymbol(symbol));
}

function yahooSymbol(symbol) {
  symbol = cleanSymbol(symbol);
  if (isTW(symbol)) return symbol + ".TW";
  return symbol;
}

function now() {
  return Date.now();
}

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (now() - item.time > CACHE_TIME) {
    return null;
  }

  return {
    ...item.data,
    cached: true,
    cacheAgeSeconds: Math.floor((now() - item.time) / 1000)
  };
}

function setCache(key, data) {
  cache.set(key, {
    time: now(),
    data
  });
}

function getHistoryCache(key) {
  const item = historyCache.get(key);

  if (!item) return null;

  if (now() - item.time > HISTORY_CACHE_TIME) {
    return null;
  }

  return {
    ...item.data,
    cached: true
  };
}

function setHistoryCache(key, data) {
  historyCache.set(key, {
    time: now(),
    data
  });
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* =========================================================
   HTTP JSON
========================================================= */

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      "Accept": "application/json,text/plain,*/*",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      "HTTP " + response.status
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

/* =========================================================
   Yahoo Finance
========================================================= */

async function yahooQuote(symbol) {
  symbol = cleanSymbol(symbol);

  const ySymbol = yahooSymbol(symbol);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=5d&interval=1d&includePrePost=false";

  const data = await fetchJSON(url);

  const result =
    data &&
    data.chart &&
    data.chart.result &&
    data.chart.result[0];

  if (!result) {
    throw new Error("Yahoo Finance 沒有回傳資料");
  }

  const meta = result.meta || {};

  const price =
    number(meta.regularMarketPrice) ||
    number(meta.previousClose);

  if (price === null) {
    throw new Error("Yahoo Finance 沒有價格");
  }

  const previous =
    number(meta.previousClose) ||
    price;

  const change = price - previous;

  const changePct =
    previous !== 0
      ? (change / previous) * 100
      : 0;

  return {
    ok: true,
    symbol,
    market: isTW(symbol) ? "TW" : "US",
    price,
    previousClose: previous,
    change,
    changePct,
    currency: meta.currency || (isTW(symbol) ? "TWD" : "USD"),
    exchange: meta.exchangeName || "",
    source: "Yahoo Finance",
    latestTradingDay:
      meta.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000)
            .toISOString()
            .slice(0, 10)
        : null
  };
}

/* =========================================================
   Alpha Vantage 備援
========================================================= */

async function alphaQuote(symbol) {
  symbol = cleanSymbol(symbol);

  if (!ALPHA_VANTAGE_KEY) {
    throw new Error("ALPHA_VANTAGE_KEY 未設定");
  }

  if (isTW(symbol)) {
    throw new Error("Alpha Vantage 備援目前只處理美股");
  }

  const url =
    "https://www.alphavantage.co/query" +
    "?function=GLOBAL_QUOTE" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&apikey=" +
    encodeURIComponent(ALPHA_VANTAGE_KEY);

  const data = await fetchJSON(url);

  if (data.Information) {
    throw new Error(data.Information);
  }

  if (data["Error Message"]) {
    throw new Error(data["Error Message"]);
  }

  const quote = data["Global Quote"];

  if (!quote || !quote["05. price"]) {
    throw new Error("Alpha Vantage 沒有價格資料");
  }

  return {
    ok: true,
    symbol,
    market: "US",
    price: number(quote["05. price"]),
    change: number(quote["09. change"]) || 0,
    changePct:
      number(
        String(quote["10. change percent"] || "")
          .replace("%", "")
      ) || 0,
    volume: number(quote["06. volume"]) || 0,
    previousClose:
      number(quote["08. previous close"]) || null,
    currency: "USD",
    source: "Alpha Vantage",
    latestTradingDay:
      quote["07. latest trading day"] || null
  };
}

/* =========================================================
   台股 TWSE 備援
========================================================= */

async function twseQuote(symbol) {
  symbol = cleanSymbol(symbol);

  if (!isTW(symbol)) {
    throw new Error("不是台股代號");
  }

  const url =
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

  const data = await fetchJSON(url);

  if (!Array.isArray(data)) {
    throw new Error("TWSE 沒有回傳資料");
  }

  const row = data.find(
    item =>
      String(item.Code || item["證券代號"] || "").trim() === symbol
  );

  if (!row) {
    throw new Error("TWSE 找不到股票 " + symbol);
  }

  const price =
    number(row.ClosingPrice) ||
    number(row["收盤價"]);

  if (price === null) {
    throw new Error("TWSE 沒有收盤價");
  }

  const change =
    number(row.Change) ||
    number(row["漲跌價差"]) ||
    0;

  return {
    ok: true,
    symbol,
    market: "TW",
    price,
    change,
    changePct: 0,
    volume:
      number(row.TradingVolume) ||
      number(row["成交股數"]) ||
      0,
    currency: "TWD",
    source: "TWSE",
    latestTradingDay: new Date()
      .toISOString()
      .slice(0, 10)
  };
}

/* =========================================================
   統一報價
========================================================= */

async function getQuote(symbol) {
  symbol = cleanSymbol(symbol);

  if (!symbol) {
    return {
      ok: false,
      error: "股票代號不能為空"
    };
  }

  const cached = getCache("quote:" + symbol);

  if (cached) {
    return cached;
  }

  const errors = [];

  /* 台股 */
  if (isTW(symbol)) {
    try {
      const result = await twseQuote(symbol);

      setCache("quote:" + symbol, result);

      return {
        ...result,
        cached: false
      };
    } catch (error) {
      errors.push("TWSE: " + error.message);
    }

    /* Yahoo 台股備援 */
    try {
      const result = await yahooQuote(symbol);

      setCache("quote:" + symbol, result);

      return {
        ...result,
        cached: false
      };
    } catch (error) {
      errors.push("Yahoo: " + error.message);
    }
  }

  /* 美股 */
  else {
    try {
      const result = await yahooQuote(symbol);

      setCache("quote:" + symbol, result);

      return {
        ...result,
        cached: false
      };
    } catch (error) {
      errors.push("Yahoo: " + error.message);
    }

    /* Alpha Vantage 備援 */
    try {
      const result = await alphaQuote(symbol);

      setCache("quote:" + symbol, result);

      return {
        ...result,
        cached: false
      };
    } catch (error) {
      errors.push("Alpha Vantage: " + error.message);
    }
  }

  return {
    ok: false,
    symbol,
    error: "所有行情來源目前都無法取得資料",
    details: errors
  };
}

/* =========================================================
   Yahoo 歷史 K 線
========================================================= */

async function yahooHistory(symbol, range = "1y") {
  symbol = cleanSymbol(symbol);

  const ySymbol = yahooSymbol(symbol);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=" +
    encodeURIComponent(range) +
    "&interval=1d&includePrePost=false";

  const data = await fetchJSON(url);

  const result =
    data &&
    data.chart &&
    data.chart.result &&
    data.chart.result[0];

  if (!result) {
    throw new Error("Yahoo 歷史資料不存在");
  }

  const timestamps = result.timestamp || [];

  const quote =
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0];

  if (!quote) {
    throw new Error("Yahoo K 線資料不存在");
  }

  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = number(
      quote.close && quote.close[i]
    );

    const open = number(
      quote.open && quote.open[i]
    );

    const high = number(
      quote.high && quote.high[i]
    );

    const low = number(
      quote.low && quote.low[i]
    );

    const volume = number(
      quote.volume && quote.volume[i]
    );

    if (close === null) continue;

    rows.push({
      time: new Date(
        timestamps[i] * 1000
      ).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: volume || 0
    });
  }

  return {
    ok: true,
    symbol,
    market: isTW(symbol) ? "TW" : "US",
    source: "Yahoo Finance",
    range,
    data: rows
  };
}

/* =========================================================
   Stooq 美股歷史備援
========================================================= */

async function stooqHistory(symbol) {
  symbol = cleanSymbol(symbol);

  if (isTW(symbol)) {
    throw new Error("Stooq 備援不處理台股");
  }

  const url =
    "https://stooq.com/q/d/l/?s=" +
    encodeURIComponent(symbol.toLowerCase()) +
    "&d1=20200101&d2=20991231&i=d";

  const response = await fetch(url, {
    headers: {
      "User-Agent": "IAN-STOCK/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      "Stooq HTTP " + response.status
    );
  }

  const text = await response.text();

  const lines = text.trim().split("\n");

  if (lines.length < 2) {
    throw new Error("Stooq 沒有歷史資料");
  }

  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");

    if (parts.length < 6) continue;

    const close = number(parts[4]);

    if (close === null) continue;

    rows.push({
      time: parts[0],
      open: number(parts[1]),
      high: number(parts[2]),
      low: number(parts[3]),
      close,
      volume: number(parts[5]) || 0
    });
  }

  if (!rows.length) {
    throw new Error("Stooq 沒有有效 K 線");
  }

  return {
    ok: true,
    symbol,
    market: "US",
    source: "Stooq",
    range: "max",
    data: rows
  };
}

/* =========================================================
   統一歷史資料
========================================================= */

async function getHistory(symbol, range = "1y") {
  symbol = cleanSymbol(symbol);

  const key = "history:" + symbol + ":" + range;

  const cached = getHistoryCache(key);

  if (cached) {
    return cached;
  }

  const errors = [];

  try {
    const result = await yahooHistory(
      symbol,
      range
    );

    setHistoryCache(key, result);

    return {
      ...result,
      cached: false
    };
  } catch (error) {
    errors.push("Yahoo: " + error.message);
  }

  if (!isTW(symbol)) {
    try {
      const result = await stooqHistory(symbol);

      setHistoryCache(key, result);

      return {
        ...result,
        cached: false,
        fallback: true
      };
    } catch (error) {
      errors.push("Stooq: " + error.message);
    }
  }

  return {
    ok: false,
    symbol,
    error: "歷史行情暫時無法取得",
    details: errors,
    data: []
  };
}

/* =========================================================
   技術指標
========================================================= */

function average(values) {
  const valid = values.filter(
    value => Number.isFinite(value)
  );

  if (!valid.length) return null;

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}

function sma(values, period) {
  if (values.length < period) return null;

  return average(
    values.slice(values.length - period)
  );
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    average(values.slice(0, period));

  for (
    let i = period;
    i < values.length;
    i++
  ) {
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
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

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

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (values.length < 35) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const shortPeriod = 12;
  const longPeriod = 26;
  const signalPeriod = 9;

  const macdValues = [];

  for (
    let i = longPeriod;
    i <= values.length;
    i++
  ) {
    const slice =
      values.slice(0, i);

    const fast =
      ema(slice, shortPeriod);

    const slow =
      ema(slice, longPeriod);

    if (
      fast !== null &&
      slow !== null
    ) {
      macdValues.push(
        fast - slow
      );
    }
  }

  const macd =
    macdValues[macdValues.length - 1];

  const signal =
    ema(
      macdValues,
      signalPeriod
    );

  return {
    macd,
    signal,
    histogram:
      macd !== null &&
      signal !== null
        ? macd - signal
        : null
  };
}

function calculateBollinger(
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

  const data =
    values.slice(values.length - period);

  const middle =
    average(data);

  const variance =
    average(
      data.map(
        value =>
          Math.pow(
            value - middle,
            2
          )
      )
    );

  const standardDeviation =
    Math.sqrt(variance);

  return {
    middle,
    upper:
      middle +
      standardDeviation * 2,
    lower:
      middle -
      standardDeviation * 2
  };
}

function calculateATR(rows, period = 14) {
  if (rows.length <= period) return null;

  const tr = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    const high = current.high;
    const low = current.low;
    const previousClose =
      previous.close;

    if (
      high === null ||
      low === null ||
      previousClose === null
    ) {
      continue;
    }

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high - previousClose
        ),
        Math.abs(
          low - previousClose
        )
      )
    );
  }

  return sma(tr, period);
}

function calculateVWAP(rows) {
  const recent =
    rows.slice(
      Math.max(0, rows.length - 30)
    );

  let totalPV = 0;
  let totalVolume = 0;

  for (const row of recent) {
    const typical =
      (row.high +
        row.low +
        row.close) /
      3;

    const volume =
      row.volume || 0;

    totalPV +=
      typical * volume;

    totalVolume += volume;
  }

  if (!totalVolume) return null;

  return totalPV / totalVolume;
}

function calculateSupportResistance(rows) {
  const recent =
    rows.slice(
      Math.max(0, rows.length - 60)
    );

  const lows =
    recent
      .map(row => row.low)
      .filter(
        value =>
          Number.isFinite(value)
      );

  const highs =
    recent
      .map(row => row.high)
      .filter(
        value =>
          Number.isFinite(value)
      );

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

/* =========================================================
   完整技術分析
========================================================= */

async function getAnalysis(symbol) {
  symbol = cleanSymbol(symbol);

  const history =
    await getHistory(
      symbol,
      "1y"
    );

  if (
    !history.ok ||
    !history.data ||
    !history.data.length
  ) {
    return {
      ok: false,
      symbol,
      error: "沒有足夠歷史資料進行分析"
    };
  }

  const rows = history.data;

  const closes =
    rows
      .map(row => row.close)
      .filter(
        value =>
          Number.isFinite(value)
      );

  const price =
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

  const rsi =
    calculateRSI(closes, 14);

  const macd =
    calculateMACD(closes);

  const bollinger =
    calculateBollinger(
      closes,
      20
    );

  const atr =
    calculateATR(rows, 14);

  const vwap =
    calculateVWAP(rows);

  const sr =
    calculateSupportResistance(
      rows
    );

  let trend = "中性";
  let momentum = "中性";

  if (
    ma20 !== null &&
    ma60 !== null
  ) {
    if (
      price > ma20 &&
      price > ma60
    ) {
      trend = "偏多";
    } else if (
      price < ma20 &&
      price < ma60
    ) {
      trend = "偏空";
    }
  }

  if (rsi !== null) {
    if (rsi >= 70) {
      momentum = "過熱";
    } else if (rsi >= 55) {
      momentum = "偏強";
    } else if (rsi <= 30) {
      momentum = "超賣";
    } else if (rsi < 45) {
      momentum = "偏弱";
    }
  }

  let score = 50;

  if (
    ma20 !== null &&
    price > ma20
  ) {
    score += 10;
  }

  if (
    ma60 !== null &&
    price > ma60
  ) {
    score += 10;
  }

  if (
    ma20 !== null &&
    ma60 !== null &&
    ma20 > ma60
  ) {
    score += 10;
  }

  if (
    rsi !== null &&
    rsi >= 50 &&
    rsi < 70
  ) {
    score += 5;
  }

  if (
    macd.histogram !== null &&
    macd.histogram > 0
  ) {
    score += 10;
  }

  if (
    vwap !== null &&
    price > vwap
  ) {
    score += 5;
  }

  score =
    Math.max(
      0,
      Math.min(100, score)
    );

  const factors = [];

  if (
    ma20 !== null &&
    price > ma20
  ) {
    factors.push(
      "價格位於 MA20 上方"
    );
  }

  if (
    ma60 !== null &&
    price > ma60
  ) {
    factors.push(
      "價格位於 MA60 上方"
    );
  }

  if (
    macd.histogram !== null &&
    macd.histogram > 0
  ) {
    factors.push(
      "MACD 動能位於正值區"
    );
  }

  if (
    rsi !== null
  ) {
    factors.push(
      "RSI " +
      rsi.toFixed(2)
    );
  }

  const observations = [];

  if (
    rsi !== null
  ) {
    if (rsi >= 70) {
      observations.push(
        "RSI 偏高，留意短線過熱"
      );
    } else if (rsi <= 30) {
      observations.push(
        "RSI 偏低，留意超賣反彈"
      );
    } else {
      observations.push(
        "RSI 位於中性區間"
      );
    }
  }

  if (
    macd.macd !== null &&
    macd.macd > 0
  ) {
    observations.push(
      "MACD 位於零軸上方"
    );
  }

  if (
    sr.support !== null
  ) {
    observations.push(
      "近期支撐約 " +
      sr.support.toFixed(2)
    );
  }

  if (
    sr.resistance !== null
  ) {
    observations.push(
      "近期壓力約 " +
      sr.resistance.toFixed(2)
    );
  }

  const risk = [];

  if (
    rsi !== null &&
    rsi >= 70
  ) {
    risk.push(
      "短線 RSI 偏高"
    );
  }

  if (
    atr !== null
  ) {
    risk.push(
      "波動度 ATR " +
      atr.toFixed(2)
    );
  }

  if (!risk.length) {
    risk.push(
      "仍需觀察價格與成交量變化"
    );
  }

  return {
    ok: true,
    symbol,
    market:
      isTW(symbol)
        ? "TW"
        : "US",

    price,

    indicators: {
      MA5: ma5,
      MA20: ma20,
      MA60: ma60,
      EMA12: ema12,
      EMA26: ema26,
      RSI: rsi,
      MACD: macd.macd,
      MACDSignal: macd.signal,
      MACDHistogram:
        macd.histogram,
      BollingerBands:
        bollinger,
      ATR: atr,
      VWAP: vwap,
      Volume:
        rows[rows.length - 1]
          .volume || 0
    },

    support: sr.support,
    resistance: sr.resistance,

    ai: {
      score,
      trend,
      momentum,
      factors,
      observations,
      risk
    },

    history: rows,

    source:
      history.source
  };
}

/* =========================================================
   股票搜尋
========================================================= */

const STOCKS = [
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
    symbol: "SMCI",
    name: "Super Micro Computer",
    market: "US"
  },
  {
    symbol: "PLTR",
    name: "Palantir",
    market: "US"
  },
  {
    symbol: "NFLX",
    name: "Netflix",
    market: "US"
  },
  {
    symbol: "COIN",
    name: "Coinbase",
    market: "US"
  },
  {
    symbol: "MSTR",
    name: "MicroStrategy",
    market: "US"
  }
];

/* =========================================================
   API：Quotes
========================================================= */

app.get("/api/quote/:symbol", async (req, res) => {
  const symbol =
    cleanSymbol(
      req.params.symbol
    );

  const result =
    await getQuote(symbol);

  if (!result.ok) {
    return res
      .status(502)
      .json(result);
  }

  res.json(result);
});

app.get("/api/quotes", async (req, res) => {
  let symbols =
    req.query.symbols
      ? String(
          req.query.symbols
        )
          .split(",")
          .map(cleanSymbol)
          .filter(Boolean)
          .slice(0, 20)
      : [
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
      const result =
        await getQuote(symbol);

      if (result.ok) {
        results.push(result);
      }
    } catch {}
  }

  res.json({
    ok: true,
    count: results.length,
    results
  });
});

/* =========================================================
   API：History
========================================================= */

app.get(
  "/api/history/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const range =
      String(
        req.query.range || "1y"
      );

    const allowedRanges = [
      "1mo",
      "3mo",
      "6mo",
      "1y",
      "2y",
      "5y",
      "10y",
      "max"
    ];

    const safeRange =
      allowedRanges.includes(range)
        ? range
        : "1y";

    const result =
      await getHistory(
        symbol,
        safeRange
      );

    if (!result.ok) {
      return res
        .status(502)
        .json(result);
    }

    res.json(result);
  }
);

/* =========================================================
   API：Analysis
========================================================= */

app.get(
  "/api/analysis/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const result =
      await getAnalysis(symbol);

    if (!result.ok) {
      return res
        .status(502)
        .json(result);
    }

    res.json(result);
  }
);

/* =========================================================
   API：Stock 完整資料
========================================================= */

app.get(
  "/api/stock/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const quote =
      await getQuote(symbol);

    const analysis =
      await getAnalysis(symbol);

    res.json({
      ok:
        quote.ok ||
        analysis.ok,

      symbol,

      quote,

      analysis
    });
  }
);

/* =========================================================
   API：Search
========================================================= */

app.get(
  "/api/search",
  async (req, res) => {
    const keyword =
      String(
        req.query.q || ""
      )
        .trim()
        .toUpperCase();

    const market =
      String(
        req.query.market || ""
      ).toUpperCase();

    let results =
      STOCKS;

    if (market === "TW") {
      results =
        results.filter(
          item =>
            item.market === "TW"
        );
    }

    if (market === "US") {
      results =
        results.filter(
          item =>
            item.market === "US"
        );
    }

    if (keyword) {
      results =
        results.filter(
          item =>
            item.symbol
              .toUpperCase()
              .includes(keyword) ||
            item.name
              .toUpperCase()
              .includes(keyword)
        );
    }

    res.json({
      ok: true,
      count: results.length,
      results
    });
  }
);

/* =========================================================
   API：Market
========================================================= */

app.get(
  "/api/market",
  async (req, res) => {
    const symbols = [
      "^TWII",
      "^IXIC",
      "^GSPC",
      "USDTWD=X"
    ];

    const results = [];

    for (const symbol of symbols) {
      try {
        const result =
          await yahooQuote(symbol);

        results.push({
          ...result,
          displaySymbol:
            symbol
        });
      } catch {
        results.push({
          ok: false,
          symbol
        });
      }
    }

    res.json({
      ok: true,
      results
    });
  }
);

/* =========================================================
   API：Cache
========================================================= */

app.get(
  "/api/cache",
  (req, res) => {
    const quotes = {};

    for (
      const [
        key,
        item
      ] of cache.entries()
    ) {
      quotes[key] = {
        ageSeconds:
          Math.floor(
            (now() - item.time) /
              1000
          ),
        valid:
          now() - item.time <
          CACHE_TIME
      };
    }

    res.json({
      ok: true,
      cacheTimeMinutes:
        CACHE_TIME / 60000,
      historyCacheTimeMinutes:
        HISTORY_CACHE_TIME / 60000,
      quotes
    });
  }
);

/* =========================================================
   API：Status
   注意：這裡不再主動打 Yahoo
   避免 status 本身造成 429
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      server: SERVER_NAME,
      version: VERSION,
      status: "ONLINE",

      yahooFinance:
        "AVAILABLE_WITH_CACHE_AND_FALLBACK",

      alphaVantageConfigured:
        Boolean(
          ALPHA_VANTAGE_KEY
        ),

      cacheEntries:
        cache.size,

      historyCacheEntries:
        historyCache.size,

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
  }
);

/* =========================================================
   API：TW 舊版相容
========================================================= */

app.get(
  "/api/tw/quote/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const result =
      await getQuote(symbol);

    res.json(result);
  }
);

/* =========================================================
   首頁
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      server: SERVER_NAME,
      version: VERSION,
      status: "ONLINE",
      message:
        "IAN STOCK API is running."
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "API route not found"
    });
  }
);

/* =========================================================
   Error
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "IAN STOCK ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error:
        "Internal server error"
    });
  }
);

/* =========================================================
   啟動
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `${SERVER_NAME} v${VERSION} running on port ${PORT}`
    );
  }
);
