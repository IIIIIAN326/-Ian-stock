const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "";

const CACHE_TIME = 5 * 60 * 1000;
const HISTORY_CACHE_TIME = 30 * 60 * 1000;

const quoteCache = new Map();
const historyCache = new Map();
const searchCache = new Map();

/* =========================================================
   IAN STOCK
   MULTI-SOURCE DATA ENGINE
   TWSE -> Yahoo -> Stooq -> Alpha Vantage
   ========================================================= */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isTaiwanStock(symbol) {
  return /^\d{4,6}$/.test(symbol);
}

function yahooSymbol(symbol) {
  return isTaiwanStock(symbol)
    ? `${symbol}.TW`
    : symbol;
}

function stooqSymbol(symbol) {
  return isTaiwanStock(symbol)
    ? `${symbol.toLowerCase()}.tw`
    : `${symbol.toLowerCase()}.us`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rnd(v, d = 2) {
  const n = num(v);
  return n === null ? null : Number(n.toFixed(d));
}

function timeoutFetch(url, ms = 10000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    ms
  );

  return fetch(url, {
    signal: controller.signal,
    headers: {
      "User-Agent": "IAN-STOCK/1.0"
    }
  }).finally(() => {
    clearTimeout(timer);
  });
}

async function getJSON(url, ms = 10000) {
  const response = await timeoutFetch(url, ms);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

async function getText(url, ms = 10000) {
  const response = await timeoutFetch(url, ms);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

/* =========================================================
   TWSE
   台股第一來源
   ========================================================= */

function twseDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");

  return `${y}${m}01`;
}

async function twseMonth(symbol, date) {
  if (!isTaiwanStock(symbol)) {
    return [];
  }

  const url =
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY" +
    `?response=json&date=${twseDate(date)}` +
    `&stockNo=${encodeURIComponent(symbol)}`;

  try {
    const data = await getJSON(url, 12000);

    if (
      !data ||
      !Array.isArray(data.data)
    ) {
      return [];
    }

    return data.data
      .map(row => {
        const dateText = row[0] || "";

        const open = num(
          String(row[3] || "").replace(/,/g, "")
        );

        const high = num(
          String(row[4] || "").replace(/,/g, "")
        );

        const low = num(
          String(row[5] || "").replace(/,/g, "")
        );

        const close = num(
          String(row[6] || "").replace(/,/g, "")
        );

        const volume = num(
          String(row[1] || "").replace(/,/g, "")
        );

        return {
          date: dateText,
          open,
          high,
          low,
          close,
          volume
        };
      })
      .filter(row => row.close !== null);
  } catch (error) {
    return [];
  }
}

async function twseHistory(symbol, months = 12) {
  if (!isTaiwanStock(symbol)) {
    return [];
  }

  const all = [];

  const today = new Date();

  for (let i = 0; i < months; i++) {
    const d = new Date(
      today.getFullYear(),
      today.getMonth() - i,
      1
    );

    const rows = await twseMonth(
      symbol,
      d
    );

    all.push(...rows);

    if (all.length >= 250) {
      break;
    }
  }

  return all.reverse();
}

async function twseQuote(symbol) {
  const rows = await twseHistory(
    symbol,
    2
  );

  if (!rows.length) {
    return null;
  }

  const latest =
    rows[rows.length - 1];

  const previous =
    rows.length >= 2
      ? rows[rows.length - 2]
      : null;

  const previousClose =
    previous
      ? previous.close
      : null;

  const change =
    previousClose !== null
      ? latest.close - previousClose
      : null;

  const changePercent =
    previousClose !== null &&
    previousClose !== 0
      ? change / previousClose * 100
      : null;

  return {
    symbol,
    name: symbol === "2330"
      ? "台積電"
      : symbol === "2317"
        ? "鴻海"
        : symbol === "2454"
          ? "聯發科"
          : symbol === "2303"
            ? "聯電"
            : symbol === "2382"
              ? "廣達"
              : symbol,

    price: rnd(latest.close),
    previousClose: rnd(previousClose),
    change: rnd(change),
    changePercent: rnd(changePercent),

    open: rnd(latest.open),
    high: rnd(latest.high),
    low: rnd(latest.low),

    volume: latest.volume,

    currency: "TWD",
    market: "TW",

    source: "TWSE",
    dataType: "daily",
    date: latest.date,

    timestamp: new Date().toISOString()
  };
}

/* =========================================================
   YAHOO
   ========================================================= */

async function yahooQuote(symbol) {
  const ys = yahooSymbol(symbol);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?range=5d&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?range=5d&interval=1d`
  ];

  for (const url of urls) {
    try {
      const data = await getJSON(url, 8000);

      const result =
        data?.chart?.result?.[0];

      if (!result) continue;

      const meta =
        result.meta || {};

      const price =
        num(meta.regularMarketPrice) ??
        num(meta.chartPreviousClose);

      const previous =
        num(meta.previousClose) ??
        num(meta.chartPreviousClose);

      if (price === null) {
        continue;
      }

      const change =
        previous !== null
          ? price - previous
          : null;

      const changePercent =
        previous !== null &&
        previous !== 0
          ? change / previous * 100
          : null;

      return {
        symbol,
        name:
          meta.longName ||
          meta.shortName ||
          symbol,

        price: rnd(price),
        previousClose: rnd(previous),
        change: rnd(change),
        changePercent: rnd(changePercent),

        currency:
          meta.currency ||
          (isTaiwanStock(symbol)
            ? "TWD"
            : "USD"),

        market:
          isTaiwanStock(symbol)
            ? "TW"
            : "US",

        source: "Yahoo Finance",
        timestamp:
          new Date().toISOString()
      };
    } catch (error) {
      continue;
    }
  }

  return null;
}

/* =========================================================
   STOOQ
   ========================================================= */

function parseCSV(text) {
  const lines =
    text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  return lines.slice(1).map(line => {
    const p = line.split(",");

    return {
      date: p[0],
      open: num(p[1]),
      high: num(p[2]),
      low: num(p[3]),
      close: num(p[4]),
      volume: num(p[5])
    };
  });
}

async function stooqHistory(
  symbol,
  days = 365
) {
  const end = new Date();
  const start = new Date();

  start.setDate(
    start.getDate() - days
  );

  const d1 =
    start.toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

  const d2 =
    end.toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

  const url =
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(
      stooqSymbol(symbol)
    )}&d1=${d1}&d2=${d2}&i=d`;

  try {
    const text =
      await getText(url, 10000);

    return parseCSV(text)
      .filter(x => x.close !== null);
  } catch (error) {
    return [];
  }
}

async function stooqQuote(symbol) {
  const rows =
    await stooqHistory(
      symbol,
      10
    );

  if (!rows.length) {
    return null;
  }

  const latest =
    rows[rows.length - 1];

  const previous =
    rows.length >= 2
      ? rows[rows.length - 2]
      : null;

  const previousClose =
    previous
      ? previous.close
      : null;

  const change =
    previousClose !== null
      ? latest.close - previousClose
      : null;

  const changePercent =
    previousClose !== null &&
    previousClose !== 0
      ? change / previousClose * 100
      : null;

  return {
    symbol,
    name: symbol,

    price: rnd(latest.close),
    previousClose: rnd(previousClose),
    change: rnd(change),
    changePercent: rnd(changePercent),

    open: rnd(latest.open),
    high: rnd(latest.high),
    low: rnd(latest.low),

    volume: latest.volume,

    currency:
      isTaiwanStock(symbol)
        ? "TWD"
        : "USD",

    market:
      isTaiwanStock(symbol)
        ? "TW"
        : "US",

    source: "Stooq",
    dataType: "daily",
    date: latest.date,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   ALPHA VANTAGE
   ========================================================= */

async function alphaQuote(symbol) {
  if (!ALPHA_VANTAGE_KEY) {
    return null;
  }

  try {
    const url =
      "https://www.alphavantage.co/query" +
      "?function=GLOBAL_QUOTE" +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${encodeURIComponent(
        ALPHA_VANTAGE_KEY
      )}`;

    const data =
      await getJSON(url, 10000);

    const q =
      data["Global Quote"];

    if (
      !q ||
      !q["05. price"]
    ) {
      return null;
    }

    const price =
      num(q["05. price"]);

    const previous =
      num(q["08. previous close"]);

    if (price === null) {
      return null;
    }

    const change =
      previous !== null
        ? price - previous
        : null;

    const changePercent =
      previous !== null &&
      previous !== 0
        ? change / previous * 100
        : null;

    return {
      symbol,

      name: symbol,

      price: rnd(price),
      previousClose: rnd(previous),
      change: rnd(change),
      changePercent: rnd(changePercent),

      volume:
        num(q["06. volume"]),

      currency:
        isTaiwanStock(symbol)
          ? "TWD"
          : "USD",

      market:
        isTaiwanStock(symbol)
          ? "TW"
          : "US",

      source: "Alpha Vantage",

      timestamp:
        new Date().toISOString()
    };
  } catch (error) {
    return null;
  }
}

/* =========================================================
   統一報價
   ========================================================= */

async function getQuote(symbol) {
  symbol =
    cleanSymbol(symbol);

  if (!symbol) {
    return null;
  }

  const cached =
    quoteCache.get(symbol);

  if (
    cached &&
    Date.now() - cached.time <
      CACHE_TIME
  ) {
    return cached.data;
  }

  let quote = null;

  /* 台股 */
  if (isTaiwanStock(symbol)) {
    quote =
      await twseQuote(symbol);

    if (!quote) {
      quote =
        await yahooQuote(symbol);
    }

    if (!quote) {
      quote =
        await stooqQuote(symbol);
    }
  }

  /* 美股 */
  else {
    quote =
      await yahooQuote(symbol);

    if (!quote) {
      quote =
        await stooqQuote(symbol);
    }

    if (!quote) {
      quote =
        await alphaQuote(symbol);
    }
  }

  if (quote) {
    quoteCache.set(symbol, {
      time: Date.now(),
      data: quote
    });
  }

  return quote;
}

/* =========================================================
   技術指標
   ========================================================= */

function sma(values, period) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const arr =
    values.slice(-period);

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / period
  );
}

function emaSeries(values, period) {
  if (!values.length) {
    return [];
  }

  const k =
    2 / (period + 1);

  let value =
    values[0];

  const result = [
    value
  ];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    value =
      values[i] * k +
      value * (1 - k);

    result.push(value);
  }

  return result;
}

function ema(values, period) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const arr =
    emaSeries(
      values,
      period
    );

  return arr[arr.length - 1];
}

function rsi(
  values,
  period = 14
) {
  if (
    values.length <
    period + 1
  ) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i =
      values.length - period;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss += Math.abs(diff);
    }
  }

  const avgGain =
    gain / period;

  const avgLoss =
    loss / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function bollinger(
  values,
  period = 20
) {
  if (
    values.length <
    period
  ) {
    return null;
  }

  const arr =
    values.slice(-period);

  const middle =
    arr.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    arr.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - middle,
          2
        ),
      0
    ) / period;

  const sd =
    Math.sqrt(variance);

  return {
    upper:
      middle + sd * 2,
    middle,
    lower:
      middle - sd * 2
  };
}

function macd(values) {
  if (
    values.length <
    35
  ) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const e12 =
    emaSeries(values, 12);

  const e26 =
    emaSeries(values, 26);

  const series = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (i < 25) {
      series.push(null);
    } else {
      series.push(
        e12[i] - e26[i]
      );
    }
  }

  const clean =
    series.filter(
      x => x !== null
    );

  const signalSeries =
    emaSeries(clean, 9);

  const macdValue =
    clean[clean.length - 1];

  const signal =
    signalSeries[
      signalSeries.length - 1
    ];

  return {
    macd: macdValue,
    signal,
    histogram:
      macdValue -
      signal
  };
}

function atr(
  rows,
  period = 14
) {
  if (
    rows.length <
    period + 1
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {
    const c =
      rows[i];

    const p =
      rows[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high -
          p.close
        ),
        Math.abs(
          c.low -
          p.close
        )
      )
    );
  }

  return sma(
    tr,
    period
  );
}

function vwap(rows) {
  let volume = 0;
  let value = 0;

  for (const row of rows) {
    const v =
      row.volume || 0;

    const typical =
      (
        row.high +
        row.low +
        row.close
      ) / 3;

    volume += v;
    value +=
      typical * v;
  }

  return volume
    ? value / volume
    : null;
}

function supportResistance(
  values
) {
  if (!values.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    values.slice(-60);

  return {
    support:
      Math.min(...recent),

    resistance:
      Math.max(...recent)
  };
}

/* =========================================================
   HISTORY
   ========================================================= */

async function getHistory(
  symbol,
  days = 365
) {
  const key =
    `${symbol}_${days}`;

  const cached =
    historyCache.get(key);

  if (
    cached &&
    Date.now() -
      cached.time <
      HISTORY_CACHE_TIME
  ) {
    return cached.data;
  }

  let rows = [];

  /* 台股 */
  if (
    isTaiwanStock(symbol)
  ) {
    rows =
      await twseHistory(
        symbol,
        18
      );

    if (
      rows.length <
      30
    ) {
      const yahooRows =
        await yahooHistory(
          symbol
        );

      if (
        yahooRows.length >
        rows.length
      ) {
        rows =
          yahooRows;
      }
    }
  }

  /* 美股 */
  else {
    rows =
      await stooqHistory(
        symbol,
        days
      );

    if (!rows.length) {
      rows =
        await yahooHistory(
          symbol
        );
    }
  }

  historyCache.set(key, {
    time: Date.now(),
    data: rows
  });

  return rows;
}

/* =========================================================
   YAHOO HISTORY
   ========================================================= */

async function yahooHistory(
  symbol
) {
  try {
    const ys =
      yahooSymbol(symbol);

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ys
      )}?range=1y&interval=1d`;

    const data =
      await getJSON(
        url,
        10000
      );

    const result =
      data?.chart?.result?.[0];

    if (!result) {
      return [];
    }

    const timestamps =
      result.timestamp || [];

    const q =
      result.indicators
        ?.quote?.[0];

    if (!q) {
      return [];
    }

    return timestamps
      .map((ts, i) => ({
        date:
          new Date(
            ts * 1000
          )
            .toISOString()
            .slice(0, 10),

        open:
          num(q.open?.[i]),

        high:
          num(q.high?.[i]),

        low:
          num(q.low?.[i]),

        close:
          num(q.close?.[i]),

        volume:
          num(q.volume?.[i])
      }))
      .filter(
        x => x.close !== null
      );
  } catch (error) {
    return [];
  }
}

/* =========================================================
   AI TECHNICAL ANALYSIS
   ========================================================= */

function buildAnalysis(
  symbol,
  rows,
  quote
) {
  if (!rows.length) {
    return {
      symbol,
      status: "NO_DATA",
      score: null,
      trend: "待資料",
      momentum: "待資料",
      fundamental:
        "待財報資料",
      sentiment:
        "待市場情緒資料",
      valuation:
        "待估值資料",
      risk: "資料不足",
      reasons: [],
      risks: [],
      catalysts: []
    };
  }

  const closes =
    rows
      .map(x => x.close)
      .filter(
        x => x !== null
      );

  const price =
    quote?.price ??
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

  const rsiValue =
    rsi(closes);

  const macdValue =
    macd(closes);

  const bb =
    bollinger(closes);

  const sr =
    supportResistance(
      closes
    );

  const atrValue =
    atr(rows);

  const vwapValue =
    vwap(rows);

  let score = 50;

  const reasons = [];
  const risks = [];

  if (
    ma5 !== null &&
    ma20 !== null &&
    price > ma5 &&
    ma5 > ma20
  ) {
    score += 12;
    reasons.push(
      "短期均線偏多"
    );
  }

  if (
    ma20 !== null &&
    ma60 !== null &&
    price > ma20 &&
    ma20 > ma60
  ) {
    score += 12;
    reasons.push(
      "中期均線偏多"
    );
  }

  if (
    rsiValue !== null &&
    rsiValue >= 50 &&
    rsiValue <= 70
  ) {
    score += 6;
    reasons.push(
      "RSI 位於相對強勢區"
    );
  }

  if (
    macdValue.macd !== null &&
    macdValue.signal !== null &&
    macdValue.macd >
      macdValue.signal
  ) {
    score += 8;
    reasons.push(
      "MACD 偏多"
    );
  }

  if (
    rsiValue !== null &&
    rsiValue > 75
  ) {
    score -= 8;
    risks.push(
      "RSI 偏高"
    );
  }

  if (
    ma20 !== null &&
    price < ma20
  ) {
    risks.push(
      "價格低於 MA20"
    );
  }

  if (
    sr.resistance !== null &&
    price >=
      sr.resistance * 0.98
  ) {
    risks.push(
      "接近近期壓力"
    );
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  let trend =
    "中性";

  if (
    ma20 !== null &&
    ma60 !== null
  ) {
    if (
      price > ma20 &&
      ma20 > ma60
    ) {
      trend =
        "偏多";
    } else if (
      price < ma20 &&
      ma20 < ma60
    ) {
      trend =
        "偏空";
    }
  }

  let momentum =
    "中性";

  if (
    rsiValue !== null
  ) {
    if (
      rsiValue >= 55
    ) {
      momentum =
        "偏強";
    } else if (
      rsiValue <= 45
    ) {
      momentum =
        "偏弱";
    }
  }

  return {
    symbol,
    status: "OK",
    score,

    trend,
    momentum,

    fundamental:
      "需要搭配公司財報判斷",

    sentiment:
      "需要搭配新聞與市場情緒判斷",

    valuation:
      "需要搭配 EPS、本益比等資料判斷",

    risk:
      risks.length
        ? risks.join("；")
        : "目前技術面未發現明顯警訊",

    reasons,

    risks,

    catalysts: [
      "觀察成交量",
      "觀察 MA20",
      "觀察 MA60",
      "觀察 RSI",
      "觀察 MACD"
    ],

    indicators: {
      price: rnd(price),
      ma5: rnd(ma5),
      ma20: rnd(ma20),
      ma60: rnd(ma60),

      ema12: rnd(ema12),
      ema26: rnd(ema26),

      rsi: rnd(rsiValue),

      macd:
        rnd(macdValue.macd),

      macdSignal:
        rnd(macdValue.signal),

      macdHistogram:
        rnd(
          macdValue.histogram
        ),

      bollingerUpper:
        rnd(bb?.upper),

      bollingerMiddle:
        rnd(bb?.middle),

      bollingerLower:
        rnd(bb?.lower),

      atr:
        rnd(atrValue),

      vwap:
        rnd(vwapValue),

      support:
        rnd(sr.support),

      resistance:
        rnd(sr.resistance),

      volume:
        rows[
          rows.length - 1
        ]?.volume || null
    },

    disclaimer:
      "IAN AI 僅提供資訊與技術分析，不代表投資建議，也不保證獲利。"
  };
}

/* =========================================================
   STOCK LIST
   ========================================================= */

const TW_STOCKS = [
  ["2330", "台積電"],
  ["2317", "鴻海"],
  ["2454", "聯發科"],
  ["2303", "聯電"],
  ["2382", "廣達"],
  ["2308", "台達電"],
  ["3231", "緯創"],
  ["3034", "聯詠"]
];

const US_STOCKS = [
  ["AAPL", "Apple"],
  ["NVDA", "NVIDIA"],
  ["MSFT", "Microsoft"],
  ["AMZN", "Amazon"],
  ["GOOGL", "Alphabet"],
  ["META", "Meta"],
  ["TSLA", "Tesla"]
];

/* =========================================================
   STATUS
   ========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      server:
        "IAN STOCK API",

      version:
        "8.0.0",

      status:
        "ONLINE",

      dataSources: {
        TWSE:
          "ENABLED",

        Yahoo:
          "ENABLED",

        Stooq:
          "ENABLED",

        AlphaVantage:
          ALPHA_VANTAGE_KEY
            ? "CONFIGURED"
            : "NOT_CONFIGURED"
      },

      yahooFinance:
        "AVAILABLE_WITH_FALLBACK",

      alphaVantageConfigured:
        Boolean(
          ALPHA_VANTAGE_KEY
        ),

      cacheEntries:
        quoteCache.size,

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
      ]
    });
  }
);

/* =========================================================
   QUOTES
   ========================================================= */

app.get(
  "/api/quotes",
  async (req, res) => {
    try {
      let symbols = [];

      if (
        req.query.symbols
      ) {
        symbols =
          String(
            req.query.symbols
          )
            .split(",")
            .map(cleanSymbol)
            .filter(Boolean);
      }

      if (!symbols.length) {
        symbols =
          TW_STOCKS.map(
            x => x[0]
          );
      }

      const results = [];

      /*
       * Promise.allSettled
       * 一支股票失敗
       * 不會讓全部失敗
       */

      const responses =
        await Promise.allSettled(
          symbols.map(
            symbol =>
              getQuote(symbol)
          )
        );

      responses.forEach(
        (result, index) => {
          const symbol =
            symbols[index];

          if (
            result.status ===
              "fulfilled" &&
            result.value
          ) {
            results.push(
              result.value
            );
          } else {
            results.push({
              symbol,
              name: symbol,
              price: null,
              previousClose:
                null,
              change: null,
              changePercent:
                null,
              source: null,
              status:
                "NO_DATA"
            });
          }
        }
      );

      res.json(results);

    } catch (error) {
      res.json([]);
    }
  }
);

/* =========================================================
   SINGLE QUOTE
   ========================================================= */

app.get(
  "/api/quote/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    try {
      const quote =
        await getQuote(symbol);

      if (!quote) {
        return res.json({
          symbol,
          status:
            "NO_DATA",
          price: null
        });
      }

      res.json(quote);

    } catch (error) {
      res.json({
        symbol,
        status:
          "NO_DATA",
        price: null
      });
    }
  }
);

/* =========================================================
   HISTORY
   ========================================================= */

app.get(
  "/api/history/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    try {
      const days =
        Math.min(
          Math.max(
            Number(
              req.query.days
            ) || 365,
            30
          ),
          2000
        );

      const data =
        await getHistory(
          symbol,
          days
        );

      res.json({
        symbol,
        count:
          data.length,
        data
      });

    } catch (error) {
      res.json({
        symbol,
        count: 0,
        data: []
      });
    }
  }
);

/* =========================================================
   ANALYSIS
   ========================================================= */

app.get(
  "/api/analysis/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    try {
      const [
        quote,
        history
      ] =
        await Promise.all([
          getQuote(symbol),
          getHistory(
            symbol,
            365
          )
        ]);

      res.json(
        buildAnalysis(
          symbol,
          history,
          quote
        )
      );

    } catch (error) {
      res.json({
        symbol,
        status:
          "NO_DATA",
        score: null
      });
    }
  }
);

/* =========================================================
   STOCK
   ========================================================= */

app.get(
  "/api/stock/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    try {
      const [
        quote,
        history
      ] =
        await Promise.all([
          getQuote(symbol),
          getHistory(
            symbol,
            365
          )
        ]);

      res.json({
        symbol,
        quote,
        history,
        analysis:
          buildAnalysis(
            symbol,
            history,
            quote
          ),
        updatedAt:
          new Date().toISOString()
      });

    } catch (error) {
      res.json({
        symbol,
        quote: null,
        history: [],
        analysis: {
          status:
            "NO_DATA"
        }
      });
    }
  }
);

/* =========================================================
   SEARCH
   ========================================================= */

app.get(
  "/api/search",
  (req, res) => {
    const q =
      String(
        req.query.q || ""
      )
        .trim()
        .toLowerCase();

    if (!q) {
      return res.json([]);
    }

    const all = [
      ...TW_STOCKS.map(
        x => ({
          symbol: x[0],
          name: x[1],
          market: "TW"
        })
      ),

      ...US_STOCKS.map(
        x => ({
          symbol: x[0],
          name: x[1],
          market: "US"
        })
      )
    ];

    const result =
      all.filter(
        item =>
          item.symbol
            .toLowerCase()
            .includes(q) ||
          item.name
            .toLowerCase()
            .includes(q)
      );

    res.json(result);
  }
);

/* =========================================================
   MARKET
   ========================================================= */

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const symbols = [
        "2330",
        "2317",
        "2454",
        "2303",
        "2382",
        "2308",
        "3231",
        "AAPL",
        "NVDA",
        "MSFT",
        "TSLA"
      ];

      const results =
        await Promise.allSettled(
          symbols.map(
            symbol =>
              getQuote(symbol)
          )
        );

      const data =
        results
          .map(
            (r, i) =>
              r.status ===
                "fulfilled"
                ? r.value
                : null
          )
          .filter(Boolean);

      res.json({
        status:
          "OK",

        updatedAt:
          new Date().toISOString(),

        data
      });

    } catch (error) {
      res.json({
        status:
          "PARTIAL",
        data: []
      });
    }
  }
);

/* =========================================================
   CACHE
   ========================================================= */

app.get(
  "/api/cache",
  (req, res) => {
    res.json({
      quoteCache:
        quoteCache.size,

      historyCache:
        historyCache.size,

      searchCache:
        searchCache.size,

      time:
        new Date().toISOString()
    });
  }
);

app.post(
  "/api/cache/clear",
  (req, res) => {
    quoteCache.clear();
    historyCache.clear();
    searchCache.clear();

    res.json({
      status:
        "CLEARED"
    });
  }
);

/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      error:
        "NOT_FOUND"
    });
  }
);

/* =========================================================
   ERROR
   ========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(500).json({
      error:
        "SERVER_ERROR"
    });
  }
);

/* =========================================================
   START
   ========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "================================"
    );

    console.log(
      "IAN STOCK API"
    );

    console.log(
      "VERSION 8.0.0"
    );

    console.log(
      `PORT ${PORT}`
    );

    console.log(
      "TWSE: ENABLED"
    );

    console.log(
      "YAHOO: ENABLED"
    );

    console.log(
      "STOOQ: ENABLED"
    );

    console.log(
      "ALPHA VANTAGE:",
      ALPHA_VANTAGE_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "================================"
    );
  }
);
