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
const TW_REALTIME_CACHE = { t: 0, v: [] };

const REALTIME_TTL = 25000;
const TTL = 25 * 1000;
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
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);

  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: {
        'User-Agent': 'IAN-STOCK/12.0',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }

    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v) {
  if (v === null || v === undefined || v === '') {
    return null;
  }

  const n = Number(
    String(v)
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim()
  );

  return Number.isFinite(n) ? n : null;
}


/* =========================
   Yahoo Finance
========================= */

function quoteFromYahoo(s, j) {
  const m = j?.chart?.result?.[0]?.meta;

  if (!m) {
    return null;
  }

  const price = Number(
    m.regularMarketPrice ?? m.previousClose
  );

  const prev = Number(
    m.chartPreviousClose ?? m.previousClose
  );

  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    symbol: s,
    name: NAME[s] || m.longName || m.shortName || s,
    market: /^\d{4}$/.test(s) ? 'TW' : 'US',
    price,
    previousClose: Number.isFinite(prev) ? prev : null,
    changePct:
      Number.isFinite(prev) && prev
        ? ((price - prev) / prev) * 100
        : null,
    currency:
      m.currency ||
      (/^\d{4}$/.test(s) ? 'TWD' : 'USD'),
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

  const j = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol(s)
    )}?range=5d&interval=1d&events=div%2Csplits`
  );

  const q = quoteFromYahoo(s, j);

  if (q) {
    CACHE.set(key, {
      t: Date.now(),
      v: q
    });
  }

  return q;
}


/* =========================
   Alpha Vantage
========================= */

async function alphaQuote(s) {
  if (
    !ALPHA_KEY ||
    /^\d{4}$/.test(s)
  ) {
    return null;
  }

  try {
    const j = await fetchJSON(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
        s
      )}&apikey=${encodeURIComponent(ALPHA_KEY)}`
    );

    const q = j?.['Global Quote'];

    if (!q?.['05. price']) {
      return null;
    }

    const price = Number(q['05. price']);

    const pct = Number(
      String(q['10. change percent'] || '')
        .replace('%', '')
    );

    return {
      symbol: s,
      name: NAME[s] || s,
      market: 'US',
      price,
      changePct:
        Number.isFinite(pct) ? pct : null,
      previousClose:
        Number(q['08. previous close']) || null,
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

async function twseQuotes() {
  const urls = [
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL'
  ];

  for (const u of urls) {
    try {
      const r = await fetchJSON(u, 10000);

      if (
        Array.isArray(r) &&
        r.length
      ) {
        return r;
      }

    } catch {}
  }

  return [];
}

function normalizeTwse(row) {
  const symbol = normSymbol(row.Code);

  if (!/^\d{4,6}$/.test(symbol)) {
    return null;
  }

  const price = num(row.ClosingPrice);

  if (price === null) {
    return null;
  }

  const change = num(row.Change);

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
    previousClose: previous,

    change,

    changePct:
      previous
        ? (change / previous) * 100
        : 0,

    open: num(row.OpeningPrice),
    high: num(row.HighestPrice),
    low: num(row.LowestPrice),

    volume: num(row.TradeVolume),

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

  if (!/^\d{4,6}$/.test(symbol)) {
    return null;
  }

  const price = num(row.Close);

  if (price === null) {
    return null;
  }

  const change = num(row.Change);

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
    previousClose: previous,

    change,

    changePct:
      previous
        ? (change / previous) * 100
        : 0,

    open: num(row.Open),
    high: num(row.High),
    low: num(row.Low),

    volume: num(row.TradingShares),

    currency: 'TWD',
    timestamp: Date.now()
  };
}


/* =========================
   TWSE 即時行情
========================= */

async function twseMisRealtime(symbols) {
  const out = [];

  const uniq = [
    ...new Set(
      symbols.filter(
        s => /^\d{4}$/.test(s)
      )
    )
  ];

  for (
    let i = 0;
    i < uniq.length;
    i += 80
  ) {

    const chunk =
      uniq.slice(i, i + 80);

    const ex =
      chunk
        .map(
          s => 'tse_' + s + '.tw'
        )
        .join('|');

    try {

      const j = await fetchJSON(
        'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' +
        encodeURIComponent(ex) +
        '&json=1&delay=0&_=' +
        Date.now(),
        12000
      );

      for (
        const z of
        (j?.msgArray || [])
      ) {

        const symbol =
          normSymbol(z.c);

        const price =
          num(z.z);

        const prev =
          num(z.y);

        if (
          !/^\d{4}$/.test(symbol) ||
          price === null
        ) {
          continue;
        }

        out.push({

          symbol,

          name:
            z.n ||
            NAME[symbol] ||
            symbol,

          market: 'TW',
          exchange: 'TWSE',

          price,

          previousClose: prev,

          change:
            prev !== null
              ? price - prev
              : null,

          changePct:
            prev
              ? ((price - prev) / prev) * 100
              : 0,

          open: num(z.o),
          high: num(z.h),
          low: num(z.l),

          volume:
            num(z.v) * 1000 || null,

          currency: 'TWD',

          timestamp: Date.now(),

          source: 'TWSE MIS'
        });
      }

    } catch {}

    if (
      i + 80 <
      uniq.length
    ) {
      await sleep(80);
    }
  }

  return out;
}


/* =========================
   全台股
========================= */

async function getAllTaiwanStocks(force = false) {

  if (
    !force &&
    TW_MARKET_CACHE.v.length &&
    Date.now() -
      TW_MARKET_CACHE.t <
      25000
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
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
        15000
      )
        .catch(() => [])
        .then(x =>
          Array.isArray(x) &&
          x.length
            ? x
            : fetchJSON(
                'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
                15000
              ).catch(() => [])
        )
    ]);

  const map = new Map();

  for (
    const row of
    Array.isArray(twse)
      ? twse
      : []
  ) {

    const q =
      normalizeTwse(row);

    if (q) {
      map.set(q.symbol, q);
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
      map.set(q.symbol, q);
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
   台股即時資料
========================= */

async function getRealtimeTaiwanStocks(
  force = false
) {

  if (
    !force &&
    TW_REALTIME_CACHE.v.length &&
    Date.now() -
      TW_REALTIME_CACHE.t <
      REALTIME_TTL
  ) {
    return TW_REALTIME_CACHE.v;
  }

  const base =
    await getAllTaiwanStocks(false);

  const twseSymbols =
    base
      .filter(
        x => x.exchange === 'TWSE'
      )
      .map(
        x => x.symbol
      );

  const realtime =
    await twseMisRealtime(
      twseSymbols
    );

  const map =
    new Map(
      base.map(
        x => [x.symbol, x]
      )
    );

  realtime.forEach(
    x => map.set(x.symbol, x)
  );

  const out =
    [...map.values()];

  TW_REALTIME_CACHE.t =
    Date.now();

  TW_REALTIME_CACHE.v =
    out;

  return out;
}


/* =========================
   單一股票
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
      await twseQuotes();

    const z =
      arr.find(
        x =>
          String(x.Code) === s
      );

    if (z) {

      const price =
        Number(
          String(
            z.ClosingPrice ?? ''
          ).replace(/,/g, '')
        );

      const change =
        Number(
          String(
            z.Change ?? ''
          ).replace(/,/g, '')
        );

      if (
        Number.isFinite(price)
      ) {

        const previous =
          price - change;

        return {

          symbol: s,

          name:
            z.Name ||
            NAME[s] ||
            s,

          market: 'TW',

          price,

          change:
            Number.isFinite(change)
              ? change
              : null,

          changePct:
            previous
              ? (change / previous) * 100
              : 0,

          open:
            Number(
              String(
                z.OpeningPrice ?? ''
              ).replace(/,/g, '')
            ) || null,

          high:
            Number(
              String(
                z.HighestPrice ?? ''
              ).replace(/,/g, '')
            ) || null,

          low:
            Number(
              String(
                z.LowestPrice ?? ''
              ).replace(/,/g, '')
            ) || null,

          volume:
            Number(
              String(
                z.TradeVolume ?? ''
              ).replace(/,/g, '')
            ) || null,

          currency: 'TWD',

          timestamp: Date.now()
        };
      }
    }
  }

  return null;
}


/* =========================
   多股票
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

async function getQuotes(
  symbols
) {

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
   歷史資料
========================= */

function parseYahooHistory(j) {

  const r =
    j?.chart?.result?.[0];

  if (!r) {
    return [];
  }

  const q =
    r.indicators?.quote?.[0] ||
    {};

  const a = [];

  for (
    let i = 0;
    i < (r.timestamp || []).length;
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
          r.timestamp[i] * 1000,

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

  return a;
}

async function twseHistory(
  s,
  months = 3
) {

  if (
    !/^\d{4}$/.test(s)
  ) {
    return [];
  }

  const now =
    new Date();

  const out = [];
  const seen = new Set();

  for (
    let k = 0;
    k < months;
    k++
  ) {

    const d =
      new Date(
        now.getFullYear(),
        now.getMonth() - k,
        1
      );

    const date =
      `${d.getFullYear()}${String(
        d.getMonth() + 1
      ).padStart(2, '0')}01`;

    try {

      const j =
        await fetchJSON(
          `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${encodeURIComponent(
            s
          )}&_=${Date.now()}`,
          12000
        );

      for (
        const row of
        (j?.data || [])
      ) {

        if (
          !Array.isArray(row) ||
          row.length < 7
        ) {
          continue;
        }

        const p =
          String(
            row[0] || ''
          )
            .split('/')
            .map(Number);

        const close =
          num(row[6]);

        if (
          p.length !== 3 ||
          close == null
        ) {
          continue;
        }

        const time =
          new Date(
            p[0] + 1911,
            p[1] - 1,
            p[2]
          ).getTime();

        if (
          !Number.isFinite(time) ||
          seen.has(time)
        ) {
          continue;
        }

        seen.add(time);

        out.push({

          time,

          open:
            num(row[3]),

          high:
            num(row[4]),

          low:
            num(row[5]),

          close,

          volume:
            num(row[1]) || 0
        });
      }

    } catch {}
  }

  return out.sort(
    (a, b) =>
      a.time - b.time
  );
}

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

  let a = [];

  try {

    const j =
      await fetchJSON(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yahooSymbol(s)
        )}?range=${encodeURIComponent(
          range
        )}&interval=${encodeURIComponent(
          interval
        )}&events=div%2Csplits`,
        12000
      );

    a =
      parseYahooHistory(j);

  } catch {}

  if (
    !a.length &&
    /^\d{4}$/.test(s) &&
    interval === '1d'
  ) {

    a =
      await twseHistory(
        s,
        range === '1mo'
          ? 2
          : 4
      );
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

  if (
    v.length < n
  ) {
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

function rsi(
  v,
  n = 14
) {

  if (
    v.length <= n
  ) {
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
      v[i] -
      v[i - 1];

    if (d >= 0) {
      g += d;
    } else {
      l -= d;
    }
  }

  let ag =
    g / n;

  let al =
    l / n;

  for (
    let i = n + 1;
    i < v.length;
    i++
  ) {

    const d =
      v[i] -
      v[i - 1];

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
          (1 + ag / al);
}

function atr(
  a,
  n = 14
) {

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
    a.map(
      x => x.close
    );

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

    if (
      c.length < n
    ) {
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
      e12.at(-1) ||
      null,

    EMA26:
      e26.at(-1) ||
      null,

    RSI:
      rsi(c),

    MACD:
      macd,

    Bollinger:
      ma20 != null &&
      s20 != null
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

    VWAP:
      a.length
        ? a.reduce(
            (x, y) =>
              x +
              (
                (y.high +
                  y.low +
                  y.close) /
                3
              ) *
                (y.volume || 0),
            0
          ) /
          Math.max(
            1,
            v.reduce(
              (x, y) =>
                x + y,
              0
            )
          )
        : null,

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
   AI Analysis
========================= */

function analysis(
  ind,
  last
) {

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
      last >
      ind.MA20
    ) {
      s += 10;
    }

    if (
      ind.RSI > 55
    ) {
      s += 8;
    }

    if (
      ind.RSI > 70
    ) {
      s -= 10;
    }

    if (
      ind.RSI < 30
    ) {
      s += 5;
    }

    if (
      Number.isFinite(
        ind.MA60
      ) &&
      last >
        ind.MA60
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
   Stock Detail
========================= */

async function stock(s) {

  const q =
    await getQuote(s);

  let h = [];

  try {
    h =
      await history(s);
  } catch {}

  const ind =
    indicators(h);

  return {

    quote: q,

    history: h,

    analysis:
      analysis(
        ind,
        q?.price
      ),

    timestamp:
      Date.now()
  };
}


/* =========================
   STATUS
========================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      server:
        'IAN STOCK API',

      version:
        '14.0.0',

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

      realtimeStocksCached:
        TW_REALTIME_CACHE
          .v.length,

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


/* =========================
   QUOTE
========================= */

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
        '2330,2317,2454,NVDA,AAPL,MSFT'
      )
      .split(',');

    const data =
      await getQuotes(raw);

    res.json({

      data,

      requested:
        [
          ...new Set(
            raw
              .map(normSymbol)
              .filter(Boolean)
          )
        ].length,

      returned:
        data.length,

      timestamp:
        Date.now()
    });
  }
);


/* =========================
   HISTORY
========================= */

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

        data,

        timestamp:
          Date.now()
      });

    } catch {

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        data: [],

        timestamp:
          Date.now(),

        warning:
          '歷史資料來源暫時不可用'
      });
    }
  }
);


/* =========================
   ANALYSIS
========================= */

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
          ),

        timestamp:
          Date.now()
      });

    } catch {

      res.json({

        symbol:
          normSymbol(
            req.params.symbol
          ),

        analysis:
          analysis(
            indicators([]),
            null
          ),

        timestamp:
          Date.now(),

        warning:
          '技術分析資料不足'
      });
    }
  }
);


/* =========================
   STOCK
========================= */

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

      res.json({

        quote: null,

        history: [],

        analysis:
          analysis(
            indicators([]),
            null
          ),

        timestamp:
          Date.now(),

        warning:
          '部分行情來源暫時不可用'
      });
    }
  }
);


/* =========================
   SEARCH
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
        await getRealtimeTaiwanStocks();

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
              symbol:
                x.symbol,

              name:
                x.name,

              market:
                'TW'
            })
          );

      if (local.length) {

        return res.json({
          data: local
        });
      }

      const j =
        await fetchJSON(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
            q
          )}&quotesCount=15&newsCount=0`
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
   ALL TAIWAN STOCKS
========================= */

app.get(
  '/api/tw-stocks',
  async (req, res) => {

    try {

      const data =
        await getRealtimeTaiwanStocks();

      TW_MARKET_CACHE.t =
        Date.now();

      TW_MARKET_CACHE.v =
        data;

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
   LIVE
========================= */

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
        await getRealtimeTaiwanStocks(
          false
        );

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
          x =>
            /^\d{4}$/.test(x)
        );

      const us =
        raw.filter(
          x =>
            !/^\d{4}$/.test(x)
        );

      const data = [

        ...selected
          .map(
            x =>
              twMap.get(x)
          )
          .filter(Boolean),

        ...(us.length
          ? await getQuotes(us)
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
   TAIEX
========================= */

async function twseMarketIndex() {

  try {

    const rows =
      await fetchJSON(
        'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
        15000
      );

    const x =
      (
        Array.isArray(rows)
          ? rows
          : []
      ).find(
        v =>
          v['指數'] ===
          '發行量加權股價指數'
      );

    if (!x) {
      return null;
    }

    const price =
      num(
        x['收盤指數']
      );

    const points =
      num(
        x['漲跌點數']
      );

    const sign =
      String(
        x['漲跌'] || ''
      ).trim() === '-'
        ? -1
        : 1;

    const change =
      points == null
        ? null
        : sign * points;

    return {

      symbol:
        '^TWII',

      name:
        'TAIEX',

      market:
        'TW',

      price,

      change,

      changePct:
        num(
          x['漲跌百分比']
        ),

      source:
        'TWSE MI_INDEX',

      timestamp:
        Date.now()
    };

  } catch {

    return null;
  }
}


/* =========================
   STOOQ
========================= */

async function stooqIndex(
  stooqSymbol,
  symbol,
  name
) {

  try {

    const u =
      `https://stooq.com/q/l/?s=${encodeURIComponent(
        stooqSymbol
      )}&f=sd2t2ohlcvnp&h&e=csv`;

    const raw =
      await (
        await fetch(
          u,
          {
            headers: {
              'User-Agent':
                'IAN-STOCK/13.0',

              'Accept':
                'text/csv'
            },

            signal:
              AbortSignal.timeout(
                12000
              )
          }
        )
      ).text();

    const lines =
      raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);

    if (
      lines.length < 2
    ) {
      return null;
    }

    const h =
      lines[0].split(',');

    const v =
      lines[1].split(',');

    const o =
      Object.fromEntries(
        h.map(
          (k, i) =>
            [
              k,
              v[i]
            ]
        )
      );

    const price =
      num(o.Close);

    const prev =
      num(o.Prev);

    if (
      price == null
    ) {
      return null;
    }

    return {

      symbol,

      name,

      market:
        'US',

      price,

      previousClose:
        prev,

      changePct:
        prev
          ? ((price - prev) / prev) *
            100
          : null,

      source:
        'Stooq',

      timestamp:
        Date.now()
    };

  } catch {

    return null;
  }
}


/* =========================
   Yahoo Index
========================= */

async function yahooIndex(
  sym,
  name
) {

  for (
    const host of [
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com'
    ]
  ) {

    try {

      const j =
        await fetchJSON(
          `https://${host}/v8/finance/chart/${encodeURIComponent(
            sym
          )}?range=5d&interval=1d`,
          12000
        );

      const m =
        j?.chart?.result?.[0]
          ?.meta;

      const price =
        Number(
          m?.regularMarketPrice ??
          m?.previousClose
        );

      const prev =
        Number(
          m?.chartPreviousClose ??
          m?.previousClose
        );

      if (
        Number.isFinite(price)
      ) {

        return {

          symbol:
            sym,

          name,

          market:
            'US',

          price,

          previousClose:
            Number.isFinite(prev)
              ? prev
              : null,

          changePct:
            Number.isFinite(prev) &&
            prev
              ? ((price - prev) /
                  prev) *
                100
              : null,

          source:
            'Yahoo Finance',

          timestamp:
            Date.now()
        };
      }

    } catch {}
  }

  return null;
}


/* =========================
   AI 今日選股
========================= */

function aiDailyScore(q) {

  const ch =
    Number(
      q.changePct
    ) || 0;

  const range =
    Number(q.high) -
    Number(q.low);

  const rangePct =
    q.price
      ? (range /
          q.price) *
        100
      : 0;

  const pos =
    range > 0
      ? (
          (q.price -
            Number(q.low)) /
          range
        )
      : 0.5;

  const vol =
    Math.log10(
      Math.max(
        1,
        Number(q.volume) || 0
      )
    );

  const momentum =
    Math.max(
      0,
      Math.min(
        100,
        50 + ch * 9
      )
    );

  const liquidity =
    Math.max(
      0,
      Math.min(
        100,
        (vol - 3) * 18
      )
    );

  const volatility =
    Math.max(
      0,
      Math.min(
        100,
        rangePct * 12
      )
    );

  const position =
    pos * 100;

  const score =
    Math.round(
      momentum * 0.35 +
      liquidity * 0.25 +
      volatility * 0.15 +
      position * 0.25
    );

  let type =
    '今日候選';

  if (
    ch >= 1 &&
    rangePct >= 2 &&
    pos >= 0.55
  ) {

    type =
      '當沖動能';

  } else if (
    ch <= -1 &&
    rangePct >= 2 &&
    pos <= 0.45
  ) {

    type =
      '當沖反轉觀察';
  }

  const reasons = [];

  if (
    ch >= 1
  ) {

    reasons.push(
      '漲幅動能'
    );

  } else if (
    ch <= -1
  ) {

    reasons.push(
      '跌幅波動'
    );
  }

  if (
    vol >= 6
  ) {

    reasons.push(
      '成交量活躍'
    );
  }

  if (
    rangePct >= 2
  ) {

    reasons.push(
      '日內波動明顯'
    );
  }

  if (
    pos >= 0.7
  ) {

    reasons.push(
      '接近日內高位'
    );

  } else if (
    pos <= 0.3
  ) {

    reasons.push(
      '接近日內低位'
    );
  }

  return {

    ...q,

    score,

    type,

    reason:
      reasons
        .slice(0, 3)
        .join('、') ||
      '價格與成交活躍度符合掃描條件'
  };
}


/* =========================
   AI API
========================= */

app.get(
  '/api/ai/daily',
  async (req, res) => {

    try {

      const all =
        await getRealtimeTaiwanStocks();

      const candidates =
        all
          .filter(
            x =>
              x.price != null &&
              x.volume != null &&
              x.volume > 0 &&
              x.high != null &&
              x.low != null
          )
          .map(
            aiDailyScore
          )
          .filter(
            x =>
              x.score >= 55
          )
          .sort(
            (a, b) =>
              b.score -
              a.score
          )
          .slice(0, 12);

      res.json({

        data:
          candidates,

        timestamp:
          Date.now(),

        source:
          'IAN AI Quant Engine',

        marketCount:
          all.length,

        disclaimer:
          '資訊性量化分析，非保證或個人化投資建議'
      });

    } catch {

      res
        .status(502)
        .json({
          error:
            'AI 今日掃描暫時無法取得'
        });
    }
  }
);


/* =========================
   MARKET
========================= */

app.get(
  '/api/market',
  async (req, res) => {

    const [
      tw,
      sp,
      na,
      dw
    ] =
      await Promise.all([

        twseMarketIndex(),

        yahooIndex(
          '^GSPC',
          'S&P 500'
        ),

        yahooIndex(
          '^IXIC',
          'NASDAQ'
        ),

        yahooIndex(
          '^DJI',
          'DOW JONES'
        )
      ]);

    const fallbacks =
      await Promise.all([

        sp
          ? null
          : stooqIndex(
              '^spx',
              '^GSPC',
              'S&P 500'
            ),

        na
          ? null
          : stooqIndex(
              '^ndq',
              '^IXIC',
              'NASDAQ'
            ),

        dw
          ? null
          : stooqIndex(
              '^dji',
              '^DJI',
              'DOW JONES'
            )

      ].map(
        async x =>
          x
            ? x
            : null
      ));

    const data = [

      tw,

      sp ||
        fallbacks[0],

      na ||
        fallbacks[1],

      dw ||
        fallbacks[2]

    ].filter(Boolean);

    res.json({

      data,

      timestamp:
        Date.now(),

      sources:
        [
          ...new Set(
            data.map(
              x => x.source
            )
          )
        ]
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
   STATIC
========================= */

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

app.use(
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);


/* =========================
   START
========================= */

app.listen(
  PORT,
  () =>
    console.log(
      `IAN STOCK API 14.0.0 listening on ${PORT}`
    )
);
