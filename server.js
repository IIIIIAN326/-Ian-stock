const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SERVER_NAME = "IAN STOCK API";
const VERSION = "3.0.0";

/*
==================================================
IAN STOCK API V3
==================================================

功能：

1. 台股 / 美股報價
2. 歷史行情
3. MA5 / MA20 / MA60
4. EMA12 / EMA26
5. RSI
6. MACD
7. Bollinger Bands
8. ATR
9. VWAP
10. Volume
11. Support / Resistance
12. 技術分析
13. IAN AI 分析摘要
14. 股票搜尋
15. 市場指數
16. Server Cache
17. Alpha Vantage 備援
18. Health / Status
19. API 不回傳任何 API Key

==================================================
*/


/* ==================================================
   SETTINGS
================================================== */

const CACHE_TIME = 15 * 60 * 1000;

// 報價快取
const quoteCache = {};

// 歷史資料快取
const historyCache = {};

// 市場資料快取
const marketCache = {};


/* ==================================================
   BASIC FUNCTIONS
================================================== */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}


function yahooSymbol(symbol) {

  symbol = cleanSymbol(symbol);

  // 台股 4 碼
  if (/^\d{4}$/.test(symbol)) {
    return symbol + ".TW";
  }

  return symbol;
}


function getCache(cache, key) {

  const item = cache[key];

  if (!item) {
    return null;
  }

  const age = Date.now() - item.time;

  if (age < CACHE_TIME) {

    return {
      ...item.data,

      cached: true,

      cacheAgeSeconds:
        Math.floor(age / 1000)
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


function round(value, digits = 2) {

  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return Number(
    Number(value).toFixed(digits)
  );
}


/* ==================================================
   YAHOO FINANCE
================================================== */

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
      "User-Agent":
        "Mozilla/5.0 IAN-STOCK"
    }
  });

  if (!response.ok) {

    throw new Error(
      "Yahoo Finance HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

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


/* ==================================================
   ALPHA VANTAGE BACKUP
================================================== */

async function alphaQuote(symbol) {

  const API_KEY =
    process.env.ALPHA_VANTAGE_KEY;

  if (!API_KEY) {
    return null;
  }

  const url =
    "https://www.alphavantage.co/query" +
    "?function=GLOBAL_QUOTE" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&apikey=" +
    encodeURIComponent(API_KEY);

  try {

    const response =
      await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data =
      await response.json();

    const q =
      data["Global Quote"];

    if (!q || !q["05. price"]) {
      return null;
    }

    return {

      ok: true,

      symbol,

      price:
        Number(q["05. price"]),

      change:
        Number(q["09. change"] || 0),

      changePct:
        Number(
          String(
            q["10. change percent"] || ""
          ).replace("%", "")
        ),

      volume:
        Number(q["06. volume"] || 0),

      latestTradingDay:
        q["07. latest trading day"] ||
        null,

      source:
        "Alpha Vantage"
    };

  } catch (error) {

    return null;
  }
}


/* ==================================================
   MOVING AVERAGE
================================================== */

function calculateMA(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const slice =
    values.slice(-period);

  const sum =
    slice.reduce(
      (a, b) => a + b,
      0
    );

  return round(
    sum / period
  );
}


/* ==================================================
   EMA
================================================== */

function calculateEMA(
  values,
  period
) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
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

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      (
        (values[i] - ema) *
        multiplier
      ) + ema;
  }

  return round(ema);
}


/* ==================================================
   RSI
================================================== */

function calculateRSI(
  values,
  period = 14
) {

  if (
    !values ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    averageGain =
      (
        averageGain *
        (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
        (period - 1) +
        loss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return round(
    100 -
    100 / (1 + rs)
  );
}


/* ==================================================
   MACD
================================================== */

function calculateMACD(
  values
) {

  if (
    !values ||
    values.length < 35
  ) {
    return null;
  }

  const ema12 =
    calculateEMA(values, 12);

  const ema26 =
    calculateEMA(values, 26);

  if (
    ema12 === null ||
    ema26 === null
  ) {
    return null;
  }

  const macd =
    ema12 - ema26;

  return {

    macd:
      round(macd),

    signal:
      null,

    histogram:
      null
  };
}


/* ==================================================
   BOLLINGER BANDS
================================================== */

function calculateBollinger(
  values,
  period = 20,
  multiplier = 2
) {

  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const slice =
    values.slice(-period);

  const mean =
    slice.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    slice.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - mean,
          2
        ),
      0
    ) / period;

  const std =
    Math.sqrt(variance);

  return {

    middle:
      round(mean),

    upper:
      round(
        mean +
        multiplier * std
      ),

    lower:
      round(
        mean -
        multiplier * std
      )
  };
}


/* ==================================================
   ATR
================================================== */

function calculateATR(
  rows,
  period = 14
) {

  if (
    !rows ||
    rows.length <= period
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    const current =
      rows[i];

    const previous =
      rows[i - 1];

    const high =
      Number(current.high);

    const low =
      Number(current.low);

    const previousClose =
      Number(previous.close);

    const tr =
      Math.max(

        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
      );

    trs.push(tr);
  }

  if (trs.length < period) {
    return null;
  }

  const slice =
    trs.slice(-period);

  const atr =
    slice.reduce(
      (a, b) => a + b,
      0
    ) / period;

  return round(atr);
}


/* ==================================================
   VWAP
================================================== */

function calculateVWAP(
  rows
) {

  if (
    !rows ||
    rows.length === 0
  ) {
    return null;
  }

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  const recent =
    rows.slice(-60);

  for (const row of recent) {

    const high =
      Number(row.high);

    const low =
      Number(row.low);

    const close =
      Number(row.close);

    const volume =
      Number(row.volume || 0);

    const typicalPrice =
      (
        high +
        low +
        close
      ) / 3;

    cumulativePV +=
      typicalPrice *
      volume;

    cumulativeVolume +=
      volume;
  }

  if (
    cumulativeVolume === 0
  ) {
    return null;
  }

  return round(
    cumulativePV /
    cumulativeVolume
  );
}


/* ==================================================
   SUPPORT / RESISTANCE
================================================== */

function calculateSupportResistance(
  values
) {

  if (
    !values ||
    values.length < 20
  ) {

    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    values.slice(-20);

  const support =
    Math.min(...recent);

  const resistance =
    Math.max(...recent);

  return {

    support:
      round(support),

    resistance:
      round(resistance)
  };
}


/* ==================================================
   TREND ANALYSIS
================================================== */

function calculateTrend(
  price,
  ma5,
  ma20,
  ma60
) {

  if (
    price === null ||
    ma20 === null
  ) {

    return {
      trend: "資料不足",
      score: null
    };
  }

  let score = 0;

  if (price > ma5) {
    score++;
  } else {
    score--;
  }

  if (price > ma20) {
    score++;
  } else {
    score--;
  }

  if (
    ma60 !== null
  ) {

    if (price > ma60) {
      score++;
    } else {
      score--;
    }
  }

  if (score >= 2) {

    return {
      trend: "偏多",
      score
    };

  }

  if (score <= -2) {

    return {
      trend: "偏空",
      score
    };

  }

  return {
    trend: "震盪",
    score
  };
}


/* ==================================================
   MOMENTUM ANALYSIS
================================================== */

function calculateMomentum(
  rsi,
  macd
) {

  let score = 0;

  if (rsi !== null) {

    if (rsi >= 50) {
      score++;
    } else {
      score--;
    }
  }

  if (
    macd &&
    macd.macd !== null
  ) {

    if (macd.macd > 0) {
      score++;
    } else {
      score--;
    }
  }

  if (score >= 2) {

    return {
      momentum: "偏強",
      score
    };

  }

  if (score <= -2) {

    return {
      momentum: "偏弱",
      score
    };

  }

  return {
    momentum: "中性",
    score
  };
}


/* ==================================================
   IAN AI TECHNICAL ANALYSIS
================================================== */

function buildAIAnalysis(
  data
) {

  const indicators =
    data.indicators;

  const trend =
    calculateTrend(
      data.latest.close,
      indicators.MA5,
      indicators.MA20,
      indicators.MA60
    );

  const momentum =
    calculateMomentum(
      indicators.RSI,
      indicators.MACD
    );

  const reasons = [];
  const risks = [];
  const signals = [];

  if (
    indicators.MA5 !== null &&
    data.latest.close >
    indicators.MA5
  ) {

    reasons.push(
      "價格位於 MA5 上方"
    );

  } else {

    reasons.push(
      "價格位於 MA5 下方"
    );
  }


  if (
    indicators.MA20 !== null &&
    data.latest.close >
    indicators.MA20
  ) {

    reasons.push(
      "價格位於 MA20 上方"
    );

  } else {

    reasons.push(
      "價格位於 MA20 下方"
    );
  }


  if (
    indicators.RSI !== null
  ) {

    if (
      indicators.RSI >= 70
    ) {

      risks.push(
        "RSI 高於 70，短線可能偏熱"
      );

    } else if (
      indicators.RSI <= 30
    ) {

      signals.push(
        "RSI 低於 30，市場可能處於超賣區"
      );

    } else if (
      indicators.RSI >= 50
    ) {

      signals.push(
        "RSI 位於 50 上方，動能偏正"
      );

    } else {

      risks.push(
        "RSI 位於 50 下方，動能偏弱"
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


  let aiScore = 50;

  aiScore +=
    trend.score * 8;

  aiScore +=
    momentum.score * 7;

  aiScore =
    Math.max(
      0,
      Math.min(
        100,
        aiScore
      )
    );


  return {

    score:
      aiScore,

    trend:
      trend.trend,

    momentum:
      momentum.momentum,

    reasons,

    risks,

    signals,

    disclaimer:
      "IAN AI 為資訊與技術分析工具，不構成投資建議，也不保證投資結果。"
  };
}


/* ==================================================
   HISTORY
================================================== */

async function getHistory(
  symbol
) {

  symbol =
    cleanSymbol(symbol);

  const cached =
    getCache(
      historyCache,
      symbol
    );

  if (cached) {
    return cached;
  }

  try {

    const result =
      await yahooChart(
        symbol,
        "1y",
        "1d"
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

    if (rows.length === 0) {

      throw new Error(
        "Historical data is empty"
      );
    }


    const closes =
      rows
        .map(
          row =>
            Number(row.close)
        )
        .filter(
          Number.isFinite
        );


    const latest =
      rows[rows.length - 1];


    const indicators = {

      MA5:
        calculateMA(
          closes,
          5
        ),

      MA20:
        calculateMA(
          closes,
          20
        ),

      MA60:
        calculateMA(
          closes,
          60
        ),

      EMA12:
        calculateEMA(
          closes,
          12
        ),

      EMA26:
        calculateEMA(
          closes,
          26
        ),

      RSI:
        calculateRSI(
          closes,
          14
        ),

      MACD:
        calculateMACD(
          closes
        ),

      Bollinger:
        calculateBollinger(
          closes,
          20,
          2
        ),

      ATR:
        calculateATR(
          rows,
          14
        ),

      VWAP:
        calculateVWAP(
          rows
        ),

      volume:
        Number(
          latest.volume || 0
        ),

      supportResistance:
        calculateSupportResistance(
          closes
        )
    };


    const resultData = {

      ok: true,

      symbol,

      source:
        "Yahoo Finance",

      latest,

      indicators,

      history:
        rows,

      updatedAt:
        new Date().toISOString()
    };


    const ai =
      buildAIAnalysis(
        resultData
      );


    resultData.ai =
      ai;


    saveCache(
      historyCache,
      symbol,
      resultData
    );


    return {

      ...resultData,

      cached: false
    };


  } catch (error) {

    return {

      ok: false,

      symbol,

      error:
        error.message
    };
  }
}


/* ==================================================
   QUOTE
================================================== */

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
      Number(
        previous ||
        price
      );


    const changePct =
      previous
        ? (
            change /
            Number(previous)
          ) * 100
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

      volume:
        Number(
          meta.regularMarketVolume ||
          0
        ),

      previousClose:
        round(previous),

      latestTradingDay:
        meta.regularMarketTime
          ? new Date(
              meta.regularMarketTime *
              1000
            )
              .toISOString()
              .slice(0, 10)
          : null,

      currency:
        meta.currency || null,

      exchange:
        meta.exchangeName || null,

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
      await alphaQuote(
        symbol
      );

    if (backup) {
      return backup;
    }


    return {

      ok: false,

      symbol,

      error:
        error.message
    };
  }
}


/* ==================================================
   QUOTES
================================================== */

app.get(
  "/api/quotes",
  async (req, res) => {

    let symbols = [
      "2330",
      "2317",
      "2454",
      "NVDA",
      "AAPL",
      "MSFT",
      "TSLA",
      "AMD"
    ];


    if (req.query.symbols) {

      symbols =
        String(
          req.query.symbols
        )
          .split(",")
          .map(cleanSymbol)
          .filter(Boolean)
          .slice(0, 30);
    }


    const results = [];


    for (
      const symbol of symbols
    ) {

      const quote =
        await getQuote(
          symbol
        );

      if (quote.ok) {
        results.push(
          quote
        );
      }
    }


    res.json({
      ok: true,
      count: results.length,
      results
    });

  }
);


/* ==================================================
   SINGLE QUOTE
================================================== */

app.get(
  "/api/quote/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );


    if (!symbol) {

      return res.status(400).json({
        ok: false,
        error: "Invalid symbol"
      });
    }


    const quote =
      await getQuote(
        symbol
      );


    if (!quote.ok) {

      return res
        .status(502)
        .json(quote);
    }


    res.json(quote);

  }
);


/* ==================================================
   HISTORY
================================================== */

app.get(
  "/api/history/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );


    const data =
      await getHistory(
        symbol
      );


    if (!data.ok) {

      return res
        .status(502)
        .json(data);
    }


    res.json(data);

  }
);


/* ==================================================
   TECHNICAL ANALYSIS
================================================== */

app.get(
  "/api/analysis/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );


    const data =
      await getHistory(
        symbol
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


/* ==================================================
   SEARCH
================================================== */

app.get(
  "/api/search",
  async (req, res) => {

    const keyword =
      String(
        req.query.q || ""
      )
        .trim()
        .toUpperCase();


    const stocks = [

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
      }

    ];


    const results =
      keyword

        ? stocks.filter(
            stock =>
              stock.symbol
                .toUpperCase()
                .includes(keyword) ||

              stock.name
                .toUpperCase()
                .includes(keyword)
          )

        : stocks;


    res.json({

      ok: true,

      count:
        results.length,

      results
    });

  }
);


/* ==================================================
   MARKET INDICES
================================================== */

async function getMarketIndex(
  symbol,
  name
) {

  const quote =
    await getQuote(
      symbol
    );


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

      return res.json(
        cached
      );
    }


    const market = {

      ok: true,

      taiwan: await getMarketIndex(
        "^TWII",
        "台灣加權指數"
      ),

      nasdaq: await getMarketIndex(
        "^IXIC",
        "NASDAQ"
      ),

      sp500: await getMarketIndex(
        "^GSPC",
        "S&P 500"
      ),

      dow: await getMarketIndex(
        "^DJI",
        "Dow Jones"
      ),

      usdTwd: await getMarketIndex(
        "TWD=X",
        "USD/TWD"
      ),

      updatedAt:
        new Date().toISOString()
    };


    saveCache(
      marketCache,
      "market",
      market
    );


    res.json(
      market
    );

  }
);


/* ==================================================
   WATCHLIST HELPER
================================================== */

app.get(
  "/api/stock/:symbol",
  async (req, res) => {

    const symbol =
      cleanSymbol(
        req.params.symbol
      );


    const quote =
      await getQuote(
        symbol
      );


    const history =
      await getHistory(
        symbol
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

      indicators:
        history.ok
          ? history.indicators
          : null,

      ai:
        history.ok
          ? history.ai
          : null,

      history:
        history.ok
          ? history.history
          : [],

      source:
        history.source ||
        quote.source ||
        null
    });

  }
);


/* ==================================================
   CACHE STATUS
================================================== */

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
          Math.floor(
            age / 1000
          ),

        price:
          item.data.price
      };

    });


    const history = {};

    Object.keys(
      historyCache
    ).forEach(symbol => {

      const item =
        historyCache[symbol];

      const age =
        Date.now() -
        item.time;


      history[symbol] = {

        cached:
          age < CACHE_TIME,

        ageSeconds:
          Math.floor(
            age / 1000
          )
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


/* ==================================================
   STATUS
================================================== */

app.get(
  "/api/status",
  async (req, res) => {

    let yahooStatus =
      "ERROR";

    let historyStatus =
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

        yahooStatus =
          "OK";

        quoteSource =
          quote.source;
      }

    } catch (e) {

      error =
        e.message;
    }


    try {

      const history =
        await getHistory(
          "NVDA"
        );


      if (history.ok) {

        historyStatus =
          "OK";

        historySource =
          history.source;
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
        yahooStatus,

      history:
        historyStatus,

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

      error,

      note:
        "API keys are never returned."
    });

  }
);


/* ==================================================
   HEALTH CHECK
================================================== */

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


/* ==================================================
   ROOT
================================================== */

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

      features: [

        "Taiwan stocks",
        "US stocks",
        "Historical data",
        "MA5",
        "MA20",
        "MA60",
        "EMA",
        "RSI",
        "MACD",
        "Bollinger Bands",
        "ATR",
        "VWAP",
        "Volume",
        "Support",
        "Resistance",
        "Technical Analysis",
        "IAN AI Analysis",
        "Market Indices",
        "Stock Search",
        "Server Cache"

      ]
    });

  }
);


/* ==================================================
   404
================================================== */

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "API route not found"
    });

  }
);


/* ==================================================
   ERROR HANDLER
================================================== */

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


/* ==================================================
   START SERVER
================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      SERVER_NAME +
      " v" +
      VERSION +
      " running on port " +
      PORT
    );

  }
);
