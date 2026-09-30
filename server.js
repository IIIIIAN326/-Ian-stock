const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const ALPHA_KEY = process.env.ALPHA_VANTAGE_KEY || '';

const quoteCache = new Map();
const historyCache = new Map();

const taiwanCache = {
  at: 0,
  data: []
};

const QUOTE_TTL = 30000;
const HISTORY_TTL = 300000;
const TAIWAN_TTL = 60000;

const NAME = {
  '1101': '台泥',
  '1102': '亞泥',
  '1103': '嘉泥',
  '2301': '光寶科',
  '2303': '聯電',
  '2317': '鴻海',
  '2330': '台積電',
  '2356': '英業達',
  '2408': '南亞科',
  '2454': '聯發科',
  '2609': '陽明',
  '2610': '華航',
  '2881': '富邦金',
  '2912': '統一超',
  '3035': '智原'
};

function symbolOf(value) {
  return String(value || '').trim().toUpperCase();
}

function isTaiwanSymbol(symbol) {
  return /^\d{4,6}$/.test(symbol);
}

function yahooSymbol(symbol) {
  return isTaiwanSymbol(symbol)
    ? `${symbol}.TW`
    : symbol;
}

function toNumber(value) {
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

  return Number.isFinite(n)
    ? n
    : null;
}

async function fetchJson(
  url,
  timeout = 12000
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response =
      await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'IAN-STOCK/13.0',
          'Accept':
            'application/json,text/plain,*/*'
        }
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirst(
  urls,
  timeout = 12000
) {
  for (const url of urls) {
    try {
      const data =
        await fetchJson(
          url,
          timeout
        );

      if (
        data !== null &&
        data !== undefined
      ) {
        return data;
      }
    } catch (_) {}
  }

  return null;
}


/* =========================
   TWSE
========================= */

function normalizeTwse(row) {
  const symbol =
    symbolOf(row.Code);

  const price =
    toNumber(
      row.ClosingPrice
    );

  if (
    !/^\d{4,6}$/.test(symbol) ||
    price === null
  ) {
    return null;
  }

  const change =
    toNumber(row.Change);

  const previousClose =
    change === null
      ? null
      : price - change;

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

    previousClose,

    change,

    changePct:
      previousClose
        ? change /
          previousClose *
          100
        : null,

    open:
      toNumber(
        row.OpeningPrice
      ),

    high:
      toNumber(
        row.HighestPrice
      ),

    low:
      toNumber(
        row.LowestPrice
      ),

    volume:
      toNumber(
        row.TradeVolume
      ),

    currency: 'TWD',

    timestamp:
      Date.now(),

    source: 'TWSE'
  };
}


/* =========================
   TPEx
========================= */

function normalizeTpex(row) {
  const symbol =
    symbolOf(
      row.SecuritiesCompanyCode ??
      row.Code ??
      row.SecuritiesCode
    );

  const price =
    toNumber(
      row.Close ??
      row.ClosingPrice ??
      row.Closing_Price
    );

  if (
    !/^\d{4,6}$/.test(symbol) ||
    price === null
  ) {
    return null;
  }

  const change =
    toNumber(
      row.Change ??
      row.PriceChange
    );

  const previousClose =
    change === null
      ? null
      : price - change;

  return {
    symbol,

    name:
      String(
        row.CompanyName ??
        row.Name ??
        NAME[symbol] ??
        symbol
      ).trim(),

    market: 'TW',
    exchange: 'TPEx',

    price,

    previousClose,

    change,

    changePct:
      previousClose
        ? change /
          previousClose *
          100
        : null,

    open:
      toNumber(
        row.Open ??
        row.OpeningPrice
      ),

    high:
      toNumber(
        row.High ??
        row.HighestPrice
      ),

    low:
      toNumber(
        row.Low ??
        row.LowestPrice
      ),

    volume:
      toNumber(
        row.TradingShares ??
        row.TradeVolume ??
        row.Volume
      ),

    currency: 'TWD',

    timestamp:
      Date.now(),

    source: 'TPEx'
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
    taiwanCache.data.length &&
    Date.now() -
      taiwanCache.at <
      TAIWAN_TTL
  ) {
    return taiwanCache.data;
  }

  const twsePromise =
    fetchFirst([
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
    ]);

  const tpexPromise =
    fetchFirst([
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'
    ]);

  const [
    twse,
    tpex
  ] = await Promise.all([
    twsePromise,
    tpexPromise
  ]);

  const map =
    new Map();

  if (
    Array.isArray(twse)
  ) {
    for (
      const row of twse
    ) {
      const item =
        normalizeTwse(row);

      if (item) {
        map.set(
          item.symbol,
          item
        );
      }
    }
  }

  if (
    Array.isArray(tpex)
  ) {
    for (
      const row of tpex
    ) {
      const item =
        normalizeTpex(row);

      if (item) {
        map.set(
          item.symbol,
          item
        );
      }
    }
  }

  const data =
    [...map.values()]
      .sort(
        (a, b) =>
          a.symbol.localeCompare(
            b.symbol
          )
      );

  taiwanCache.at =
    Date.now();

  taiwanCache.data =
    data;

  return data;
}


/* =========================
   Yahoo
========================= */

function fromYahoo(
  symbol,
  payload
) {
  const meta =
    payload
      ?.chart
      ?.result?.[0]
      ?.meta;

  if (!meta) {
    return null;
  }

  const price =
    Number(
      meta.regularMarketPrice ??
      meta.previousClose
    );

  const previousClose =
    Number(
      meta.chartPreviousClose ??
      meta.previousClose
    );

  if (
    !Number.isFinite(price)
  ) {
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
      isTaiwanSymbol(symbol)
        ? 'TW'
        : 'US',

    exchange:
      meta.exchangeName ||
      meta.fullExchangeName ||
      '',

    price,

    previousClose:
      Number.isFinite(
        previousClose
      )
        ? previousClose
        : null,

    changePct:
      Number.isFinite(
        previousClose
      ) &&
      previousClose !== 0
        ? (
            (
              price -
              previousClose
            ) /
            previousClose
          ) *
          100
        : null,

    currency:
      meta.currency ||
      (
        isTaiwanSymbol(symbol)
          ? 'TWD'
          : 'USD'
      ),

    volume:
      Number(
        meta.regularMarketVolume
      ) || null,

    timestamp:
      meta.regularMarketTime
        ? meta.regularMarketTime *
          1000
        : Date.now(),

    source:
      'Yahoo Finance'
  };
}

async function yahooQuote(
  symbol
) {
  const key =
    `quote:${symbol}`;

  const cached =
    quoteCache.get(key);

  if (
    cached &&
    Date.now() -
      cached.at <
      QUOTE_TTL
  ) {
    return cached.data;
  }

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(
      yahooSymbol(symbol)
    ) +
    '?range=5d&interval=1d&events=div%2Csplits';

  const payload =
    await fetchJson(url);

  const data =
    fromYahoo(
      symbol,
      payload
    );

  if (data) {
    quoteCache.set(
      key,
      {
        at: Date.now(),
        data
      }
    );
  }

  return data;
}


/* =========================
   Alpha Vantage
========================= */

async function alphaQuote(
  symbol
) {
  if (
    !ALPHA_KEY ||
    isTaiwanSymbol(symbol)
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
      encodeURIComponent(
        ALPHA_KEY
      );

    const payload =
      await fetchJson(url);

    const q =
      payload?.[
        'Global Quote'
      ];

    const price =
      toNumber(
        q?.['05. price']
      );

    if (
      price === null
    ) {
      return null;
    }

    return {
      symbol,

      name:
        NAME[symbol] ||
        symbol,

      market: 'US',

      price,

      previousClose:
        toNumber(
          q?.['08. previous close']
        ),

      changePct:
        toNumber(
          String(
            q?.[
              '10. change percent'
            ] || ''
          ).replace(
            '%',
            ''
          )
        ),

      currency: 'USD',

      volume:
        toNumber(
          q?.['06. volume']
        ),

      timestamp:
        Date.now(),

      source:
        'Alpha Vantage'
    };

  } catch (_) {
    return null;
  }
}


/* =========================
   單股
========================= */

async function getQuote(
  symbol
) {
  symbol =
    symbolOf(symbol);

  try {
    const yahoo =
      await yahooQuote(
        symbol
      );

    if (yahoo) {
      return yahoo;
    }
  } catch (_) {}

  if (
    isTaiwanSymbol(symbol)
  ) {
    const stocks =
      await getAllTaiwanStocks();

    const found =
      stocks.find(
        x =>
          x.symbol ===
          symbol
      );

    if (found) {
      return found;
    }
  }

  return await alphaQuote(
    symbol
  );
}


/* =========================
   批量行情
========================= */

async function getQuotes(
  symbols
) {
  const unique =
    [
      ...new Set(
        symbols
          .map(symbolOf)
          .filter(Boolean)
      )
    ].slice(
      0,
      150
    );

  const data = [];

  for (
    const symbol of unique
  ) {
    try {
      const quote =
        await getQuote(
          symbol
        );

      if (quote) {
        data.push(
          quote
        );
      }
    } catch (_) {}
  }

  return data;
}


/* =========================
   歷史
========================= */

async function getHistory(
  symbol,
  range = '3mo',
  interval = '1d'
) {
  symbol =
    symbolOf(symbol);

  const key =
    `history:${symbol}:${range}:${interval}`;

  const cached =
    historyCache.get(key);

  if (
    cached &&
    Date.now() -
      cached.at <
      HISTORY_TTL
  ) {
    return cached.data;
  }

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(
      yahooSymbol(symbol)
    ) +
    '?range=' +
    encodeURIComponent(range) +
    '&interval=' +
    encodeURIComponent(interval);

  const payload =
    await fetchJson(url);

  const result =
    payload
      ?.chart
      ?.result?.[0];

  if (!result) {
    throw new Error(
      'history unavailable'
    );
  }

  const q =
    result
      ?.indicators
      ?.quote?.[0] ||
    {};

  const data = [];

  const times =
    result.timestamp || [];

  for (
    let i = 0;
    i < times.length;
    i++
  ) {
    const close =
      Number(
        q.close?.[i]
      );

    if (
      !Number.isFinite(
        close
      )
    ) {
      continue;
    }

    data.push({

      time:
        times[i] * 1000,

      open:
        Number(
          q.open?.[i]
        ) || null,

      high:
        Number(
          q.high?.[i]
        ) || null,

      low:
        Number(
          q.low?.[i]
        ) || null,

      close,

      volume:
        Number(
          q.volume?.[i]
        ) || 0
    });
  }

  historyCache.set(
    key,
    {
      at: Date.now(),
      data
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
        (a, b) =>
          a + b,
        0
      ) / n
  );
}

function ema(
  values,
  n
) {
  if (
    values.length < n
  ) {
    return null;
  }

  const k =
    2 / (n + 1);

  let value =
    values
      .slice(0, n)
      .reduce(
        (a, b) =>
          a + b,
        0
      ) / n;

  for (
    let i = n;
    i < values.length;
    i++
  ) {
    value =
      values[i] * k +
      value * (1 - k);
  }

  return value;
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

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= n;
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
    gains / n;

  let avgLoss =
    losses / n;

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
        Math.max(
          diff,
          0
        )
      ) / n;

    avgLoss =
      (
        avgLoss * (n - 1) +
        Math.max(
          -diff,
          0
        )
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
        avgGain /
          avgLoss
      )
  );
}

function indicators(
  data
) {
  const closes =
    data.map(
      x => x.close
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

  const e12 =
    ema(
      closes,
      12
    );

  const e26 =
    ema(
      closes,
      26
    );

  let sd20 = null;

  if (
    closes.length >= 20
  ) {
    const values =
      closes.slice(-20);

    const mean =
      values.reduce(
        (a, b) =>
          a + b,
        0
      ) / 20;

    sd20 =
      Math.sqrt(
        values.reduce(
          (sum, value) =>
            sum +
            (
              value -
              mean
            ) ** 2,
          0
        ) / 20
      );
  }

  return {

    MA5:
      sma(
        closes,
        5
      ),

    MA20:
      ma20,

    MA60:
      ma60,

    EMA12:
      e12,

    EMA26:
      e26,

    RSI:
      rsi(closes),

    MACD:
      e12 !== null &&
      e26 !== null
        ? e12 - e26
        : null,

    Bollinger:
      ma20 !== null &&
      sd20 !== null
        ? {
            middle:
              ma20,

            upper:
              ma20 +
              2 * sd20,

            lower:
              ma20 -
              2 * sd20
          }
        : null,

    volume:
      data.length
        ? data[
            data.length - 1
          ].volume
        : 0,

    support:
      closes.length
        ? Math.min(
            ...closes.slice(-20)
          )
        : null,

    resistance:
      closes.length
        ? Math.max(
            ...closes.slice(-20)
          )
        : null
  };
}

function makeAnalysis(
  data,
  price
) {
  let score = null;
  let trend =
    '資料不足';

  let momentum =
    '資料不足';

  if (
    Number.isFinite(
      price
    ) &&
    Number.isFinite(
      data.MA20
    ) &&
    Number.isFinite(
      data.RSI
    )
  ) {

    let s = 50;

    if (
      price >
      data.MA20
    ) {
      s += 10;
    }

    if (
      Number.isFinite(
        data.MA60
      ) &&
      price >
        data.MA60
    ) {
      s += 8;
    }

    if (
      data.RSI > 55
    ) {
      s += 8;
    }

    if (
      data.RSI > 70
    ) {
      s -= 10;
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
      price >
      data.MA20
        ? '偏多觀察'
        : '偏弱觀察';

    momentum =
      data.RSI > 60
        ? '動能偏強'
        : data.RSI < 40
          ? '動能偏弱'
          : '中性';
  }

  return {
    ...data,
    score,
    trend,
    momentum,
    note:
      '技術資料摘要，僅供資訊參考，不代表投資建議。'
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
        '13.0.0',

      status:
        'ONLINE',

      node:
        process.version,

      alphaVantageConfigured:
        Boolean(
          ALPHA_KEY
        ),

      taiwanStocksCached:
        taiwanCache.data.length
    });
  }
);


/* 全台股 */

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
          'TWSE + TPEx OpenAPI'
      });

    } catch (error) {

      res.status(502).json({
        error:
          '台股全市場行情暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 批量行情 */

app.get(
  '/api/quotes',
  async (req, res) => {
    try {

      const symbols =
        String(
          req.query.symbols ||
          ''
        )
          .split(',')
          .map(symbolOf)
          .filter(Boolean);

      const data =
        await getQuotes(
          symbols
        );

      res.json({
        data,

        requested:
          symbols.length,

        returned:
          data.length,

        timestamp:
          Date.now()
      });

    } catch (error) {

      res.status(502).json({
        error:
          '行情暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* Live */

app.get(
  '/api/live',
  async (req, res) => {
    try {

      const symbols =
        [
          ...new Set(
            String(
              req.query.symbols ||
              ''
            )
              .split(',')
              .map(symbolOf)
              .filter(Boolean)
          )
        ]
          .slice(
            0,
            150
          );

      const taiwan =
        await getAllTaiwanStocks();

      const twMap =
        new Map(
          taiwan.map(
            x => [
              x.symbol,
              x
            ]
          )
        );

      const data = [];

      const us = [];

      for (
        const symbol of symbols
      ) {

        if (
          isTaiwanSymbol(
            symbol
          )
        ) {

          const item =
            twMap.get(
              symbol
            );

          if (item) {
            data.push(
              item
            );
          }

        } else {
          us.push(
            symbol
          );
        }
      }

      if (us.length) {
        data.push(
          ...await getQuotes(
            us
          )
        );
      }

      res.json({
        data,

        timestamp:
          Date.now(),

        source:
          'TWSE + TPEx + Yahoo + Alpha'
      });

    } catch (error) {

      res.status(502).json({
        error:
          '行情暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 單股 */

app.get(
  '/api/quote/:symbol',
  async (req, res) => {
    try {

      const data =
        await getQuote(
          req.params.symbol
        );

      if (!data) {

        return res
          .status(404)
          .json({
            error:
              '找不到行情'
          });
      }

      res.json({
        data
      });

    } catch (error) {

      res.status(502).json({
        error:
          '行情暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 歷史 */

app.get(
  '/api/history/:symbol',
  async (req, res) => {
    try {

      const data =
        await getHistory(
          req.params.symbol,
          req.query.range ||
            '3mo',
          req.query.interval ||
            '1d'
        );

      res.json({
        symbol:
          symbolOf(
            req.params.symbol
          ),

        data
      });

    } catch (error) {

      res.status(502).json({
        error:
          '歷史資料暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 技術分析 */

app.get(
  '/api/analysis/:symbol',
  async (req, res) => {
    try {

      const quote =
        await getQuote(
          req.params.symbol
        );

      const data =
        await getHistory(
          req.params.symbol
        );

      const ind =
        indicators(
          data
        );

      res.json({

        symbol:
          symbolOf(
            req.params.symbol
          ),

        analysis:
          makeAnalysis(
            ind,
            quote?.price
          )
      });

    } catch (error) {

      res.status(502).json({
        error:
          '技術分析暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 完整股票 */

app.get(
  '/api/stock/:symbol',
  async (req, res) => {
    try {

      const symbol =
        symbolOf(
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

      const ind =
        indicators(
          history
        );

      res.json({

        quote,

        history,

        indicators: ind,

        analysis:
          makeAnalysis(
            ind,
            quote?.price
          )
      });

    } catch (error) {

      res.status(502).json({
        error:
          '股票資料暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 搜尋 */

app.get(
  '/api/search',
  async (req, res) => {

    const q =
      String(
        req.query.q ||
        ''
      ).trim();

    if (!q) {
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
            x =>
              x.symbol.includes(
                q.toUpperCase()
              ) ||
              x.name.includes(
                q
              )
          )
          .slice(
            0,
            50
          )
          .map(
            x => ({
              symbol:
                x.symbol,

              name:
                x.name,

              market:
                'TW',

              exchange:
                x.exchange
            })
          );

      if (
        local.length
      ) {
        return res.json({
          data: local
        });
      }

      const payload =
        await fetchJson(
          'https://query1.finance.yahoo.com/v1/finance/search?q=' +
          encodeURIComponent(q) +
          '&quotesCount=20&newsCount=0'
        );

      const data =
        (
          payload.quotes ||
          []
        )
          .filter(
            x =>
              x.quoteType ===
                'EQUITY' ||
              x.quoteType ===
                'ETF'
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
                x.exchange ===
                'TAI'
                  ? 'TW'
                  : 'US'
            })
          );

      res.json({
        data
      });

    } catch (_) {

      res.json({
        data: []
      });
    }
  }
);


/* 市場指數 */

app.get(
  '/api/market',
  async (req, res) => {

    try {

      const data =
        await getQuotes([
          '^TWII',
          '^GSPC',
          '^IXIC',
          '^DJI'
        ]);

      res.json({
        data,

        timestamp:
          Date.now()
      });

    } catch (error) {

      res.status(502).json({
        error:
          '市場指數暫時無法取得',

        detail:
          error.message
      });
    }
  }
);


/* 法人資料 */

app.get(
  '/api/institutional/:symbol',
  (req, res) => {

    res.json({

      symbol:
        symbolOf(
          req.params.symbol
        ),

      source:
        'DATA SOURCE N/A',

      date:
        null,

      foreignBuy:
        null,

      foreignSell:
        null,

      trustBuy:
        null,

      trustSell:
        null,

      dealerBuy:
        null,

      dealerSell:
        null
    });
  }
);


/* 啟動 */

app.listen(
  PORT,
  () => {

    console.log(
      `IAN STOCK API 13.0.0 listening on ${PORT}`
    );

  }
);
