const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ALPHA_VANTAGE_KEY =
  process.env.ALPHA_VANTAGE_KEY || "";

const SERVER_NAME = "IAN STOCK API";
const VERSION = "4.0.0";

/* =========================================================
   CACHE
========================================================= */

const CACHE_TIME = 60 * 60 * 1000;

const quoteCache = {};
const historyCache = {};
const searchCache = {};
const analysisCache = {};


/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}


function isTaiwanNumber(symbol) {
  return /^[0-9]{4,6}$/.test(symbol);
}


function yahooSymbol(symbol) {

  symbol = cleanSymbol(symbol);

  if (!symbol) return "";

  /*
    2330 -> 2330.TW
    0050 -> 0050.TW
  */

  if (isTaiwanNumber(symbol)) {
    return symbol + ".TW";
  }

  return symbol;
}


function displaySymbol(symbol) {

  symbol = cleanSymbol(symbol);

  return symbol
    .replace(".TW", "")
    .replace(".TWO", "");
}


function cacheGet(cache, key) {

  const item = cache[key];

  if (!item) return null;

  const age =
    Date.now() - item.time;

  if (age < CACHE_TIME) {

    return {
      ...item.data,
      cached: true,
      cacheAgeSeconds:
        Math.floor(age / 1000)
    };

  }

  delete cache[key];

  return null;
}


function cacheSet(cache, key, data) {

  cache[key] = {
    time: Date.now(),
    data
  };

}


function number(v) {

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : null;

}


function average(values) {

  if (!values.length)
    return null;

  return (
    values.reduce(
      (a, b) => a + b,
      0
    ) / values.length
  );

}


function round(value, digits = 2) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const p =
    Math.pow(10, digits);

  return Math.round(
    Number(value) * p
  ) / p;

}


/* =========================================================
   YAHOO FINANCE
========================================================= */

async function yahooFetch(url) {

  const response =
    await fetch(url, {
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

  return response.json();

}


/* =========================================================
   HISTORY
========================================================= */

async function fetchHistory(
  symbol,
  range = "1y",
  interval = "1d"
) {

  symbol = cleanSymbol(symbol);

  const ySymbol =
    yahooSymbol(symbol);

  const key =
    ySymbol +
    "|" +
    range +
    "|" +
    interval;


  const cached =
    cacheGet(
      historyCache,
      key
    );

  if (cached)
    return cached;


  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=" +
    encodeURIComponent(range) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&events=history" +
    "&includeAdjustedClose=true";


  const data =
    await yahooFetch(url);


  const result =
    data?.chart?.result?.[0];


  if (!result) {

    throw new Error(
      "Yahoo Finance returned no history"
    );

  }


  const timestamps =
    result.timestamp || [];


  const quote =
    result.indicators?.quote?.[0] || {};


  const adj =
    result.indicators
      ?.adjclose?.[0]
      ?.adjclose || [];


  const rows = [];


  for (
    let i = 0;
    i < timestamps.length;
    i++
  ) {

    const open =
      number(quote.open?.[i]);

    const high =
      number(quote.high?.[i]);

    const low =
      number(quote.low?.[i]);

    const close =
      number(quote.close?.[i]);

    const volume =
      number(quote.volume?.[i]);


    if (
      open === null ||
      high === null ||
      low === null ||
      close === null
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

      open,

      high,

      low,

      close,

      volume:
        volume || 0,

      adjClose:
        number(adj[i]) ?? close

    });

  }


  if (!rows.length) {

    throw new Error(
      "No historical rows"
    );

  }


  const resultData = {

    symbol:
      displaySymbol(ySymbol),

    yahooSymbol:
      ySymbol,

    range,

    interval,

    history: rows

  };


  cacheSet(
    historyCache,
    key,
    resultData
  );


  return {
    ...resultData,
    cached: false
  };

}


/* =========================================================
   LATEST QUOTE
========================================================= */

async function fetchQuote(symbol) {

  symbol = cleanSymbol(symbol);

  const ySymbol =
    yahooSymbol(symbol);


  const cached =
    cacheGet(
      quoteCache,
      ySymbol
    );

  if (cached)
    return cached;


  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ySymbol) +
    "?range=5d" +
    "&interval=1d" +
    "&events=history";


  const data =
    await yahooFetch(url);


  const result =
    data?.chart?.result?.[0];


  if (!result) {

    throw new Error(
      "No quote data"
    );

  }


  const meta =
    result.meta || {};


  const q =
    result.indicators
      ?.quote?.[0] || {};


  const closes =
    (q.close || [])
      .filter(
        x =>
          Number.isFinite(
            Number(x)
          )
      )
      .map(Number);


  const volumes =
    (q.volume || [])
      .filter(
        x =>
          Number.isFinite(
            Number(x)
          )
      )
      .map(Number);


  let price =
    number(
      meta.regularMarketPrice
    );


  if (price === null) {

    price =
      closes.length
        ? closes[closes.length - 1]
        : null;

  }


  const previous =
    number(
      meta.previousClose
    ) ??
    (
      closes.length >= 2
        ? closes[closes.length - 2]
        : null
    );


  const change =
    price !== null &&
    previous !== null
      ? price - previous
      : null;


  const changePct =
    change !== null &&
    previous
      ? change /
        previous *
        100
      : null;


  const volume =
    number(
      meta.regularMarketVolume
    ) ??
    (
      volumes.length
        ? volumes[volumes.length - 1]
        : 0
    );


  const resultData = {

    ok: true,

    symbol:
      displaySymbol(ySymbol),

    yahooSymbol:
      ySymbol,

    price:

      round(
        price,
        2
      ),

    previousClose:

      round(
        previous,
        2
      ),

    change:

      round(
        change,
        2
      ),

    changePct:

      round(
        changePct,
        2
      ),

    volume,

    currency:
      meta.currency ||
      (
        ySymbol.endsWith(".TW")
          ? "TWD"
          : "USD"
      ),

    exchange:
      meta.exchange ||
      null,

    marketState:
      meta.marketState ||
      null,

    latestTradingDay:
      closes.length
        ? new Date(
            (
              result.timestamp ||
              []
            ).slice(-1)[0] *
            1000
          )
            .toISOString()
            .slice(0,10)
        : null

  };


  cacheSet(
    quoteCache,
    ySymbol,
    resultData
  );


  return {
    ...resultData,
    cached: false
  };

}


/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function sma(
  closes,
  period
) {

  if (
    closes.length <
    period
  ) return null;


  return average(
    closes.slice(
      -period
    )
  );

}


function emaSeries(
  closes,
  period
) {

  if (
    closes.length <
    period
  ) return [];


  const multiplier =
    2 /
    (period + 1);


  let ema =
    average(
      closes.slice(
        0,
        period
      )
    );


  const values =
    new Array(
      period - 1
    ).fill(null);


  values.push(ema);


  for (
    let i = period;
    i < closes.length;
    i++
  ) {

    ema =
      (
        closes[i] -
        ema
      ) *
      multiplier +
      ema;


    values.push(ema);

  }


  return values;

}


function ema(
  closes,
  period
) {

  const series =
    emaSeries(
      closes,
      period
    );


  return series.length
    ? series[series.length - 1]
    : null;

}


function rsi(
  closes,
  period = 14
) {

  if (
    closes.length <=
    period
  ) return null;


  let gains = 0;
  let losses = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const diff =
      closes[i] -
      closes[i - 1];


    if (diff >= 0)
      gains += diff;
    else
      losses -= diff;

  }


  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;


  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {

    const diff =
      closes[i] -
      closes[i - 1];


    const gain =
      Math.max(
        diff,
        0
      );

    const loss =
      Math.max(
        -diff,
        0
      );


    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) / period;


    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) / period;

  }


  if (avgLoss === 0)
    return 100;


  const rs =
    avgGain /
    avgLoss;


  return 100 -
    100 /
    (1 + rs);

}


function macd(
  closes
) {

  const ema12 =
    emaSeries(
      closes,
      12
    );

  const ema26 =
    emaSeries(
      closes,
      26
    );


  if (
    !ema12.length ||
    !ema26.length
  ) {

    return {
      macd: null,
      signal: null,
      histogram: null
    };

  }


  const macdValues = [];


  for (
    let i = 0;
    i < closes.length;
    i++
  ) {

    if (
      ema12[i] === null ||
      ema26[i] === null
    ) continue;


    macdValues.push(
      ema12[i] -
      ema26[i]
    );

  }


  const signal =
    ema(
      macdValues,
      9
    );


  const current =
    macdValues.length
      ? macdValues[
          macdValues.length - 1
        ]
      : null;


  return {

    macd:
      round(
        current,
        2
      ),

    signal:
      round(
        signal,
        2
      ),

    histogram:
      current !== null &&
      signal !== null
        ? round(
            current -
            signal,
            2
          )
        : null

  };

}


function atr(
  rows,
  period = 14
) {

  if (
    rows.length <=
    period
  ) return null;


  const tr = [];


  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    const current =
      rows[i];

    const previous =
      rows[i - 1];


    const trueRange =
      Math.max(

        current.high -
        current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )

      );


    tr.push(
      trueRange
    );

  }


  return average(
    tr.slice(-period)
  );

}


function bollinger(
  closes,
  period = 20,
  multiplier = 2
) {

  if (
    closes.length <
    period
  ) {

    return {
      upper:null,
      middle:null,
      lower:null
    };

  }


  const values =
    closes.slice(
      -period
    );


  const middle =
    average(values);


  const variance =
    average(
      values.map(
        x =>
          Math.pow(
            x -
            middle,
            2
          )
      )
    );


  const sd =
    Math.sqrt(
      variance
    );


  return {

    upper:
      round(
        middle +
        multiplier *
        sd,
        2
      ),

    middle:
      round(
        middle,
        2
      ),

    lower:
      round(
        middle -
        multiplier *
        sd,
        2
      )

  };

}


function vwap(rows) {

  if (!rows.length)
    return null;


  let totalPV = 0;
  let totalVolume = 0;


  rows
    .slice(-60)
    .forEach(
      row => {

        const typical =
          (
            row.high +
            row.low +
            row.close
          ) / 3;


        const volume =
          Number(
            row.volume || 0
          );


        totalPV +=
          typical *
          volume;


        totalVolume +=
          volume;

      }
    );


  if (!totalVolume)
    return null;


  return (
    totalPV /
    totalVolume
  );

}


function supportResistance(
  rows
) {

  if (!rows.length) {

    return {
      support:null,
      resistance:null
    };

  }


  const recent =
    rows.slice(-60);


  const lows =
    recent
      .map(
        x=>x.low
      )
      .filter(
        Number.isFinite
      );


  const highs =
    recent
      .map(
        x=>x.high
      )
      .filter(
        Number.isFinite
      );


  lows.sort(
    (a,b)=>a-b
  );

  highs.sort(
    (a,b)=>a-b
  );


  return {

    support:
      lows.length
        ? round(
            lows[
              Math.floor(
                lows.length *
                0.15
              )
            ],
            2
          )
        : null,

    resistance:
      highs.length
        ? round(
            highs[
              Math.floor(
                highs.length *
                0.85
              )
            ],
            2
          )
        : null

  };

}


/* =========================================================
   FULL TECHNICAL ANALYSIS
========================================================= */

function calculateIndicators(
  rows
) {

  const closes =
    rows.map(
      x=>Number(x.close)
    );


  const current =
    closes.length
      ? closes[closes.length - 1]
      : null;


  const ma5 =
    sma(
      closes,
      5
    );

  const ma20 =
    sma(
      closes,
      20
    );

  const ma60 =
    sma(
      closes,
      60
    );


  const ema12 =
    ema(
      closes,
      12
    );

  const ema26 =
    ema(
      closes,
      26
    );


  const rsiValue =
    rsi(
      closes,
      14
    );


  const macdValue =
    macd(
      closes
    );


  const atrValue =
    atr(
      rows,
      14
    );


  const bands =
    bollinger(
      closes,
      20,
      2
    );


  const vwapValue =
    vwap(
      rows
    );


  const sr =
    supportResistance(
      rows
    );


  return {

    current:
      round(
        current,
        2
      ),

    MA5:
      round(
        ma5,
        2
      ),

    MA20:
      round(
        ma20,
        2
      ),

    MA60:
      round(
        ma60,
        2
      ),

    EMA12:
      round(
        ema12,
        2
      ),

    EMA26:
      round(
        ema26,
        2
      ),

    RSI:
      round(
        rsiValue,
        2
      ),

    MACD:
      macdValue,

    ATR:
      round(
        atrValue,
        2
      ),

    VWAP:
      round(
        vwapValue,
        2
      ),

    Volume:
      rows.length
        ? rows[
            rows.length - 1
          ].volume
        : null,

    volume:
      rows.length
        ? rows[
            rows.length - 1
          ].volume
        : null,

    Bollinger:
      bands,

    supportResistance:
      sr,

    Support:
      sr.support,

    Resistance:
      sr.resistance

  };

}


/* =========================================================
   IAN AI
========================================================= */

function generateAI(
  quote,
  indicators
) {

  const price =
    Number(
      quote.price
    );


  const ma20 =
    Number(
      indicators.MA20
    );

  const ma60 =
    Number(
      indicators.MA60
    );

  const rsiValue =
    Number(
      indicators.RSI
    );

  const macdValue =
    Number(
      indicators.MACD?.macd
    );

  const macdSignal =
    Number(
      indicators.MACD?.signal
    );


  let score = 50;

  const reasons = [];
  const signals = [];
  const risks = [];


  let trend =
    "中性";


  let momentum =
    "中性";


  if (
    Number.isFinite(ma20) &&
    price > ma20
  ) {

    score += 12;

    reasons.push(
      "價格位於 MA20 上方"
    );

  } else {

    score -= 8;

    reasons.push(
      "價格位於 MA20 下方"
    );

  }


  if (
    Number.isFinite(ma60) &&
    price > ma60
  ) {

    score += 12;

    reasons.push(
      "價格位於 MA60 上方"
    );

  } else {

    score -= 8;

    reasons.push(
      "價格位於 MA60 下方"
    );

  }


  if (
    Number.isFinite(ma20) &&
    Number.isFinite(ma60)
  ) {

    if (ma20 > ma60) {

      trend =
        "偏多";

      score += 8;

      signals.push(
        "MA20 高於 MA60"
      );

    } else {

      trend =
        "偏空";

      score -= 8;

      signals.push(
        "MA20 低於 MA60"
      );

    }

  }


  if (
    Number.isFinite(rsiValue)
  ) {

    if (
      rsiValue >= 70
    ) {

      momentum =
        "過熱";

      risks.push(
        "RSI 位於超買區"
      );

    } else if (
      rsiValue <= 30
    ) {

      momentum =
        "超賣";

      signals.push(
        "RSI 位於超賣區"
      );

    } else if (
      rsiValue >= 50
    ) {

      momentum =
        "偏強";

      score += 5;

      signals.push(
        "RSI 位於 50 上方"
      );

    } else {

      momentum =
        "偏弱";

    }

  }


  if (
    Number.isFinite(macdValue)
  ) {

    if (
      macdValue > 0
    ) {

      score += 5;

      signals.push(
        "MACD 位於零軸上方"
      );

    } else {

      score -= 5;

      risks.push(
        "MACD 位於零軸下方"
      );

    }


    if (
      Number.isFinite(macdSignal) &&
      macdValue >
      macdSignal
    ) {

      signals.push(
        "MACD 高於訊號線"
      );

    }

  }


  const support =
    indicators
      .supportResistance
      ?.support;


  const resistance =
    indicators
      .supportResistance
      ?.resistance;


  if (
    Number.isFinite(support)
  ) {

    signals.push(
      "近期支撐約 " +
      round(
        support,
        2
      )
    );

  }


  if (
    Number.isFinite(resistance)
  ) {

    signals.push(
      "近期壓力約 " +
      round(
        resistance,
        2
      )
    );

  }


  if (
    Number.isFinite(resistance) &&
    price >= resistance * 0.98
  ) {

    risks.push(
      "目前價格接近近期壓力"
    );

  }


  if (
    Number.isFinite(support) &&
    price <= support * 1.02
  ) {

    risks.push(
      "目前價格接近近期支撐"
    );

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

    score,

    trend,

    momentum,

    reasons,

    signals,

    risks,

    disclaimer:
      "IAN AI 為技術分析與資訊整理工具，不保證報酬，也不構成投資建議。"

  };

}


/* =========================================================
   STOCK DETAIL
========================================================= */

async function fetchStock(
  symbol,
  range = "1y"
) {

  symbol =
    cleanSymbol(symbol);


  const history =
    await fetchHistory(
      symbol,
      range,
      "1d"
    );


  const quote =
    await fetchQuote(
      symbol
    );


  const indicators =
    calculateIndicators(
      history.history
    );


  const ai =
    generateAI(
      quote,
      indicators
    );


  return {

    ok:true,

    symbol:
      displaySymbol(
        history.yahooSymbol
      ),

    yahooSymbol:
      history.yahooSymbol,

    quote,

    history:
      history.history,

    indicators,

    ai

  };

}


/* =========================================================
   SEARCH
========================================================= */

const localStocks = [

  {
    symbol:"2330",
    name:"台積電",
    market:"TW"
  },

  {
    symbol:"2317",
    name:"鴻海",
    market:"TW"
  },

  {
    symbol:"2454",
    name:"聯發科",
    market:"TW"
  },

  {
    symbol:"2303",
    name:"聯電",
    market:"TW"
  },

  {
    symbol:"2308",
    name:"台達電",
    market:"TW"
  },

  {
    symbol:"2382",
    name:"廣達",
    market:"TW"
  },

  {
    symbol:"2603",
    name:"長榮",
    market:"TW"
  },

  {
    symbol:"2615",
    name:"萬海",
    market:"TW"
  },

  {
    symbol:"2881",
    name:"富邦金",
    market:"TW"
  },

  {
    symbol:"2882",
    name:"國泰金",
    market:"TW"
  },

  {
    symbol:"NVDA",
    name:"NVIDIA",
    market:"US"
  },

  {
    symbol:"AAPL",
    name:"Apple",
    market:"US"
  },

  {
    symbol:"MSFT",
    name:"Microsoft",
    market:"US"
  },

  {
    symbol:"AMZN",
    name:"Amazon",
    market:"US"
  },

  {
    symbol:"GOOGL",
    name:"Alphabet",
    market:"US"
  },

  {
    symbol:"META",
    name:"Meta",
    market:"US"
  },

  {
    symbol:"TSLA",
    name:"Tesla",
    market:"US"
  },

  {
    symbol:"AMD",
    name:"AMD",
    market:"US"
  },

  {
    symbol:"AVGO",
    name:"Broadcom",
    market:"US"
  },

  {
    symbol:"TSM",
    name:"Taiwan Semiconductor",
    market:"US"
  },

  {
    symbol:"NFLX",
    name:"Netflix",
    market:"US"
  },

  {
    symbol:"COST",
    name:"Costco",
    market:"US"
  },

  {
    symbol:"ORCL",
    name:"Oracle",
    market:"US"
  },

  {
    symbol:"INTC",
    name:"Intel",
    market:"US"
  },

  {
    symbol:"QCOM",
    name:"Qualcomm",
    market:"US"
  }

];


async function searchYahoo(
  keyword
) {

  const key =
    keyword
      .trim()
      .toUpperCase();


  const cached =
    cacheGet(
      searchCache,
      key
    );


  if (cached)
    return cached;


  const url =
    "https://query1.finance.yahoo.com/v1/finance/search?q=" +
    encodeURIComponent(key) +
    "&quotesCount=20" +
    "&newsCount=0";


  const data =
    await yahooFetch(url);


  const results =
    (data.quotes || [])
      .filter(
        q =>
          q.quoteType ===
            "EQUITY" ||
          q.quote
