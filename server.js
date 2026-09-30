const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ALPHA_VANTAGE_KEY;

async function getUS(symbol) {
  if (!API_KEY) return null;

  const url =
    "https://www.alphavantage.co/query?function=GLOBAL_QUOTE" +
    "&symbol=" + encodeURIComponent(symbol) +
    "&apikey=" + encodeURIComponent(API_KEY);

  const r = await fetch(url);
  const j = await r.json();
  const q = j["Global Quote"];

  if (!q || !q["05. price"]) return null;

  return {
    symbol: symbol,
    price: Number(q["05. price"]),
    changePct: Number(
      String(q["10. change percent"] || "").replace("%", "")
    )
  };
}

app.get("/api/quotes", async (req, res) => {
  const symbols = ["NVDA", "AAPL", "MSFT"];
  const result = [];

  for (const symbol of symbols) {
    try {
      const q = await getUS(symbol);
      if (q) result.push(q);
    } catch (e) {}
  }

  res.json(result);
});

app.get("/", (req, res) => {
  res.send("IAN STOCK API ONLINE");
});

app.listen(PORT, () => {
  console.log("IAN STOCK API running on port " + PORT);
});
