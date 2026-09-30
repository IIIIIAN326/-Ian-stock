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
const TW_MARKET_CACHE = { t: 0, v: [] };

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
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url, ms = 10000) {

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    ms
  );

  try {

    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'IAN-STOCK/11.0',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return await r.json();

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   Yahoo
========================= */

function quoteFromYahoo(s, j) {

  const m =
    j?.chart?.result?.[0]?.meta;

  if (!m) return null;

  const price =
    Number(
      m.regularMarketPrice ??
      m.previousClose
    );

  const prev =
    Number(
      m.chartPreviousClose ??
      m.previousClose
    );

  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    symbol: s,

    name:
      NAME[s] ||
      m.longName ||
      m.shortName ||
      s,

    market:
      /^\d{4}$/.test(s)
        ? 'TW'
        : 'US',

    price,

    previousClose:
      Number.isFinite(prev)
        ? prev
        : null,

    changePct:
      Number.isFinite(prev) && prev
        ? ((price - prev) / prev) * 100
        : null,

    currency:
      m.currency ||
      (/^\d{4}$/.test(s)
        ? 'TWD'
        : 'USD'),

    exchange:
      m.exchangeName ||
      m.fullExchangeName ||
      '',

    timestamp:
      m.regularMarketTime
        ? m.regularMarketTime * 1000
        : Date.now(),

    volume:
      Number(m.regularMarketVolume) || null
  };
}

async function yahooQuote(s) {

  const key = 'q:' + s;

  const old = CACHE.get(key);

  if (
    old &&
    Date.now() - old.t < TTL
  ) {
    return old.v;
  }

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(
      yahooSymbol(s)
    ) +
    '?range=5d&interval=1d&events=div%2Csplits';

  const j =
    await fetchJSON(url);

  const q =
    quoteFromYahoo(s, j);

  if (q) {
    CACHE.set(
      key,
      {
        t: Date.now(),
        v: q
      }
    );
  }

  return q;
}

/* =========================
   Alpha Vantage 美股備援
========================= */

async function alphaQuote(s) {

  if (
    !ALPHA_KEY ||
    /^\d{4}$/.test(s)
  ) {
    return null;
  }

  try {

    const url =
      'https://www.alphavantage.co/query' +
      '?function=GLOBAL_QUOTE' +
      '&symbol=' +
      encodeURIComponent(s) +
      '&apikey=' +
      encodeURIComponent(ALPHA_KEY);

    const j =
      await fetchJSON(url);

    const q =
      j?.['Global Quote'];

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
      symbol: s,
      name: NAME[s] || s,
      market: 'US',
      price,

      changePct:
        Number.isFinite(pct)
          ? pct
          : null,

      previousClose:
        Number(
          q['08. previous close']
        ) || null,

      currency: 'USD',

      timestamp: Date.now(),

      volume:
        Number(q['06. volume']) || null
    };

  } catch {

    return null;
  }
}

/* =========================
   TWSE
========================= */

function num(v) {

  if (
    v === null ||
    v === undefined ||
    v === ''
  ) {
    return null;
  }

  const n =
    Number(
      String(v)
        .replace(/,/g, '')
        .replace(/%/g, '')
        .trim()
    );

  return Number.isFinite(n)
    ? n
    : null;
}

function normalizeTwse(row) {

  const symbol =
    normSymbol(row.Code);

  if (!/^\d{4}$/.test(symbol)) {
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
      row.SecuritiesCompanyCode
    );

  if (!/^\d{4}$/.test(symbol)) {
    return null;
  }

  const price =
    num(row.Close);

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
      num(row.Open),

    high:
      num(row.High),

    low:
      num(row.Low),

    volume:
      num(row.TradingShares),

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

  const [twse, tpex] =
    await Promise.all([

      fetchJSON(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        15000
      ).catch(() => []),

      fetchJSON(
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
        15000
      ).catch(() => [])

    ]);

  const map =
    new Map();

  for (
    const row of
    Array.isArray(twse)
      ? twse
      : []
  ) {

    const q =
      normalizeTwse(row);

    if (q) {
      map.set(
        q.symbol,
        q
      );
    }
  }

  for (
    const row of
    Array.isArray(tpex)
      ? tpex
      : []
  ) {

    const q =
      normalizeTpex(row);

    if (q) {
      map.set(
        q.symbol,
        q
      );
    }
  }

  const out =
    [...map.values()];

  TW_MARKET_CACHE.t =
    Date.now();

  TW_MARKET_CACHE.v =
    out;

  return out;
}

/* =========================
   單檔行情
========================= */

async function getQuote(s) {

  s = normSymbol(s);

  try {

    const q =
      await yahooQuote(s);

    if (q) {
      return q;
    }

  } catch {}

  const a =
    await alphaQuote(s);

  if (a) {
    return a;
  }

  if (/^\d{4}$/.test(s)) {

    const arr =
      await getAllTaiwanStocks();

    return (
      arr.find(
        x => x.symbol === s
      ) || null
    );
  }

  return null;
}

/* =========================
   多檔
========================= */

async function mapLimit(
  items,
  limit,
  fn
) {

  const out =
    new Array(items.length);

  let next = 0;

  async function worker() {

    while (true) {

      const i = next++;

      if (
        i >= items.length
      ) {
        return;
      }

      try {

        out[i] =
          await fn(
            items[i],
            i
          );

      } catch {

        out[i] = null;
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

  return out;
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

  const out =
    await mapLimit(
      clean,
      8,
      getQuote
    );

  return out.filter(Boolean);
}

/* =========================
   K線歷史
========================= */

async function history(
  s,
  range = '3mo',
  interval = '1d'
) {

  s =
    normSymbol(s);

  const key =
    `h:${s}:${range}:${interval}`;

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
      yahooSymbol(s)
    ) +
    '?range=' +
    encodeURIComponent(range) +
    '&interval=' +
    encodeURIComponent(interval) +
    '&events=div%2Csplits';

  const j =
    await fetchJSON(url);

  const r =
    j?.chart?.result?.[0];

  if (!r) {
    throw new Error(
      '沒有歷史資料'
    );
  }

  const q =
    r.indicators?.quote?.[0] ||
    {};

  const a = [];

  for (
    let i = 0;
    i <
    (r.timestamp || []).length;
    i++
  ) {

    const close =
      Number(
        q.close?.[i]
      );

    if (
      Number.isFinite(close)
    ) {

      a.push({

        time:
          r.timestamp[i] *
          1000,

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
  }

  HISTORY_CACHE.set(
    key,
    {
      t: Date.now(),
      v: a
    }
  );

  return a;
}

/* =========================
   技術指標
========================= */

function sma(v, n) {

  return v.length < n
    ? null
    : v
        .slice(-n)
        .reduce(
          (a, b) => a + b,
          0
        ) / n;
}

function emaSeries(v, n) {

  if (v.length < n) {
    return [];
  }

  const k =
    2 / (n + 1);

  let e =
    v
      .slice(0, n)
      .reduce(
        (a, b) => a + b,
        0
      ) / n;

  const out = [e];

  for (
    let i = n;
    i < v.length;
    i++
  ) {

    e =
      v[i] * k +
      e * (1 - k);

    out.push(e);
  }

  return out;
}

function rsi(v, n = 14) {

  if (v.length <= n) {
    return null;
  }

  let g = 0;
  let l = 0;

  for (
    let i = 1;
    i <= n;
    i++
  ) {

    const d =
      v[i] - v[i - 1];

    if (d >= 0) {
      g += d;
    } else {
      l -= d;
    }
  }

  let ag = g / n;
  let al = l / n;

  for (
    let i = n + 1;
    i < v.length;
    i++
  ) {

    const d =
      v[i] - v[i - 1];

    ag =
      (
        ag * (n - 1) +
        (d > 0 ? d : 0)
      ) / n;

    al =
      (
        al * (n - 1) +
        (d < 0 ? -d : 0)
      ) / n;
  }

  return al === 0
    ? 100
    : 100 -
        100 /
          (
            1 +
            ag / al
          );
}

function atr(a, n = 14) {

  if (
    a.length <
    n + 1
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < a.length;
    i++
  ) {

    tr.push(
      Math.max(
        a[i].high -
          a[i].low,

        Math.abs(
          a[i].high -
          a[i - 1].close
        ),

        Math.abs(
          a[i].low -
          a[i - 1].close
        )
      )
    );
  }

  return (
    tr
      .slice(-n)
      .reduce(
        (x, y) => x + y,
        0
      ) / n
  );
}

function indicators(a) {

  const c =
    a.map(x => x.close);

  const v =
    a.map(
      x => x.volume || 0
    );

  const e12 =
    emaSeries(c, 12);

  const e26 =
    emaSeries(c, 26);

  const macd =
    e12.length &&
    e26.length
      ? e12.at(-1) -
        e26.at(-1)
      : null;

  const sd = n => {

    if (c.length < n) {
      return null;
    }

    const z =
      c.slice(-n);

    const m =
      z.reduce(
        (x, y) => x + y,
        0
      ) / n;

    return Math.sqrt(
      z.reduce(
        (x, y) =>
          x +
          (y - m) ** 2,
        0
      ) / n
    );
  };

  const ma20 =
    sma(c, 20);

  const s20 =
    sd(20);

  return {

    MA5:
      sma(c, 5),

    MA20:
      ma20,

    MA60:
      sma(c, 60),

    EMA12:
      e12.at(-1) || null,

    EMA26:
      e26.at(-1) || null,

    RSI:
      rsi(c),

    MACD:
      macd,

    Bollinger:
      ma20 !== null &&
      s20 !== null
        ? {
            middle: ma20,
            upper:
              ma20 +
              2 * s20,
            lower:
              ma20 -
              2 * s20
          }
        : null,

    ATR:
      atr(a),

    volume:
      v.at(-1) || 0,

    support:
      c.length
        ? Math.min(
            ...c.slice(-20)
          )
        : null,

    resistance:
      c.length
        ? Math.max(
            ...c.slice(-20)
          )
        : null
  };
}

/* =========================
   AI資訊摘要
========================= */

function analysis(ind, last) {

  let score = null;

  let trend =
    '資料不足';

  let momentum =
    '資料不足';

  let risk =
    '資料不足';

  if (
    Number.isFinite(ind.RSI) &&
    Number.isFinite(ind.MA20) &&
    Number.isFinite(last)
  ) {

    let s = 50;

    if (
      last > ind.MA20
    ) s += 10;

    if (
      ind.RSI > 55
    ) s += 8;

    if (
      ind.RSI > 70
    ) s -= 10;

    if (
      ind.RSI < 30
    ) s += 5;

    if (
      Number.isFinite(ind.MA60) &&
      last > ind.MA60
    ) s += 8;

    score =
      Math.max(
        0,
        Math.min(
          100,
          Math.round(s)
        )
      );

    trend =
      last > ind.MA20
        ? '偏多觀察'
        : '偏弱觀察';

    momentum =
      ind.RSI > 60
        ? '動能偏強'
        : ind.RSI < 40
          ? '動能偏弱'
          : '中性';

    risk =
      ind.ATR &&
      last
        ? ind.ATR / last > 0.04
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
    ...ind
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
        '11.0.0',

      status:
        'ONLINE',

      yahooFinance:
        'ENABLED',

      alphaVantageConfigured:
        Boolean(ALPHA_KEY)

    });
  }
);

app.get(
  '/api/tw-stocks',
  async (req, res) => {

    try {

      const data =
        await getAllTaiwanStocks();

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

app.get(
  '/api/quote/:symbol',
  async (req, res) => {

    try {

      const q =
        await getQuote(
          req.params.symbol
        );

      if (!q) {

        return res
          .status(502)
          .json({
            error:
              '行情來源暫時無法取得'
          });
      }

      res.json({
        data: q
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
        ''
      ).split(',');

    const data =
      await getQuotes(raw);

    res.json({
      data,
      returned:
        data.length,
      timestamp:
        Date.now()
    });
  }
);

app.get(
  '/api/live',
  async (req, res) => {

    try {

      const raw =
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

      const selected =
        raw.filter(
          x => /^\d{4}$/.test(x)
        );

      const us =
        raw.filter(
          x => !/^\d{4}$/.test(x)
        );

      const data = [

        ...selected
          .map(
            x => twMap.get(x)
          )
          .filter(Boolean),

        ...(
          us.length
            ? await getQuotes(us)
            : []
        )

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

      const q =
        await getQuote(
          req.params.symbol
        );

      const h =
        await history(
          req.params.symbol
        );

      const ind =
        indicators(h);

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        analysis:
          analysis(
            ind,
            q?.price
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

      const q =
        await getQuote(
          req.params.symbol
        );

      const h =
        await history(
          req.params.symbol
        );

      const ind =
        indicators(h);

      res.json({

        quote: q,

        history: h,

        analysis:
          analysis(
            ind,
            q?.price
          )

      });

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
   搜尋
========================= */

app.get(
  '/api/search',
  async (req, res) => {

    const q =
      String(
        req.query.q || ''
      ).trim();

    if (!q) {
      return res.json({
        data: []
      });
    }

    try {

      const tw =
        await getAllTaiwanStocks();

      const local =
        tw
          .filter(
            x =>
              x.symbol.includes(
                q.toUpperCase()
              ) ||
              x.name.includes(q)
          )
          .slice(0, 20)
          .map(
            x => ({
              symbol: x.symbol,
              name: x.name,
              market: 'TW'
            })
          );

      if (local.length) {

        return res.json({
          data: local
        });
      }

      const j =
        await fetchJSON(
          'https://query1.finance.yahoo.com/v1/finance/search?q=' +
          encodeURIComponent(q) +
          '&quotesCount=15&newsCount=0'
        );

      const data =
        (j.quotes || [])
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
   大盤
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
   網頁
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

app.listen(
  PORT,
  () => {

    console.log(
      'IAN STOCK API 11.0.0 listening on ' +
      PORT
    );

  }
);
