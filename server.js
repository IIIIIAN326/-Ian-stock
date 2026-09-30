const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALPHA_KEY = process.env.ALPHA_VANTAGE_KEY || "";

const CACHE = new Map();
const HISTORY_CACHE = new Map();

const QUOTE_TTL = 5 * 1000;
const HISTORY_TTL = 60 * 1000;

const NAME = {
  "2330": "台積電",
  "2317": "鴻海",
  "2454": "聯發科",
  "2303": "聯電",
  "2382": "廣達",
  "3711": "日月光投控",
  "2881": "富邦金",
  "2882": "國泰金",
  "2603": "長榮",
  "2618": "長榮航",
  "3231": "緯創",
  "2357": "華碩",
  "6669": "緯穎",
  "3017": "奇鋐",
  "3034": "聯詠",
  "3037": "欣興",
  "2308": "台達電",
  "3008": "大立光",
  "2379": "瑞昱",
  "2327": "國巨",
  "2412": "中華電",
  "2891": "中信金",
  "2892": "第一金",
  "1301": "台塑",
  "1303": "南亞",
  "2002": "中鋼",
  "2207": "和泰車",
  "1216": "統一",
  "3045": "台灣大",
  "4938": "和碩",
  "3661": "世芯-KY",
  "6488": "環球晶",
  "5269": "祥碩",
  "8046": "南電",
  "6515": "穎崴",
  "2376": "技嘉",
  "2377": "微星",
  "2385": "群光",
  "2353": "宏碁",
  "2395": "研華",

  "NVDA": "NVIDIA",
  "AAPL": "Apple",
  "MSFT": "Microsoft",
  "AMZN": "Amazon",
  "GOOGL": "Alphabet",
  "META": "Meta Platforms",
  "TSLA": "Tesla",
  "AMD": "AMD",
  "AVGO": "Broadcom",
  "NFLX": "Netflix",
  "AMAT": "Applied Materials",
  "MU": "Micron",
  "QCOM": "Qualcomm",
  "INTC": "Intel",
  "ORCL": "Oracle",
  "CRM": "Salesforce",
  "PLTR": "Palantir",
  "JPM": "JPMorgan",
  "BAC": "Bank of America",
  "V": "Visa",
  "MA": "Mastercard",
  "WMT": "Walmart",
  "COST": "Costco",
  "XOM": "Exxon Mobil",
  "CVX": "Chevron",
  "UNH": "UnitedHealth",
  "KO": "Coca-Cola",
  "PEP": "PepsiCo",
  "DIS": "Disney",
  "TSM": "TSMC ADR",
  "ASML": "ASML"
};

function normSymbol(s) {
  return String(s || "").trim().toUpperCase();
}

function isTaiwan(s) {
  return /^\d{4}$/.test(s);
}

function yahooSymbol(s) {
  s = normSymbol(s);
  return isTaiwan(s) ? s + ".TW" : s;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSON(url, timeoutMs = 12000) {

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "IAN-STOCK/14.0",
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}

/* =====================================================
   YAHOO QUOTE
===================================================== */

function quoteFromYahoo(symbol, json) {

  const meta = json?.chart?.result?.[0]?.meta;

  if (!meta) return null;

  const price = Number(
    meta.regularMarketPrice ??
    meta.previousClose
  );

  const previousClose = Number(
    meta.chartPreviousClose ??
    meta.previousClose
  );

  if (!Number.isFinite(price)) {
    return null;
  }

  let change = null;
  let changePct = null;

  if (
    Number.isFinite(previousClose) &&
    previousClose !== 0
  ) {

    change = price - previousClose;

    changePct =
      change /
      previousClose *
      100;

  }

  return {

    symbol,

    name:
      NAME[symbol] ||
      meta.longName ||
      meta.shortName ||
      symbol,

    market:
      isTaiwan(symbol)
        ? "TW"
        : "US",

    price,

    previousClose:
      Number.isFinite(previousClose)
        ? previousClose
        : null,

    change,

    changePct,

    currency:
      meta.currency ||
      (isTaiwan(symbol) ? "TWD" : "USD"),

    exchange:
      meta.exchangeName ||
      meta.fullExchangeName ||
      "",

    timestamp:
      meta.regularMarketTime
        ? meta.regularMarketTime * 1000
        : Date.now(),

    volume:
      Number(meta.regularMarketVolume) || 0,

    source: "Yahoo Finance"

  };
}

async function yahooQuote(symbol) {

  const key = "quote:" + symbol;

  const cached = CACHE.get(key);

  if (
    cached &&
    Date.now() - cached.time < QUOTE_TTL
  ) {
    return cached.value;
  }

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol(symbol)) +
    "?range=5d&interval=1d&events=div%2Csplits";

  const json = await fetchJSON(url);

  const quote =
    quoteFromYahoo(symbol, json);

  if (!quote) {
    throw new Error("Yahoo 沒有行情");
  }

  CACHE.set(key, {
    time: Date.now(),
    value: quote
  });

  return quote;
}

/* =====================================================
   ALPHA VANTAGE FALLBACK
===================================================== */

async function alphaQuote(symbol) {

  if (
    !ALPHA_KEY ||
    isTaiwan(symbol)
  ) {
    return null;
  }

  try {

    const url =
      "https://www.alphavantage.co/query" +
      "?function=GLOBAL_QUOTE" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&apikey=" +
      encodeURIComponent(ALPHA_KEY);

    const json = await fetchJSON(url);

    const q = json?.["Global Quote"];

    if (!q || !q["05. price"]) {
      return null;
    }

    const price = Number(q["05. price"]);

    const previousClose =
      Number(q["08. previous close"]);

    const changePct =
      Number(
        String(
          q["10. change percent"] || ""
        ).replace("%", "")
      );

    return {

      symbol,

      name:
        NAME[symbol] ||
        symbol,

      market: "US",

      price,

      previousClose,

      change:
        Number.isFinite(previousClose)
          ? price - previousClose
          : null,

      changePct:
        Number.isFinite(changePct)
          ? changePct
          : null,

      currency: "USD",

      timestamp: Date.now(),

      volume:
        Number(q["06. volume"]) || 0,

      source: "Alpha Vantage"

    };

  } catch {

    return null;

  }
}

/* =====================================================
   GET QUOTE
===================================================== */

async function getQuote(symbol) {

  symbol = normSymbol(symbol);

  try {

    return await yahooQuote(symbol);

  } catch (error) {

    const fallback =
      await alphaQuote(symbol);

    if (fallback) {
      return fallback;
    }

    throw error;
  }
}

/* =====================================================
   HISTORY
===================================================== */

async function history(
  symbol,
  range = "3mo",
  interval = "1d"
) {

  symbol = normSymbol(symbol);

  const key =
    `history:${symbol}:${range}:${interval}`;

  const cached =
    HISTORY_CACHE.get(key);

  if (
    cached &&
    Date.now() - cached.time < HISTORY_TTL
  ) {
    return cached.value;
  }

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol(symbol)) +
    "?range=" +
    encodeURIComponent(range) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&events=div%2Csplits";

  const json =
    await fetchJSON(url);

  const result =
    json?.chart?.result?.[0];

  if (!result) {
    throw new Error("沒有歷史資料");
  }

  const quote =
    result.indicators?.quote?.[0] || {};

  const timestamps =
    result.timestamp || [];

  const output = [];

  for (
    let i = 0;
    i < timestamps.length;
    i++
  ) {

    const close =
      Number(quote.close?.[i]);

    if (!Number.isFinite(close)) {
      continue;
    }

    output.push({

      time:
        timestamps[i] * 1000,

      open:
        Number(quote.open?.[i]) || null,

      high:
        Number(quote.high?.[i]) || null,

      low:
        Number(quote.low?.[i]) || null,

      close,

      volume:
        Number(quote.volume?.[i]) || 0

    });

  }

  HISTORY_CACHE.set(key, {
    time: Date.now(),
    value: output
  });

  return output;
}

/* =====================================================
   TECHNICAL INDICATORS
===================================================== */

function sma(values, period) {

  if (values.length < period) {
    return null;
  }

  const data =
    values.slice(-period);

  return (
    data.reduce(
      (a, b) => a + b,
      0
    ) / period
  );
}

function emaSeries(values, period) {

  if (values.length < period) {
    return [];
  }

  const multiplier =
    2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  const result = [ema];

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      values[i] *
      multiplier +
      ema *
      (1 - multiplier);

    result.push(ema);
  }

  return result;
}

function calculateRSI(
  values,
  period = 14
) {

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
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
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
      values[i] -
      values[i - 1];

    avgGain =
      (
        avgGain *
        (period - 1) +
        Math.max(diff, 0)
      ) / period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
        Math.max(-diff, 0)
      ) / period;

  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 -
    100 /
    (1 + rs);
}

function calculateATR(
  candles,
  period = 14
) {

  if (
    candles.length <
    period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

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

    trueRanges.push(tr);

  }

  const data =
    trueRanges.slice(-period);

  return (
    data.reduce(
      (a, b) => a + b,
      0
    ) / data.length
  );
}

function calculateIndicators(
  candles
) {

  const closes =
    candles.map(
      x => x.close
    );

  const volumes =
    candles.map(
      x => x.volume || 0
    );

  const MA5 =
    sma(closes, 5);

  const MA20 =
    sma(closes, 20);

  const MA60 =
    sma(closes, 60);

  const EMA12 =
    emaSeries(
      closes,
      12
    );

  const EMA26 =
    emaSeries(
      closes,
      26
    );

  const ema12 =
    EMA12.length
      ? EMA12[EMA12.length - 1]
      : null;

  const ema26 =
    EMA26.length
      ? EMA26[EMA26.length - 1]
      : null;

  const macd =
    ema12 !== null &&
    ema26 !== null
      ? ema12 - ema26
      : null;

  let bollinger = null;

  if (closes.length >= 20) {

    const data =
      closes.slice(-20);

    const middle =
      data.reduce(
        (a, b) => a + b,
        0
      ) / 20;

    const variance =
      data.reduce(
        (sum, value) =>
          sum +
          Math.pow(
            value - middle,
            2
          ),
        0
      ) / 20;

    const standardDeviation =
      Math.sqrt(variance);

    bollinger = {

      middle,

      upper:
        middle +
        standardDeviation * 2,

      lower:
        middle -
        standardDeviation * 2

    };

  }

  const totalVolume =
    volumes.reduce(
      (a, b) => a + b,
      0
    );

  const vwap =
    totalVolume > 0
      ? candles.reduce(
          (sum, c) =>
            sum +
            (
              (c.high +
               c.low +
               c.close) / 3
            ) *
            (c.volume || 0),
          0
        ) / totalVolume
      : null;

  const recent =
    closes.slice(-20);

  return {

    MA5,

    MA20,

    MA60,

    EMA12: ema12,

    EMA26: ema26,

    RSI:
      calculateRSI(closes),

    MACD: {
      macd,

      signal: null,

      histogram: null

    },

    Bollinger:
      bollinger,

    ATR:
      calculateATR(candles),

    VWAP:
      vwap,

    volume:
      volumes.length
        ? volumes[volumes.length - 1]
        : 0,

    Support:
      recent.length
        ? Math.min(...recent)
        : null,

    Resistance:
      recent.length
        ? Math.max(...recent)
        : null

  };
}

/* =====================================================
   AI ANALYSIS
===================================================== */

function createAnalysis(
  indicators,
  current
) {

  let score = 50;

  let trend = "資料不足";

  let momentum = "資料不足";

  let risk = "資料不足";

  if (
    Number.isFinite(current) &&
    Number.isFinite(indicators.MA20)
  ) {

    if (
      current >
      indicators.MA20
    ) {

      score += 10;

      trend = "偏多";

    } else {

      score -= 10;

      trend = "偏弱";

    }

    if (
      Number.isFinite(
        indicators.MA60
      ) &&
      current >
      indicators.MA60
    ) {

      score += 8;

    }

    if (
      Number.isFinite(
        indicators.RSI
      )
    ) {

      if (
        indicators.RSI > 55 &&
        indicators.RSI < 70
      ) {

        score += 8;

        momentum = "偏強";

      } else if (
        indicators.RSI >= 70
      ) {

        score -= 5;

        momentum = "高檔";

      } else if (
        indicators.RSI < 40
      ) {

        score -= 3;

        momentum = "偏弱";

      } else {

        momentum = "中性";

      }

    }

    if (
      indicators.ATR &&
      current
    ) {

      risk =
        indicators.ATR /
        current >
        0.04
          ? "波動偏高"
          : "一般";

    }

  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(score)
      )
    );

  return {

    current,

    MA5:
      indicators.MA5,

    MA20:
      indicators.MA20,

    MA60:
      indicators.MA60,

    EMA12:
      indicators.EMA12,

    EMA26:
      indicators.EMA26,

    RSI:
      indicators.RSI,

    MACD:
      indicators.MACD,

    Bollinger:
      indicators.Bollinger,

    ATR:
      indicators.ATR,

    VWAP:
      indicators.VWAP,

    Support:
      indicators.Support,

    Resistance:
      indicators.Resistance,

    trend,

    momentum,

    risk,

    score,

    dataPoints:
      indicators
        ? 1
        : 0,

    disclaimer:
      "IAN AI Score 為資訊整理與技術指標計算，不構成投資建議。"

  };

}

/* =====================================================
   STOCK
===================================================== */

async function getStock(symbol) {

  symbol =
    normSymbol(symbol);

  const quote =
    await getQuote(symbol);

  const candles =
    await history(
      symbol,
      "1y",
      "1d"
    );

  const indicators =
    calculateIndicators(
      candles
    );

  const analysis =
    createAnalysis(
      indicators,
      quote.price
    );

  return {

    symbol,

    quote,

    history:
      candles,

    analysis

  };

}

/* =====================================================
   API STATUS
===================================================== */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      server:
        "IAN STOCK API",

      version:
        "14.0.0",

      status:
        "ONLINE",

      yahooFinance:
        "AVAILABLE",

      alphaVantageConfigured:
        Boolean(ALPHA_KEY),

      quoteRefresh:
        "5 seconds cache",

      cacheEntries:
        CACHE.size,

      historyCacheEntries:
        HISTORY_CACHE.size,

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

        "/api/status"

      ],

      note:
        "API keys are never returned."

    });

  }
);

/* =====================================================
   SINGLE QUOTE
===================================================== */

app.get(
  "/api/quote/:symbol",
  async (req, res) => {

    try {

      const quote =
        await getQuote(
          req.params.symbol
        );

      res.json({

        quote,

        data:
          quote

      });

    } catch (error) {

      res
        .status(502)
        .json({

          error:
            "行情來源暫時無法取得",

          detail:
            error.message

        });

    }

  }
);

/* =====================================================
   MULTIPLE QUOTES
===================================================== */

app.get(
  "/api/quotes",
  async (req, res) => {

    const symbols =
      String(
        req.query.symbols ||
        "2330,2317,2454,NVDA,AAPL,MSFT"
      )
      .split(",")
      .map(normSymbol)
      .filter(Boolean)
      .slice(0, 40);

    const output = [];

    for (
      const symbol of symbols
    ) {

      try {

        const quote =
          await getQuote(symbol);

        if (quote) {
          output.push(quote);
        }

      } catch {

      }

      /*
       * 避免一次大量請求
       */

      await sleep(80);

    }

    res.json({

      data:
        output,

      requested:
        symbols.length,

      returned:
        output.length,

      timestamp:
        Date.now()

    });

  }
);

/* =====================================================
   HISTORY
===================================================== */

app.get(
  "/api/history/:symbol",
  async (req, res) => {

    try {

      const range =
        req.query.range ||
        "3mo";

      const interval =
        req.query.interval ||
        "1d";

      const data =
        await history(
          req.params.symbol,
          range,
          interval
        );

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        data,

        range,

        interval

      });

    } catch (error) {

      res
        .status(502)
        .json({

          error:
            "歷史資料暫時無法取得",

          detail:
            error.message

        });

    }

  }
);

/* =====================================================
   ANALYSIS
===================================================== */

app.get(
  "/api/analysis/:symbol",
  async (req, res) => {

    try {

      const quote =
        await getQuote(
          req.params.symbol
        );

      const candles =
        await history(
          req.params.symbol,
          "1y",
          "1d"
        );

      const indicators =
        calculateIndicators(
          candles
        );

      const analysis =
        createAnalysis(
          indicators,
          quote.price
        );

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        analysis

      });

    } catch (error) {

      res
        .status(502)
        .json({

          error:
            "技術分析暫時無法取得",

          detail:
            error.message

        });

    }

  }
);

/* =====================================================
   FULL STOCK DATA
===================================================== */

app.get(
  "/api/stock/:symbol",
  async (req, res) => {

    try {

      const result =
        await getStock(
          req.params.symbol
        );

      res.json(result);

    } catch (error) {

      res
        .status(502)
        .json({

          error:
            "股票資料暫時無法取得",

          detail:
            error.message

        });

    }

  }
);

/* =====================================================
   SEARCH
===================================================== */

app.get(
  "/api/search",
  async (req, res) => {

    const query =
      String(
        req.query.q || ""
      ).trim();

    if (!query) {

      return res.json({
        data: []
      });

    }

    try {

      const url =
        "https://query1.finance.yahoo.com/v1/finance/search" +
        "?q=" +
        encodeURIComponent(query) +
        "&quotesCount=20" +
        "&newsCount=0";

      const json =
        await fetchJSON(url);

      const data =
        (json.quotes || [])
          .filter(
            item =>
              item.quoteType === "EQUITY" ||
              item.quoteType === "ETF"
          )
          .map(
            item => ({

              symbol:
                item.symbol,

              name:
                item.longname ||
                item.shortname ||
                item.symbol,

              market:
                item.exchange === "TAI"
                  ? "TW"
                  : "US"

            })
          );

      res.json({
        data
      });

    } catch (error) {

      res
        .status(502)
        .json({

          error:
            "搜尋來源暫時無法取得",

          detail:
            error.message

        });

    }

  }
);

/* =====================================================
   MARKET INDICES
===================================================== */

async function marketIndex(
  symbol,
  name
) {

  try {

    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=5d&interval=1d";

    const json =
      await fetchJSON(url);

    const meta =
      json?.chart?.result?.[0]?.meta;

    if (
      !meta ||
      meta.regularMarketPrice == null
    ) {

      return null;

    }

    const price =
      Number(
        meta.regularMarketPrice
      );

    const previous =
      Number(
        meta.chartPreviousClose ??
        meta.previousClose
      );

    return {

      symbol,

      name,

      price,

      previousClose:
        previous,

      change:
        Number.isFinite(previous)
          ? price - previous
          : null,

      changePct:
        Number.isFinite(previous) &&
        previous
          ? (
              (price - previous) /
              previous *
              100
            )
          : null,

      timestamp:
        meta.regularMarketTime
          ? meta.regularMarketTime *
            1000
          : Date.now()

    };

  } catch {

    return null;

  }

}

app.get(
  "/api/market",
  async (req, res) => {

    const symbols = [

      ["^TWII", "加權指數"],

      ["^GSPC", "S&P 500"],

      ["^IXIC", "NASDAQ"],

      ["^DJI", "Dow Jones"]

    ];

    const data = [];

    for (
      const [symbol, name]
      of symbols
    ) {

      const result =
        await marketIndex(
          symbol,
          name
        );

      if (result) {
        data.push(result);
      }

    }

    res.json({

      data,

      timestamp:
        Date.now()

    });

  }
);

/* =====================================================
   CACHE
===================================================== */

app.get(
  "/api/cache",
  (req, res) => {

    res.json({

      quoteCache:
        CACHE.size,

      historyCache:
        HISTORY_CACHE.size,

      timestamp:
        Date.now()

    });

  }
);

/* =====================================================
   STATIC FRONTEND
===================================================== */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.get(
  "*",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }
);

/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      "================================="
    );

    console.log(
      "IAN STOCK API 14.0.0"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "Yahoo Finance: ENABLED"
    );

    console.log(
      "Alpha Vantage:",
      ALPHA_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "================================="
    );

  }
);
