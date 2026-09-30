const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const VERSION = "4.0.0";
const SERVER_NAME = "IAN STOCK API";

const CACHE_TIME = 15 * 60 * 1000;

const quoteCache = {};
const historyCache = {};
const marketCache = {};


/* =====================================================
   BASIC
===================================================== */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}

function yahooSymbol(symbol) {
  symbol = cleanSymbol(symbol);

  if (/^\d{4}$/.test(symbol)) {
    return symbol + ".TW";
  }

  return symbol;
}

function round(value, digits = 2) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
}

function getCache(cache, key) {
  const item = cache[key];

  if (!item) return null;

  const age = Date.now() - item.time;

  if (age < CACHE_TIME) {
    return {
      ...item.data,
      cached: true,
      cacheAgeSeconds: Math.floor(age / 1000)
    };
  }

  return null;
}

function saveCache(cache, key, data) {
  cache[key] = {
    time: Date.now(),
    data
  };
}


/* =====================================================
   YAHOO FINANCE
===================================================== */

async function yahooChart(
  symbol,
  range = "1y",
  interval = "1d"
) {
  const ySymbol = yahooSymbol(symbol);

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=" +
    encodeURIComponent(range) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&events=div%2Csplits";

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 IAN-STOCK"
    }
  });

  if (!response.ok) {
    throw new Error(
      "Yahoo Finance HTTP " + response.status
    );
  }

  const data = await response.json();

  if (
    !data ||
    !data.chart ||
    !data.chart.result ||
    !data.chart.result[0]
  ) {
    throw new Error(
      "Yahoo Finance returned no data"
    );
  }

  return data.chart.result[0];
}


/* =====================================================
   ALPHA VANTAGE BACKUP
===================================================== */

async function alphaQuote(symbol) {
  const key =
    process.env.ALPHA_VANTAGE_KEY;

  if (!key) return null;

  const url =
    "https://www.alphavantage.co/query" +
    "?function=GLOBAL_QUOTE" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&apikey=" +
    encodeURIComponent(key);

  try {
    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();

    const q = data["Global Quote"];

    if (!q || !q["05. price"]) {
      return null;
    }

    return {
      ok: true,
      symbol,
      price: Number(q["05. price"]),
      change: Number(q["09. change"] || 0),
      changePct: Number(
        String(q["10. change percent"] || "")
          .replace("%", "")
      ),
      volume: Number(q["06. volume"] || 0),
      latestTradingDay:
        q["07. latest trading day"] || null,
      source: "Alpha Vantage"
    };
  } catch {
    return null;
  }
}


/* =====================================================
   MOVING AVERAGE
===================================================== */

function MA(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  const data =
    values.slice(-period);

  return round(
    data.reduce((a, b) => a + b, 0) /
    period
  );
}


/* =====================================================
   EMA
===================================================== */

function EMA(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      ((values[i] - ema) * multiplier) +
      ema;
  }

  return round(ema);
}


/* =====================================================
   RSI
===================================================== */

function RSI(values, period = 14) {
  if (!values || values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const g =
      change > 0 ? change : 0;

    const l =
      change < 0 ? Math.abs(change) : 0;

    avgGain =
      ((avgGain * (period - 1)) + g) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + l) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return round(
    100 - 100 / (1 + rs)
  );
}


/* =====================================================
   MACD
===================================================== */

function MACD(values) {
  if (!values || values.length < 35) {
    return null;
  }

  const ema12 = EMA(values, 12);
  const ema26 = EMA(values, 26);

  if (
    ema12 === null ||
    ema26 === null
  ) {
    return null;
  }

  const macd =
    ema12 - ema26;

  return {
    macd: round(macd),
    signal: null,
    histogram: null
  };
}


/* =====================================================
   BOLLINGER
===================================================== */

function Bollinger(
  values,
  period = 20,
  multiplier = 2
) {
  if (!values || values.length < period) {
    return null;
  }

  const data =
    values.slice(-period);

  const mean =
    data.reduce((a, b) => a + b, 0) /
    period;

  const variance =
    data.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - mean, 2),
      0
    ) / period;

  const sd =
    Math.sqrt(variance);

  return {
    middle: round(mean),
    upper: round(
      mean + multiplier * sd
    ),
    lower: round(
      mean - multiplier * sd
    )
  };
}


/* =====================================================
   ATR
===================================================== */

function ATR(rows, period = 14) {
  if (!rows || rows.length <= period) {
    return null;
  }

  const tr = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    const high = Number(current.high);
    const low = Number(current.low);
    const previousClose =
      Number(previous.close);

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  if (tr.length < period) {
    return null;
  }

  return round(
    tr.slice(-period)
      .reduce((a, b) => a + b, 0) /
    period
  );
}


/* =====================================================
   VWAP
===================================================== */

function VWAP(rows) {
  if (!rows || rows.length === 0) {
    return null;
  }

  const recent =
    rows.slice(-60);

  let pv = 0;
  let volume = 0;

  for (const row of recent) {
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const vol = Number(row.volume || 0);

    const typical =
      (high + low + close) / 3;

    pv += typical * vol;
    volume += vol;
  }

  if (volume === 0) {
    return null;
  }

  return round(
    pv / volume
  );
}


/* =====================================================
   SUPPORT / RESISTANCE
===================================================== */

function SupportResistance(values) {
  if (!values || values.length < 20) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    values.slice(-20);

  return {
    support: round(
      Math.min(...recent)
    ),
    resistance: round(
      Math.max(...recent)
    )
  };
}


/* =====================================================
   TECHNICAL SCORE
===================================================== */

function TechnicalScore(
  price,
  indicators
) {
  let score = 50;

  if (
    indicators.MA5 !== null
  ) {
    score +=
      price > indicators.MA5
        ? 5
        : -5;
  }

  if (
    indicators.MA20 !== null
  ) {
    score +=
      price > indicators.MA20
        ? 10
        : -10;
  }

  if (
    indicators.MA60 !== null
  ) {
    score +=
      price > indicators.MA60
        ? 10
        : -10;
  }

  if (
    indicators.RSI !== null
  ) {
    if (indicators.RSI >= 50) {
      score += 8;
    } else {
      score -= 8;
    }
  }

  if (
    indicators.MACD &&
    indicators.MACD.macd !== null
  ) {
    score +=
      indicators.MACD.macd >= 0
        ? 7
        : -7;
  }

  return Math.max(
    0,
    Math.min(100, score)
  );
}


/* =====================================================
   AI ANALYSIS
===================================================== */

function AIAnalysis(
  price,
  indicators
) {
  const score =
    TechnicalScore(
      price,
      indicators
    );

  let trend = "震盪";

  if (score >= 70) {
    trend = "偏多";
  }

  if (score <= 35) {
    trend = "偏空";
  }

  let momentum = "中性";

  if (
    indicators.RSI !== null &&
    indicators.RSI >= 50
  ) {
    momentum = "偏強";
  }

  if (
    indicators.RSI !== null &&
    indicators.RSI < 50
  ) {
    momentum = "偏弱";
  }

  const reasons = [];
  const risks = [];
  const signals = [];

  if (
    indicators.MA20 !== null
  ) {
    if (price > indicators.MA20) {
      reasons.push(
        "價格位於 MA20 上方"
      );
    } else {
      risks.push(
        "價格位於 MA20 下方"
      );
    }
  }

  if (
    indicators.MA60 !== null
  ) {
    if (price > indicators.MA60) {
      reasons.push(
        "價格位於 MA60 上方"
      );
    } else {
      risks.push(
        "價格位於 MA60 下方"
      );
    }
  }

  if (
    indicators.RSI !== null
  ) {
    if (indicators.RSI >= 70) {
      risks.push(
        "RSI 高於 70，短線可能偏熱"
      );
    } else if (
      indicators.RSI <= 30
    ) {
      signals.push(
        "RSI 低於 30，處於超賣區"
      );
    } else {
      signals.push(
        "RSI 位於中性區間"
      );
    }
  }

  if (
    indicators.MACD &&
    indicators.MACD.macd !== null
  ) {
    if (
      indicators.MACD.macd > 0
    ) {
      signals.push(
        "MACD 位於零軸上方"
      );
    } else {
      risks.push(
        "MACD 位於零軸下方"
      );
    }
  }

  if (
    indicators.supportResistance
  ) {
    if (
      indicators.supportResistance.support
    ) {
      signals.push(
        "近期支撐約 " +
        indicators.supportResistance.support
      );
    }

    if (
      indicators.supportResistance.resistance
    ) {
      signals.push(
        "近期壓力約 " +
        indicators.supportResistance.resistance
      );
    }
  }

  return {
    score,
    trend,
    momentum,
    reasons,
    signals,
    risks,
    disclaimer:
      "IAN AI 為資訊與技術分析工具，不構成投資建議，也不保證投資結果。"
  };
}


/* =====================================================
   HISTORY
===================================================== */

async function getHistory(
  symbol,
  range = "1y",
  interval = "1d"
) {
  symbol =
    cleanSymbol(symbol);

  const key =
    symbol +
    "_" +
    range +
    "_" +
    interval;

  const cached =
    getCache(
      historyCache,
      key
    );

  if (cached) {
    return cached;
  }

  try {
    const result =
      await yahooChart(
        symbol,
        range,
        interval
      );

    const timestamps =
      result.timestamp || [];

    const quote =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0];

    if (!quote) {
      throw new Error(
        "No historical quote data"
      );
    }

    const rows = [];

    for (
      let i = 0;
      i < timestamps.length;
      i++
    ) {
      const close =
        quote.close?.[i];

      if (
        close === null ||
        close === undefined
      ) {
        continue;
      }

      rows.push({
        date:
          new Date(
            timestamps[i] * 1000
          )
            .toISOString()
            .slice(0, 10),

        open:
          quote.open?.[i] ?? null,

        high:
          quote.high?.[i] ?? null,

        low:
          quote.low?.[i] ?? null,

        close:
          Number(close),

        volume:
          quote.volume?.[i] ?? 0
      });
    }

    if (!rows.length) {
      throw new Error(
        "Historical data empty"
      );
    }

    const closes =
      rows
        .map(x => Number(x.close))
        .filter(Number.isFinite);

    const latest =
      rows[rows.length - 1];

    const indicators = {
      MA5: MA(closes, 5),
      MA20: MA(closes, 20),
      MA60: MA(closes, 60),

      EMA12:
        EMA(closes, 12),

      EMA26:
        EMA(closes, 26),

      RSI:
        RSI(closes, 14),

      MACD:
        MACD(closes),

      Bollinger:
        Bollinger(
          closes,
          20,
          2
        ),

      ATR:
        ATR(
          rows,
          14
        ),

      VWAP:
        VWAP(rows),

      volume:
        Number(
          latest.volume || 0
        ),

      supportResistance:
        SupportResistance(
          closes
        )
    };

    const ai =
      AIAnalysis(
        Number(latest.close),
        indicators
      );

    const data = {
      ok: true,
      symbol,
      range,
      interval,
      source:
        "Yahoo Finance",
      latest,
      indicators,
      ai,
      history:
        rows,
      updatedAt:
        new Date().toISOString()
    };

    saveCache(
      historyCache,
      key,
      data
    );

    return {
      ...data,
      cached: false
    };

  } catch (error) {
    return {
      ok: false,
      symbol,
      error: error.message
    };
  }
}


/* =====================================================
   QUOTE
===================================================== */

async function getQuote(
  symbol
) {
  symbol =
    cleanSymbol(symbol);

  const cached =
    getCache(
      quoteCache,
      symbol
    );

  if (cached) {
    return cached;
  }

  try {
    const result =
      await yahooChart(
        symbol,
        "5d",
        "1d"
      );

    const meta =
      result.meta || {};

    const price =
      meta.regularMarketPrice ??
      meta.chartPreviousClose;

    const previous =
      meta.previousClose ??
      meta.chartPreviousClose;

    if (
      price === null ||
      price === undefined
    ) {
      throw new Error(
        "No current price"
      );
    }

    const change =
      Number(price) -
      Number(previous || price);

    const changePct =
      previous
        ? change /
          Number(previous) *
          100
        : 0;

    const data = {
      ok: true,
      symbol,
      price:
        round(price),
      change:
        round(change),
      changePct:
        round(changePct),
      previousClose:
        round(previous),
      volume:
        Number(
          meta.regularMarketVolume || 0
        ),
      currency:
        meta.currency || null,
      exchange:
        meta.exchangeName || null,
      latestTradingDay:
        meta.regularMarketTime
          ? new Date(
              meta.regularMarketTime * 1000
            )
              .toISOString()
              .slice(0, 10)
          : null,
      source:
        "Yahoo Finance"
    };

    saveCache(
      quoteCache,
      symbol,
      data
    );

    return {
      ...data,
      cached: false
    };

  } catch (error) {

    const backup =
      await alphaQuote(symbol);

    if (backup) {
      return backup;
    }

    return {
      ok: false,
      symbol,
      error: error.message
    };
  }
}


/* =====================================================
   STOCK LIST
===================================================== */

const STOCKS = [

  {symbol:"2330",name:"台積電",market:"TW"},
  {symbol:"2317",name:"鴻海",market:"TW"},
  {symbol:"2454",name:"聯發科",market:"TW"},
  {symbol:"2303",name:"聯電",market:"TW"},
  {symbol:"2308",name:"台達電",market:"TW"},
  {symbol:"2382",name:"廣達",market:"TW"},
  {symbol:"2603",name:"長榮",market:"TW"},
  {symbol:"2615",name:"萬海",market:"TW"},
  {symbol:"2881",name:"富邦金",market:"TW"},
  {symbol:"2882",name:"國泰金",market:"TW"},

  {symbol:"NVDA",name:"NVIDIA",market:"US"},
  {symbol:"AAPL",name:"Apple",market:"US"},
  {symbol:"MSFT",name:"Microsoft",market:"US"},
  {symbol:"AMZN",name:"Amazon",market:"US"},
  {symbol:"GOOGL",name:"Alphabet",market:"US"},
  {symbol:"META",name:"Meta",market:"US"},
  {symbol:"TSLA",name:"Tesla",market:"US"},
  {symbol:"AMD",name:"AMD",market:"US"},
  {symbol:"AVGO",name:"Broadcom",market:"US"},
  {symbol:"TSM",name:"Taiwan Semiconductor",market:"US"},
  {symbol:"NFLX",name:"Netflix",market:"US"},
  {symbol:"COST",name:"Costco",market:"US"},
  {symbol:"ORCL",name:"Oracle",market:"US"},
  {symbol:"INTC",name:"Intel",market:"US"},
  {symbol:"QCOM",name:"Qualcomm",market:"US"}

];


/* =====================================================
   QUOTES
===================================================== */

app.get(
  "/api/quotes",
  async (req, res) => {

    let symbols =
      req.query.symbols
        ? String(
            req.query.symbols
          )
            .split(",")
            .map(cleanSymbol)
            .filter(Boolean)
            .slice(0, 30)
        : [
            "2330",
            "2317",
            "2454",
            "NVDA",
            "AAPL",
            "MSFT",
            "TSLA",
            "AMD"
          ];

    const results = [];

    for (
      const symbol of symbols
    ) {
      const quote =
        await getQuote(symbol);

      if (quote.ok) {
        results.push(quote);
      }
    }

    res.json({
      ok: true,
      count:
        results.length,
      results
    });
  }
);


/* =====================================================
   SINGLE QUOTE
===================================================== */

app.get(
  "/api/quote/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const quote =
      await getQuote(symbol);

    if (!quote.ok) {
      return res
        .status(502)
        .json(quote);
    }

    res.json(quote);
  }
);


/* =====================================================
   HISTORY
===================================================== */

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

    const interval =
      String(
        req.query.interval || "1d"
      );

    const allowedRanges = [
      "1d",
      "5d",
      "1mo",
      "3mo",
      "6mo",
      "1y",
      "2y",
      "5y"
    ];

    const allowedIntervals = [
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "1d",
      "1wk"
    ];

    const safeRange =
      allowedRanges.includes(range)
        ? range
        : "1y";

    const safeInterval =
      allowedIntervals.includes(interval)
        ? interval
        : "1d";

    const data =
      await getHistory(
        symbol,
        safeRange,
        safeInterval
      );

    if (!data.ok) {
      return res
        .status(502)
        .json(data);
    }

    res.json(data);
  }
);


/* =====================================================
   ANALYSIS
===================================================== */

app.get(
  "/api/analysis/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const data =
      await getHistory(
        symbol,
        "1y",
        "1d"
      );

    if (!data.ok) {
      return res
        .status(502)
        .json(data);
    }

    res.json({
      ok: true,
      symbol,
      price:
        data.latest.close,
      indicators:
        data.indicators,
      ai:
        data.ai,
      source:
        data.source,
      updatedAt:
        data.updatedAt
    });
  }
);


/* =====================================================
   COMPLETE STOCK
===================================================== */

app.get(
  "/api/stock/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );

    const quote =
      await getQuote(symbol);

    const history =
      await getHistory(
        symbol,
        "1y",
        "1d"
      );

    if (
      !quote.ok &&
      !history.ok
    ) {
      return res
        .status(502)
        .json({
          ok: false,
          symbol,
          error:
            quote.error ||
            history.error
        });
    }

    res.json({
      ok: true,
      symbol,
      quote,
      latest:
        history.latest,
      indicators:
        history.indicators,
      ai:
        history.ai,
      history:
        history.history,
      source:
        history.source ||
        quote.source
    });
  }
);


/* =====================================================
   SEARCH
===================================================== */

app.get(
  "/api/search",
  (req, res) => {

    const q =
      String(
        req.query.q || ""
      )
        .trim()
        .toUpperCase();

    const results =
      q
        ? STOCKS.filter(
            stock =>
              stock.symbol
                .toUpperCase()
                .includes(q) ||
              stock.name
                .toUpperCase()
                .includes(q)
          )
        : STOCKS;

    res.json({
      ok: true,
      count:
        results.length,
      results
    });
  }
);


/* =====================================================
   MARKET
===================================================== */

async function marketItem(
  symbol,
  name
) {
  const quote =
    await getQuote(symbol);

  return {
    name,
    symbol,
    ...quote
  };
}

app.get(
  "/api/market",
  async (req, res) => {

    const cached =
      getCache(
        marketCache,
        "market"
      );

    if (cached) {
      return res.json(cached);
    }

    const data = {
      ok: true,

      taiwan:
        await marketItem(
          "^TWII",
          "台灣加權指數"
        ),

      nasdaq:
        await marketItem(
          "^IXIC",
          "NASDAQ"
        ),

      sp500:
        await marketItem(
          "^GSPC",
          "S&P 500"
        ),

      dow:
        await marketItem(
          "^DJI",
          "Dow Jones"
        ),

      usdTwd:
        await marketItem(
          "TWD=X",
          "USD/TWD"
        ),

      updatedAt:
        new Date().toISOString()
    };

    saveCache(
      marketCache,
      "market",
      data
    );

    res.json(data);
  }
);


/* =====================================================
   CACHE
===================================================== */

app.get(
  "/api/cache",
  (req, res) => {

    const quotes = {};

    Object.keys(
      quoteCache
    ).forEach(symbol => {

      const item =
        quoteCache[symbol];

      const age =
        Date.now() -
        item.time;

      quotes[symbol] = {
        cached:
          age < CACHE_TIME,
        ageSeconds:
          Math.floor(age / 1000),
        price:
          item.data.price
      };
    });

    const history = {};

    Object.keys(
      historyCache
    ).forEach(key => {

      const item =
        historyCache[key];

      const age =
        Date.now() -
        item.time;

      history[key] = {
        cached:
          age < CACHE_TIME,
        ageSeconds:
          Math.floor(age / 1000)
      };
    });

    res.json({
      cacheTimeMinutes:
        CACHE_TIME / 60000,
      quotes,
      history
    });
  }
);


/* =====================================================
   STATUS
===================================================== */

app.get(
  "/api/status",
  async (req, res) => {

    let yahoo =
      "ERROR";

    let history =
      "ERROR";

    let quoteSource =
      null;

    let historySource =
      null;

    let error =
      null;

    try {

      const quote =
        await getQuote(
          "NVDA"
        );

      if (quote.ok) {
        yahoo = "OK";
        quoteSource =
          quote.source;
      }

    } catch (e) {
      error = e.message;
    }

    try {

      const data =
        await getHistory(
          "NVDA",
          "1y",
          "1d"
        );

      if (data.ok) {
        history = "OK";
        historySource =
          data.source;
      }

    } catch (e) {

      if (!error) {
        error = e.message;
      }
    }

    res.json({

      server:
        SERVER_NAME,

      version:
        VERSION,

      status:
        "ONLINE",

      yahooFinance:
        yahoo,

      history,

      quoteSource,

      historySource,

      alphaVantageConfigured:
        Boolean(
          process.env.ALPHA_VANTAGE_KEY
        ),

      cacheEntries: {

        quotes:
          Object.keys(
            quoteCache
          ).length,

        history:
          Object.keys(
            historyCache
          ).length,

        market:
          Object.keys(
            marketCache
          ).length
      },

      features: [

        "Quotes",
        "Historical Data",
        "K Line",
        "MA",
        "EMA",
        "RSI",
        "MACD",
        "Bollinger Bands",
        "ATR",
        "VWAP",
        "Volume",
        "Support",
        "Resistance",
        "IAN AI",
        "Market Index",
        "Search",
        "Cache"

      ],

      error,

      note:
        "API keys are never returned."
    });
  }
);


/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        SERVER_NAME,
      version:
        VERSION,
      status:
        "ONLINE",
      time:
        new Date().toISOString()
    });
  }
);


/* =====================================================
   ROOT
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        SERVER_NAME,

      version:
        VERSION,

      status:
        "ONLINE",

      message:
        "IAN STOCK API is running.",

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


/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {

    res.status(404).json({
      ok: false,
      error:
        "API route not found"
    });
  }
);


/* =====================================================
   ERROR
===================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

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


/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      SERVER_NAME +
      " V" +
      VERSION +
      " running on port " +
      PORT
    );
  }
);
