const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const ALPHA = process.env.ALPHA_VANTAGE_KEY || "";

const TW_NAMES = {
  "2330": "台積電",
  "2317": "鴻海",
  "2454": "聯發科",
  "2303": "聯電",
  "2382": "廣達",
  "3711": "日月光投控",
  "2881": "富邦金",
  "2882": "國泰金"
};

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 IAN-STOCK"
        }
      },
      response => {
        let body = "";

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error("HTTP " + response.statusCode));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("JSON parse error"));
          }
        });
      }
    );

    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.on("error", reject);
  });
}

function norm(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(".TW", "");
}

function isUS(symbol) {
  return /^[A-Z]+$/.test(symbol);
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  if (!arr.length) return null;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;

    return mean(arr.slice(i - period + 1, i + 1));
  });
}

function ema(arr, period) {
  if (!arr.length) return [];

  const k = 2 / (period + 1);
  const result = [];

  let previous = arr[0];

  arr.forEach((value, i) => {
    if (i === 0) {
      previous = value;
    } else {
      previous = value * k + previous * (1 - k);
    }

    result.push(previous);
  });

  return result;
}

function rsi(close, period = 14) {
  const result = Array(close.length).fill(null);

  if (close.length <= period) {
    return result;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = close[i] - close[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss -= diff;
    }
  }

  gain /= period;
  loss /= period;

  result[period] =
    loss === 0
      ? 100
      : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < close.length; i++) {
    const diff = close[i] - close[i - 1];

    gain =
      (gain * (period - 1) + Math.max(diff, 0)) /
      period;

    loss =
      (loss * (period - 1) + Math.max(-diff, 0)) /
      period;

    result[i] =
      loss === 0
        ? 100
        : 100 - 100 / (1 + gain / loss);
  }

  return result;
}

function atr(rows, period = 14) {
  const tr = [];

  for (let i = 0; i < rows.length; i++) {
    if (i === 0) {
      tr.push(rows[i].high - rows[i].low);
    } else {
      tr.push(
        Math.max(
          rows[i].high - rows[i].low,
          Math.abs(rows[i].high - rows[i - 1].close),
          Math.abs(rows[i].low - rows[i - 1].close)
        )
      );
    }
  }

  return sma(tr, period);
}

function calculateIndicators(rows) {
  const close = rows.map(x => x.close);

  const ma5 = sma(close, 5);
  const ma20 = sma(close, 20);
  const ma60 = sma(close, 60);

  const ema12 = ema(close, 12);
  const ema26 = ema(close, 26);

  const macd = ema12.map(
    (value, i) => value - ema26[i]
  );

  const signal = ema(macd, 9);

  const rsiData = rsi(close, 14);
  const atrData = atr(rows, 14);

  const middle = ma20.at(-1);

  const last20 = close.slice(-20);

  const avg = mean(last20) || close.at(-1);

  const variance =
    mean(
      last20.map(x => Math.pow(x - avg, 2))
    ) || 0;

  const sd = Math.sqrt(variance);

  return {
    MA5: ma5.at(-1),
    MA20: ma20.at(-1),
    MA60: ma60.at(-1),

    EMA12: ema12.at(-1),
    EMA26: ema26.at(-1),

    RSI: rsiData.at(-1),

    macd: macd.at(-1),
    signal: signal.at(-1),
    histogram:
      macd.at(-1) - signal.at(-1),

    middle,

    upper:
      (middle || avg) + sd * 2,

    lower:
      (middle || avg) - sd * 2,

    ATR: atrData.at(-1),

    support:
      Math.min(...close.slice(-20)),

    resistance:
      Math.max(...close.slice(-20)),

    VWAP:
      mean(
        rows
          .slice(-20)
          .map(x => x.close)
      )
  };
}

function makeAnalysis(indicators, price) {
  let score = 50;

  let trend = "震盪";
  let momentum = "中性";

  if (
    indicators.MA20 &&
    price > indicators.MA20
  ) {
    score += 12;
    trend = "偏多";
  } else if (
    indicators.MA20 &&
    price < indicators.MA20
  ) {
    score -= 12;
    trend = "偏空";
  }

  if (
    indicators.MA60 &&
    price > indicators.MA60
  ) {
    score += 10;
  } else if (
    indicators.MA60 &&
    price < indicators.MA60
  ) {
    score -= 10;
  }

  if (indicators.RSI != null) {
    if (indicators.RSI > 70) {
      score -= 5;
      momentum = "過熱";
    } else if (indicators.RSI > 55) {
      score += 8;
      momentum = "偏強";
    } else if (indicators.RSI < 30) {
      score += 4;
      momentum = "超賣";
    } else if (indicators.RSI < 45) {
      score -= 6;
      momentum = "偏弱";
    }
  }

  if (
    indicators.macd >
    indicators.signal
  ) {
    score += 8;
  } else {
    score -= 8;
  }

  score = Math.max(
    0,
    Math.min(100, Math.round(score))
  );

  return {
    score,
    trend,
    momentum,

    summary:
      `目前價格 ${price}；均線、RSI、MACD 與波動指標顯示為「${trend}／${momentum}」。` +
      `這是規則式資訊整理，不代表未來報酬或買賣指示。`
  };
}

async function yahooHistory(
  symbol,
  range = "6mo"
) {
  const days = {
    "1mo": 30,
    "3mo": 90,
    "6mo": 180,
    "1y": 365,
    "2y": 730
  }[range] || 180;

  const end =
    Math.floor(Date.now() / 1000);

  const start =
    end - days * 86400;

  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    `?period1=${start}&period2=${end}` +
    "&interval=1d&events=history";

  const json = await get(url);

  const result =
    json.chart?.result?.[0];

  if (!result) {
    throw new Error("Yahoo no data");
  }

  const quote =
    result.indicators.quote[0];

  const rows =
    result.timestamp
      .map((timestamp, i) => ({
        date:
          new Date(
            timestamp * 1000
          )
            .toISOString()
            .slice(0, 10),

        open: num(quote.open[i]),
        high: num(quote.high[i]),
        low: num(quote.low[i]),
        close: num(quote.close[i]),
        volume: num(quote.volume[i])
      }))
      .filter(x => x.close != null);

  const last = rows.at(-1);
  const previous = rows.at(-2);

  const meta = result.meta || {};

  return {
    quote: {
      symbol,
      name:
        meta.longName ||
        meta.shortName ||
        symbol,

      market: "US",

      price: last?.close,

      previousClose:
        previous?.close,

      change:
        last && previous
          ? last.close - previous.close
          : null,

      changePct:
        last && previous
          ? ((last.close - previous.close) /
              previous.close) *
            100
          : null,

      volume: last?.volume,

      source: "Yahoo Finance"
    },

    rows
  };
}

async function twseHistory(
  symbol,
  range = "6mo"
) {
  const months = {
    "1mo": 2,
    "3mo": 4,
    "6mo": 7,
    "1y": 13,
    "2y": 25
  }[range] || 7;

  const today = new Date();

  const rows = [];

  for (let i = 0; i < months; i++) {
    const date =
      new Date(
        today.getFullYear(),
        today.getMonth() - i,
        1
      );

    const y =
      date.getFullYear();

    const m =
      String(
        date.getMonth() + 1
      ).padStart(2, "0");

    const url =
      `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${y}${m}01&stockNo=${encodeURIComponent(symbol)}`;

    try {
      const json = await get(url);

      if (!json.data) continue;

      for (const row of json.data) {
        const close = num(row[6]);

        if (close == null) continue;

        rows.push({
          date: row[0],
          volume: num(row[1]),
          open: num(row[3]),
          high: num(row[4]),
          low: num(row[5]),
          close
        });
      }
    } catch {}
  }

  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date)
  );

  return rows;
}

async function twseQuote(symbol) {
  const rows =
    await twseHistory(
      symbol,
      "1mo"
    );

  if (!rows.length) {
    throw new Error(
      "TWSE no data"
    );
  }

  const last = rows.at(-1);
  const previous = rows.at(-2);

  return {
    symbol,

    name:
      TW_NAMES[symbol] ||
      symbol,

    market: "TW",

    price: last.close,

    previousClose:
      previous?.close,

    change:
      previous
        ? last.close -
          previous.close
        : null,

    changePct:
      previous
        ? ((last.close -
            previous.close) /
            previous.close) *
          100
        : null,

    volume: last.volume,

    source: "TWSE"
  };
}

async function getQuote(symbol) {
  symbol = norm(symbol);

  if (isUS(symbol)) {
    const data =
      await yahooHistory(
        symbol,
        "1mo"
      );

    return data.quote;
  }

  return twseQuote(symbol);
}

async function getHistory(
  symbol,
  range
) {
  symbol = norm(symbol);

  if (isUS(symbol)) {
    const data =
      await yahooHistory(
        symbol,
        range
      );

    return data.rows;
  }

  return twseHistory(
    symbol,
    range
  );
}

async function getInstitutional(
  symbol
) {
  if (isUS(symbol)) {
    return {};
  }

  const today =
    new Date();

  const date =
    `${today.getFullYear()}` +
    `${String(
      today.getMonth() + 1
    ).padStart(2, "0")}` +
    `${String(
      today.getDate()
    ).padStart(2, "0")}`;

  try {
    const url =
      `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALL&response=json`;

    const json =
      await get(url);

    const row =
      (json.data || [])
        .find(
          x =>
            String(x[0]).trim() ===
            String(symbol)
        );

    if (!row) return {};

    return {
      date,

      foreignBuy:
        num(row[2]),

      foreignSell:
        num(row[3]),

      foreignNet:
        num(row[4]),

      trustBuy:
        num(row[5]),

      trustSell:
        num(row[6]),

      trustNet:
        num(row[7]),

      dealerBuy:
        num(row[8]),

      dealerSell:
        num(row[9]),

      dealerNet:
        num(row[10])
    };
  } catch {
    return {};
  }
}

async function getStock(
  symbol
) {
  symbol = norm(symbol);

  const quote =
    await getQuote(symbol);

  const rows =
    await getHistory(
      symbol,
      "6mo"
    );

  const indicators =
    calculateIndicators(
      rows
    );

  const analysis =
    makeAnalysis(
      indicators,
      quote.price
    );

  const institutional =
    await getInstitutional(
      symbol
    );

  return {
    quote,
    indicators,
    analysis,
    institutional,
    dataPoints:
      rows.length
  };
}

async function searchStocks(
  query
) {
  query =
    String(query || "")
      .toLowerCase();

  const stocks =
    Object.entries(TW_NAMES)
      .map(
        ([symbol, name]) => ({
          symbol,
          name,
          market: "TW"
        })
      );

  stocks.push(
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
      symbol: "TSLA",
      name: "Tesla",
      market: "US"
    }
  );

  return stocks.filter(
    x =>
      x.symbol
        .toLowerCase()
        .includes(query) ||
      x.name
        .toLowerCase()
        .includes(query)
  );
}

async function getMarket() {
  const symbols = [
    "2330",
    "2317",
    "2454",
    "2303",
    "2382",
    "3711",
    "2881",
    "2882",
    "NVDA",
    "AAPL",
    "MSFT",
    "TSLA"
  ];

  const result = [];

  for (const symbol of symbols) {
    try {
      result.push(
        await getQuote(symbol)
      );
    } catch {
      result.push({
        symbol,

        name:
          TW_NAMES[symbol] ||
          symbol,

        market:
          isUS(symbol)
            ? "US"
            : "TW",

        price: null,

        source:
          "unavailable"
      });
    }
  }

  return result;
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        const path =
          url.pathname;

        if (
          req.method ===
          "OPTIONS"
        ) {
          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",
              "Access-Control-Allow-Headers":
                "Content-Type"
            }
          );

          return res.end();
        }

        if (
          path ===
          "/api/status"
        ) {
          return send(
            res,
            200,
            {
              server:
                "IAN STOCK API",

              version:
                "15.0.0",

              status:
                "ONLINE",

              twse:
                "AVAILABLE",

              yahooFinance:
                "AVAILABLE",

              alphaVantageConfigured:
                !!ALPHA
            }
          );
        }

        if (
          path ===
          "/api/market"
        ) {
          return send(
            res,
            200,
            {
              data:
                await getMarket()
            }
          );
        }

        if (
          path ===
          "/api/search"
        ) {
          return send(
            res,
            200,
            {
              data:
                await searchStocks(
                  url.searchParams.get(
                    "q"
                  )
                )
            }
          );
        }

        if (
          path ===
          "/api/quotes"
        ) {
          const symbols =
            (
              url.searchParams.get(
                "symbols"
              ) ||
              "2330,2317,2454,NVDA,AAPL,MSFT"
            )
              .split(",")
              .map(norm)
              .filter(Boolean);

          const result = [];

          for (
            const symbol
            of symbols
          ) {
            try {
              result.push(
                await getQuote(
                  symbol
                )
              );
            } catch {
              result.push({
                symbol,

                name:
                  TW_NAMES[
                    symbol
                  ] ||
                  symbol,

                market:
                  isUS(symbol)
                    ? "US"
                    : "TW",

                price: null,

                source:
                  "unavailable"
              });
            }
          }

          return send(
            res,
            200,
            result
          );
        }

        const match =
          path.match(
            /^\/api\/(quote|history|analysis|stock|institutional)\/([^/]+)$/
          );

        if (match) {
          const type =
            match[1];

          const symbol =
            norm(
              decodeURIComponent(
                match[2]
              )
            );

          if (
            type ===
            "quote"
          ) {
            return send(
              res,
              200,
              await getQuote(
                symbol
              )
            );
          }

          if (
            type ===
            "history"
          ) {
            return send(
              res,
              200,
              {
                symbol,

                data:
                  await getHistory(
                    symbol,
                    url.searchParams.get(
                      "range"
                    ) ||
                    "6mo"
                  )
              }
            );
          }

          if (
            type ===
            "institutional"
          ) {
            return send(
              res,
              200,
              await getInstitutional(
                symbol
              )
            );
          }

          const stock =
            await getStock(
              symbol
            );

          if (
            type ===
            "analysis"
          ) {
            return send(
              res,
              200,
              stock.analysis
            );
          }

          return send(
            res,
            200,
            stock
          );
        }

        return send(
          res,
          404,
          {
            error:
              "Not found"
          }
        );
      } catch (error) {
        console.error(error);

        return send(
          res,
          500,
          {
            error:
              error.message ||
              "Server error"
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `IAN STOCK API running on port ${PORT}`
    );
  }
);
