const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

// =========================
// IAN STOCK 行情快取
// =========================

const cache = {};
const CACHE_TIME = 60 * 60 * 1000; // 1 小時

async function getUS(symbol) {

  // 有快取，而且還沒過期
  if (
    cache[symbol] &&
    Date.now() - cache[symbol].time < CACHE_TIME
  ) {
    return {
      ...cache[symbol].data,
      cached: true
    };
  }

  if (!API_KEY) {
    return {
      ok: false,
      symbol,
      error: "ALPHA_VANTAGE_KEY is missing"
    };
  }

  const url =
    "https://www.alphavantage.co/query" +
    "?function=GLOBAL_QUOTE" +
    "&symbol=" +
    encodeURIComponent(symbol) +
    "&apikey=" +
    encodeURIComponent(API_KEY);

  try {

    const r = await fetch(url);
    const j = await r.json();

    if (j["Error Message"]) {
      return {
        ok: false,
        symbol,
        error: j["Error Message"]
      };
    }

    if (j["Information"]) {
      return {
        ok: false,
        symbol,
        error: j["Information"]
      };
    }

    const q = j["Global Quote"];

    if (!q || !q["05. price"]) {
      return {
        ok: false,
        symbol,
        error: "No quote data",
        rawKeys: Object.keys(j)
      };
    }

    const data = {
      ok: true,
      symbol,
      price: Number(q["05. price"]),
      changePct: Number(
        String(q["10. change percent"] || "").replace("%", "")
      )
    };

    // 存入快取
    cache[symbol] = {
      time: Date.now(),
      data
    };

    return {
      ...data,
      cached: false
    };

  } catch (e) {

    return {
      ok: false,
      symbol,
      error: "Request failed: " + e.message
    };
  }
}


// =========================
// 美股行情
// =========================

app.get("/api/quotes", async (req, res) => {

  const symbols = [
    "NVDA",
    "AAPL",
    "MSFT"
  ];

  const result = [];

  for (const symbol of symbols) {

    const q = await getUS(symbol);

    if (q.ok) {
      result.push(q);
    }
  }

  res.json(result);
});


// =========================
// API 狀態
// =========================

app.get("/api/status", async (req, res) => {

  const q = await getUS("NVDA");

  res.json({
    server: "IAN STOCK API",
    apiKeyConfigured: Boolean(API_KEY),
    alphaVantage: q.ok ? "OK" : "ERROR",
    detail: q.ok
      ? "Alpha Vantage returned quote data."
      : q.error,
    cached: q.cached || false,
    note: "API key is intentionally never returned."
  });
});


// =========================
// 首頁
// =========================

app.get("/", (req, res) => {

  res.send("IAN STOCK API ONLINE");

});


// =========================
// 啟動
// =========================

app.listen(PORT, () => {

  console.log(
    "IAN STOCK API running on port " + PORT
  );

});
