const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ALPHA_KEY = process.env.ALPHA_VANTAGE_KEY || '';

const CACHE = new Map();
const HISTORY_CACHE = new Map();

const TW_MARKET_CACHE = {
  t: 0,
  v: []
};

const TTL = 30 * 1000;
const HISTORY_TTL = 5 * 60 * 1000;

const NAME = {
  '1101':'台泥',
  '1102':'亞泥',
  '1103':'嘉泥',
  '2330':'台積電',
  '2317':'鴻海',
  '2454':'聯發科',
  '2303':'聯電',
  '2301':'光寶科',
  '2356':'英業達',
  '2408':'南亞科',
  '2609':'陽明',
  '2610':'華航',
  '2881':'富邦金',
  '2912':'統一超',
  '3035':'智原',

  'NVDA':'NVIDIA',
  'AAPL':'Apple',
  'MSFT':'Microsoft',
  'TSLA':'Tesla',
  'AMZN':'Amazon'
};

function normSymbol(s) {
  return String(s || '').trim().toUpperCase();
}

function yahooSymbol(s) {
  s = normSymbol(s);
  return /^\d{4}$/.test(s) ? s + '.TW' : s;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSON(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'IAN-STOCK/12.0',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}

function num(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const n = Number(
    String(value)
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim()
  );

  return Number.isFinite(n) ? n : null;
}

/* =========================
   Yahoo Finance
========================= */

function quoteFromYahoo(symbol, json) {

  const meta = json?.chart?.result?.[0]?.meta;

  if (!meta) {
    return null;
  }

  const price = Number(
    meta.regularMarketPrice ??
    meta.previousClose
  );

  const previous = Number(
    meta.chartPreviousClose ??
    meta.previousClose
  );

  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    symbol,
    name:
      NAME[symbol] ||
      meta.longName ||
      meta.shortName ||
      symbol,

    market:
      /^\d{4}$/.test(symbol)
        ? 'TW'
        : 'US',

    price,

    previousClose:
      Number.isFinite(previous)
        ? previous
        : null,

    changePct:
      Number.isFinite(previous) &&
      previous !== 0
        ? ((price - previous) / previous) * 100
        : null,

    currency:
      meta.currency ||
      (/^\d{4}$/.test(symbol) ? 'TWD' : 'USD'),

    exchange:
      meta.exchangeName ||
      meta.fullExchangeName ||
      '',

    timestamp:
      meta.regularMarketTime
        ? meta.regularMarketTime * 1000
        : Date.now(),

    volume:
      Number(meta.regularMarketVolume) || null
  };
}

async function yahooQuote(symbol) {

  const key = 'q:' + symbol;
  const old = CACHE.get(key);

  if (
    old &&
    Date.now() - old.t < TTL
  ) {
    return old.v;
  }

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSymbol(symbol)) +
    '?range=5d&interval=1d&events=div%2Csplits';

  const json = await fetchJSON(url);

  const quote =
    quoteFromYahoo(symbol, json);

  if (quote) {
    CACHE.set(key, {
      t: Date.now(),
      v: quote
    });
  }

  return quote;
}

/* =========================
   Alpha Vantage
========================= */

async function alphaQuote(symbol) {

  if (
    !ALPHA_KEY ||
    /^\d{4}$/.test(symbol)
  ) {
    return null;
  }

  try {

    const url =
      'https://www.alphavantage.co/query' +
      '?function=GLOBAL_QUOTE' +
      '&symbol=' +
      encodeURIComponent(symbol) +
      '&apikey=' +
      encodeURIComponent(ALPHA_KEY);

    const json =
      await fetchJSON(url);

    const q =
      json?.['Global Quote'];

    if (!q?.['05. price']) {
      return null;
    }

    const price =
      Number(q['05. price']);

    const pct =
      Number(
        String(
          q['10. change percent'] || ''
        ).replace('%', '')
      );

    return {

      symbol,

      name:
        NAME[symbol] || symbol,

      market: 'US',

      price,

      changePct:
        Number.isFinite(pct)
          ? pct
          : null,

      previousClose:
        Number(q['08. previous close']) ||
        null,

      currency: 'USD',

      timestamp: Date.now(),

      volume:
        Number(q['06. volume']) ||
        null
    };

  } catch {

    return null;
  }
}

/* =========================
   TWSE
========================= */

function normalizeTwse(row) {

  const symbol =
    normSymbol(row.Code);

  if (
    !/^\d{4,6}$/.test(symbol)
  ) {
    return null;
  }

  const price =
    num(row.ClosingPrice);

  if (price === null) {
    return null;
  }

  const change =
    num(row.Change);

  const previous =
    change !== null
      ? price - change
      : null;

  return {

    symbol,

    name:
      String(
        row.Name ||
        NAME[symbol] ||
        symbol
      ).trim(),

    market: 'TW',

    exchange: 'TWSE',

    price,

    previousClose:
      previous,

    change,

    changePct:
      previous
        ? change / previous * 100
        : 0,

    open:
      num(row.OpeningPrice),

    high:
      num(row.HighestPrice),

    low:
      num(row.LowestPrice),

    volume:
      num(row.TradeVolume),

    currency: 'TWD',

    timestamp: Date.now()
  };
}

/* =========================
   TPEx
========================= */

function normalizeTpex(row) {

  const symbol =
    normSymbol(
      row.SecuritiesCompanyCode ||
      row.Code
    );

  if (
    !/^\d{4,6}$/.test(symbol)
  ) {
    return null;
  }

  const price =
    num(
      row.Close ??
      row.ClosingPrice
    );

  if (price === null) {
    return null;
  }

  const change =
    num(row.Change);

  const previous =
    change !== null
      ? price - change
      : null;

  return {

    symbol,

    name:
      String(
        row.CompanyName ||
        row.Name ||
        NAME[symbol] ||
        symbol
      ).trim(),

    market: 'TW',

    exchange: 'TPEx',

    price,

    previousClose:
      previous,

    change,

    changePct:
      previous
        ? change / previous * 100
        : 0,

    open:
      num(
        row.Open ??
        row.OpeningPrice
      ),

    high:
      num(
        row.High ??
        row.HighestPrice
      ),

    low:
      num(
        row.Low ??
        row.LowestPrice
      ),

    volume:
      num(
        row.TradingShares ??
        row.TradeVolume
      ),

    currency: 'TWD',

    timestamp: Date.now()
  };
}

/* =========================
   全台股
========================= */

async function getAllTaiwanStocks(
  force = false
) {

  if (
    !force &&
    TW_MARKET_CACHE.v.length &&
    Date.now() -
      TW_MARKET_CACHE.t <
      60000
  ) {
    return TW_MARKET_CACHE.v;
  }

  const twsePromise =
    fetchJSON(
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      15000
    ).catch(() => []);

  const tpexPromise =
    fetchJSON(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      15000
    )
      .catch(() => []);

  const [
    twse,
    tpex
  ] = await Promise.all([
    twsePromise,
    tpexPromise
  ]);

  const map =
    new Map();

  /* TWSE */

  if (Array.isArray(twse)) {

    for (const row of twse) {

      const quote =
        normalizeTwse(row);

      if (quote) {
        map.set(
          quote.symbol,
          quote
        );
      }
    }
  }

  /* TPEx */

  if (Array.isArray(tpex)) {

    for (const row of tpex) {

      const quote =
        normalizeTpex(row);

      if (quote) {
        map.set(
          quote.symbol,
          quote
        );
      }
    }
  }

  const result =
    Array.from(map.values());

  TW_MARKET_CACHE.t =
    Date.now();

  TW_MARKET_CACHE.v =
    result;

  return result;
}

/* =========================
   單股行情
========================= */

async function getQuote(symbol) {

  symbol =
    normSymbol(symbol);

  /* Yahoo */

  try {

    const quote =
      await yahooQuote(symbol);

    if (quote) {
      return quote;
    }

  } catch {}

  /* Alpha Vantage */

  const alpha =
    await alphaQuote(symbol);

  if (alpha) {
    return alpha;
  }

  /* 全台股資料 */

  if (/^\d{4,6}$/.test(symbol)) {

    const stocks =
      await getAllTaiwanStocks();

    const found =
      stocks.find(
        x => x.symbol === symbol
      );

    if (found) {
      return found;
    }
  }

  return null;
}

/* =========================
   批量行情
========================= */

async function mapLimit(
  items,
  limit,
  fn
) {

  const output =
    new Array(items.length);

  let next = 0;

  async function worker() {

    while (true) {

      const index =
        next++;

      if (
        index >= items.length
      ) {
        return;
      }

      try {

        output[index] =
          await fn(
            items[index],
            index
          );

      } catch {

        output[index] =
          null;
      }

      await sleep(80);
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      worker
    )
  );

  return output;
}

async function getQuotes(symbols) {

  const clean =
    [
      ...new Set(
        symbols
          .map(normSymbol)
          .filter(Boolean)
      )
    ].slice(0, 120);

  const output =
    await mapLimit(
      clean,
      8,
      getQuote
    );

  return output.filter(Boolean);
}

/* =========================
   歷史資料
========================= */

async function history(
  symbol,
  range = '3mo',
  interval = '1d'
) {

  symbol =
    normSymbol(symbol);

  const key =
    `h:${symbol}:${range}:${interval}`;

  const old =
    HISTORY_CACHE.get(key);

  if (
    old &&
    Date.now() -
      old.t <
      HISTORY_TTL
  ) {
    return old.v;
  }

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(
      yahooSymbol(symbol)
    ) +
    '?range=' +
    encodeURIComponent(range) +
    '&interval=' +
    encodeURIComponent(interval) +
    '&events=div%2Csplits';

  const json =
    await fetchJSON(url);

  const result =
    json?.chart?.result?.[0];

  if (!result) {
    throw new Error(
      '沒有歷史資料'
    );
  }

  const quote =
    result.indicators?.quote?.[0] || {};

  const data = [];

  for (
    let i = 0;
    i <
    (result.timestamp || []).length;
    i++
  ) {

    const close =
      Number(
        quote.close?.[i]
      );

    if (
      Number.isFinite(close)
    ) {

      data.push({

        time:
          result.timestamp[i] *
          1000,

        open:
          Number(
            quote.open?.[i]
          ) || null,

        high:
          Number(
            quote.high?.[i]
          ) || null,

        low:
          Number(
            quote.low?.[i]
          ) || null,

        close,

        volume:
          Number(
            quote.volume?.[i]
          ) || 0
      });
    }
  }

  HISTORY_CACHE.set(
    key,
    {
      t: Date.now(),
      v: data
    }
  );

  return data;
}

/* =========================
   技術指標
========================= */

function sma(
  values,
  n
) {

  if (
    values.length < n
  ) {
    return null;
  }

  return (
    values
      .slice(-n)
      .reduce(
        (a, b) => a + b,
        0
      ) / n
  );
}

function emaSeries(
  values,
  n
) {

  if (
    values.length < n
  ) {
    return [];
  }

  const k =
    2 / (n + 1);

  let ema =
    values
      .slice(0, n)
      .reduce(
        (a, b) => a + b,
        0
      ) / n;

  const result = [ema];

  for (
    let i = n;
    i < values.length;
    i++
  ) {

    ema =
      values[i] * k +
      ema * (1 - k);

    result.push(ema);
  }

  return result;
}

function rsi(
  values,
  n = 14
) {

  if (
    values.length <= n
  ) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= n;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  let avgGain =
    gain / n;

  let avgLoss =
    loss / n;

  for (
    let i = n + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    avgGain =
      (
        avgGain * (n - 1) +
        (diff > 0 ? diff : 0)
      ) / n;

    avgLoss =
      (
        avgLoss * (n - 1) +
        (diff < 0 ? -diff : 0)
      ) / n;
  }

  if (
    avgLoss === 0
  ) {
    return 100;
  }

  return (
    100 -
    100 /
      (
        1 +
        avgGain / avgLoss
      )
  );
}

function atr(
  data,
  n = 14
) {

  if (
    data.length <
    n + 1
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < data.length;
    i++
  ) {

    tr.push(
      Math.max(
        data[i].high -
          data[i].low,

        Math.abs(
          data[i].high -
          data[i - 1].close
        ),

        Math.abs(
          data[i].low -
          data[i - 1].close
        )
      )
    );
  }

  return (
    tr
      .slice(-n)
      .reduce(
        (a, b) => a + b,
        0
      ) / n
  );
}

function indicators(data) {

  const close =
    data.map(
      x => x.close
    );

  const volume =
    data.map(
      x => x.volume || 0
    );

  const ema12 =
    emaSeries(
      close,
      12
    );

  const ema26 =
    emaSeries(
      close,
      26
    );

  const macd =
    ema12.length &&
    ema26.length
      ? ema12.at(-1) -
        ema26.at(-1)
      : null;

  const standardDeviation =
    n => {

      if (
        close.length < n
      ) {
        return null;
      }

      const values =
        close.slice(-n);

      const mean =
        values.reduce(
          (a, b) => a + b,
          0
        ) / n;

      return Math.sqrt(
        values.reduce(
          (sum, value) =>
            sum +
            (value - mean) ** 2,
          0
        ) / n
      );
    };

  const ma20 =
    sma(close, 20);

  const sd20 =
    standardDeviation(20);

  return {

    MA5:
      sma(close, 5),

    MA20:
      ma20,

    MA60:
      sma(close, 60),

    EMA12:
      ema12.at(-1) || null,

    EMA26:
      ema26.at(-1) || null,

    RSI:
      rsi(close),

    MACD:
      macd,

    Bollinger:
      ma20 !== null &&
      sd20 !== null
        ? {
            middle: ma20,
            upper:
              ma20 + 2 * sd20,
            lower:
              ma20 - 2 * sd20
          }
        : null,

    ATR:
      atr(data),

    VWAP:
      data.length
        ? data.reduce(
            (sum, x) =>
              sum +
              (
                (
                  x.high +
                  x.low +
                  x.close
                ) / 3
              ) *
              (x.volume || 0),
            0
          ) /
          Math.max(
            1,
            volume.reduce(
              (a, b) => a + b,
              0
            )
          )
        : null,

    volume:
      volume.at(-1) || 0,

    support:
      close.length
        ? Math.min(
            ...close.slice(-20)
          )
        : null,

    resistance:
      close.length
        ? Math.max(
            ...close.slice(-20)
          )
        : null
  };
}

/* =========================
   分析
========================= */

function analysis(
  indicator,
  last
) {

  let score = null;
  let trend = '資料不足';
  let momentum = '資料不足';
  let risk = '資料不足';

  if (
    Number.isFinite(
      indicator.RSI
    ) &&
    Number.isFinite(
      indicator.MA20
    ) &&
    Number.isFinite(last)
  ) {

    let s = 50;

    if (
      last >
      indicator.MA20
    ) {
      s += 10;
    }

    if (
      indicator.RSI > 55
    ) {
      s += 8;
    }

    if (
      indicator.RSI > 70
    ) {
      s -= 10;
    }

    if (
      indicator.RSI < 30
    ) {
      s += 5;
    }

    if (
      Number.isFinite(
        indicator.MA60
      ) &&
      last >
        indicator.MA60
    ) {
      s += 8;
    }

    score =
      Math.max(
        0,
        Math.min(
          100,
          Math.round(s)
        )
      );

    trend =
      last > indicator.MA20
        ? '偏多觀察'
        : '偏弱觀察';

    momentum =
      indicator.RSI > 60
        ? '動能偏強'
        : indicator.RSI < 40
          ? '動能偏弱'
          : '中性';

    risk =
      indicator.ATR &&
      last
        ? indicator.ATR /
            last >
          0.04
          ? '波動偏高'
          : '一般'
        : '資料不足';
  }

  return {

    score,
    trend,
    momentum,
    risk,

    note:
      'AI Score 為技術資料的資訊性摘要，不是投資建議。',

    ...indicator
  };
}

/* =========================
   完整股票資料
========================= */

async function stock(symbol) {

  const quote =
    await getQuote(symbol);

  const historyData =
    await history(symbol);

  const indicator =
    indicators(historyData);

  return {

    quote,

    history:
      historyData,

    analysis:
      analysis(
        indicator,
        quote?.price
      )
  };
}

/* =========================
   API
========================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      server:
        'IAN STOCK API',

      version:
        '12.0.0',

      status:
        'ONLINE',

      yahooFinance:
        'ENABLED',

      alphaVantageConfigured:
        Boolean(ALPHA_KEY),

      cacheEntries:
        CACHE.size,

      historyCacheEntries:
        HISTORY_CACHE.size,

      taiwanMarketCache:
        TW_MARKET_CACHE.v.length,

      endpoints: [

        '/api/quotes',

        '/api/quote/:symbol',

        '/api/history/:symbol',

        '/api/analysis/:symbol',

        '/api/stock/:symbol',

        '/api/search',

        '/api/market',

        '/api/tw-stocks',

        '/api/live',

        '/api/institutional/:symbol',

        '/api/status'
      ]
    });
  }
);

app.get(
  '/api/quote/:symbol',
  async (req, res) => {

    try {

      const quote =
        await getQuote(
          req.params.symbol
        );

      if (!quote) {

        return res
          .status(502)
          .json({
            error:
              '行情來源暫時無法取得'
          });
      }

      res.json({
        data: quote
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            '行情來源暫時無法取得'
        });
    }
  }
);

app.get(
  '/api/quotes',
  async (req, res) => {

    const raw =
      (
        req.query.symbols ||
        '2330,2317,2454,NVDA,AAPL,MSFT'
      ).split(',');

    const requested =
      [
        ...new Set(
          raw
            .map(normSymbol)
            .filter(Boolean)
        )
      ];

    const data =
      await getQuotes(
        requested
      );

    res.json({

      data,

      requested:
        requested.length,

      returned:
        data.length,

      timestamp:
        Date.now()
    });
  }
);

app.get(
  '/api/history/:symbol',
  async (req, res) => {

    try {

      const data =
        await history(
          req.params.symbol,
          req.query.range ||
            '3mo',
          req.query.interval ||
            '1d'
        );

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        data
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            '歷史資料暫時無法取得'
        });
    }
  }
);

app.get(
  '/api/analysis/:symbol',
  async (req, res) => {

    try {

      const quote =
        await getQuote(
          req.params.symbol
        );

      const historyData =
        await history(
          req.params.symbol
        );

      const indicator =
        indicators(
          historyData
        );

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        analysis:
          analysis(
            indicator,
            quote?.price
          )
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            '技術分析暫時無法取得'
        });
    }
  }
);

app.get(
  '/api/stock/:symbol',
  async (req, res) => {

    try {

      res.json(
        await stock(
          req.params.symbol
        )
      );

    } catch {

      res
        .status(502)
        .json({
          error:
            '股票資料暫時無法取得'
        });
    }
  }
);

/* =========================
   全台股搜尋
========================= */

app.get(
  '/api/search',
  async (req, res) => {

    const query =
      String(
        req.query.q || ''
      ).trim();

    if (!query) {
      return res.json({
        data: []
      });
    }

    try {

      const stocks =
        await getAllTaiwanStocks();

      const local =
        stocks
          .filter(
            stock =>
              stock.symbol.includes(
                query.toUpperCase()
              ) ||
              stock.name.includes(
                query
              )
          )
          .slice(0, 30)
          .map(
            stock => ({
              symbol:
                stock.symbol,

              name:
                stock.name,

              market:
                'TW'
            })
          );

      if (
        local.length
      ) {

        return res.json({
          data: local
        });
      }

      const yahoo =
        await fetchJSON(
          'https://query1.finance.yahoo.com/v1/finance/search?q=' +
          encodeURIComponent(query) +
          '&quotesCount=20&newsCount=0'
        );

      const data =
        (yahoo.quotes || [])
          .filter(
            x =>
              [
                'EQUITY',
                'ETF'
              ].includes(
                x.quoteType
              )
          )
          .map(
            x => ({
              symbol:
                x.symbol,

              name:
                x.longname ||
                x.shortname ||
                x.symbol,

              market:
                x.exchange === 'TAI'
                  ? 'TW'
                  : 'US'
            })
          );

      res.json({
        data
      });

    } catch {

      res.json({
        data: []
      });
    }
  }
);

/* =========================
   全台股行情
========================= */

app.get(
  '/api/tw-stocks',
  async (req, res) => {

    try {

      const data =
        await getAllTaiwanStocks(
          req.query.force === '1'
        );

      res.json({

        data,

        count:
          data.length,

        timestamp:
          Date.now(),

        source:
          'TWSE + TPEx OpenAPI',

        freshness:
          'latest market snapshot'
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            '台股全市場行情暫時無法取得'
        });
    }
  }
);

/* =========================
   Live 行情
========================= */

app.get(
  '/api/live',
  async (req, res) => {

    try {

      const symbols =
        String(
          req.query.symbols || ''
        )
          .split(',')
          .map(normSymbol)
          .filter(Boolean);

      const tw =
        await getAllTaiwanStocks();

      const twMap =
        new Map(
          tw.map(
            x => [
              x.symbol,
              x
            ]
          )
        );

      const twSymbols =
        symbols.filter(
          x =>
            /^\d{4,6}$/.test(x)
        );

      const usSymbols =
        symbols.filter(
          x =>
            !/^\d{4,6}$/.test(x)
        );

      const data = [

        ...twSymbols
          .map(
            x =>
              twMap.get(x)
          )
          .filter(Boolean),

        ...(usSymbols.length
          ? await getQuotes(
              usSymbols
            )
          : [])
      ];

      res.json({

        data,

        timestamp:
          Date.now()
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            '行情暫時無法取得'
        });
    }
  }
);

/* =========================
   市場指數
========================= */

app.get(
  '/api/market',
  async (req, res) => {

    const symbols = [
      '^TWII',
      '^GSPC',
      '^IXIC',
      '^DJI'
    ];

    const data =
      await getQuotes(
        symbols
      );

    res.json({
      data
    });
  }
);

/* =========================
   法人資料
========================= */

app.get(
  '/api/institutional/:symbol',
  async (req, res) => {

    res.json({

      symbol:
        normSymbol(
          req.params.symbol
        ),

      date: null,

      foreignBuy: null,
      foreignSell: null,

      trustBuy: null,
      trustSell: null,

      dealerBuy: null,
      dealerSell: null,

      source:
        'DATA SOURCE N/A'
    });
  }
);

/* =========================
   Static Website
========================= */

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

app.get(
  '*',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);

/* =========================
   Start
========================= */

app.listen(
  PORT,
  () => {

    console.log(
      `IAN STOCK API 12.0.0 listening on ${PORT}`
    );

  }
);
