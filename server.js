const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

async function getUS(symbol) {
  if (!API_KEY) {
    return {
      ok: false,
      symbol,
      error: "ALPHA_VANTAGE_KEY is missing on Render"
    };
  }

  const url =
    "https://www.alphavantage.co/query?function=GLOBAL_QUOTE" +
    "&symbol=" + encodeURIComponent(symbol) +
    "&apikey=" + encodeURIComponent(API_KEY);

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
        error: "Alpha Vantage returned no Global Quote data",
        rawKeys: Object.keys(j)
      };
    }

    return {
      ok: true,
      symbol,
      price: Number(q["05. price"]),
      changePct: Number(
        String(q["10. change percent"] || "").replace("%", "")
      )
    };
  } catch (e) {
    return {
      ok: false,
      symbol,
      error: "Request to Alpha Vantage failed: " + e.message
    };
  }
}

app.get("/api/quotes", async (req, res) => {
  const symbols = ["NVDA", "AAPL", "MSFT"];
  const result = [];

  for (const symbol of symbols) {
    const q = await getUS(symbol);

    if (q.ok) {
      result.push(q);
    }
  }

  res.json(result);
});

app.get("/api/status", async (req, res) => {
  const q = await getUS("NVDA");

  res.json({
    server: "IAN STOCK API",
    apiKeyConfigured: Boolean(API_KEY),
    alphaVantage: q.ok ? "OK" : "ERROR",
    detail: q.ok
      ? "Alpha Vantage returned quote data."
      : q.error,
    rawKeys: q.rawKeys || undefined,
    note: "API key is intentionally never returned."
  });
});

app.get("/", (req, res) => {
  res.send("IAN STOCK API ONLINE");
});

app.listen(PORT, () => {
  console.log("IAN STOCK API running on port " + PORT);
});
