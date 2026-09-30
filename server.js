const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.ALPHA_VANTAGE_KEY;


/* =====================================================
   IAN STOCK SERVER
===================================================== */

const SERVER_NAME = "IAN STOCK API";


// Alpha Vantage 快取時間
// 1 小時內同一支股票不重新請求
const CACHE_TIME = 60 * 60 * 1000;


// 股票快取
const quoteCache = {};


// API 錯誤紀錄
const errorCache = {};


// 目前可以從 Alpha Vantage 測試的美股
const DEFAULT_US_SYMBOLS = [
  "NVDA",
  "AAPL",
  "MSFT"
];



/* =====================================================
   工具：清理 symbol
===================================================== */

function cleanSymbol(symbol) {

  return String(symbol || "")
    .trim()
    .toUpperCase();

}



/* =====================================================
   工具：檢查快取
===================================================== */

function getCached(symbol) {

  const item = quoteCache[symbol];

  if (!item) {
    return null;
  }


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


  return null;

}



/* =====================================================
   工具：儲存快取
===================================================== */

function saveCache(symbol, data) {

  quoteCache[symbol] = {

    time: Date.now(),

    data: data

  };

}



/* =====================================================
   Alpha Vantage
===================================================== */

async function fetchAlphaVantage(symbol) {

  symbol =
    cleanSymbol(symbol);


  if (!symbol) {

    return {

      ok: false,

      symbol,

      error:
        "Stock symbol is required"

    };

  }


  /*
    先讀伺服器快取。

    這是整個系統最重要的地方。

    即使很多人一直重新整理網站，
    只要快取還沒過期，
    就不會再次打 Alpha Vantage。
  */

  const cached =
    getCached(symbol);


  if (cached) {

    return cached;

  }



  /* API Key */

  if (!API_KEY) {

    return {

      ok: false,

      symbol,

      error:
        "ALPHA_VANTAGE_KEY is missing on Render"

    };

  }



  /* Alpha Vantage URL */

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

      return {

        ok: false,

        symbol,

        error:
          "Alpha Vantage HTTP error " +
          response.status

      };

    }


    const data =
      await response.json();



    /* API Key / quota / provider error */

    if (data["Error Message"]) {

      errorCache[symbol] =
        data["Error Message"];


      return {

        ok: false,

        symbol,

        error:
          data["Error Message"]

      };

    }


    if (data["Information"]) {

      errorCache[symbol] =
        data["Information"];


      return {

        ok: false,

        symbol,

        error:
          data["Information"]

      };

    }



    /* Global Quote */

    const quote =
      data["Global Quote"];


    if (
      !quote ||
      !quote["05. price"]
    ) {

      return {

        ok: false,

        symbol,

        error:
          "Alpha Vantage returned no quote data",

        rawKeys:
          Object.keys(data)

      };

    }



    /* 整理資料 */

    const result = {

      ok: true,

      symbol,

      price:
        Number(
          quote["05. price"]
        ),

      change:
        Number(
          quote["09. change"]
          || 0
        ),

      changePct:
        Number(
          String(
            quote["10. change percent"]
            || ""
          ).replace("%","")
        ),

      volume:
        Number(
          quote["06. volume"]
          || 0
        ),

      latestTradingDay:
        quote["07. latest trading day"]
        || null

    };



    /* 儲存 */

    saveCache(
      symbol,
      result
    );


    return {

      ...result,

      cached: false

    };


  } catch (error) {

    return {

      ok: false,

      symbol,

      error:
        "Request failed: " +
        error.message

    };

  }

}



/* =====================================================
   GET /api/quotes
===================================================== */

app.get(
  "/api/quotes",
  async (req, res) => {

    /*
      預設只抓 3 支測試股票。

      不要一次抓前端所有股票，
      否則很快就會消耗 API 額度。
    */

    let symbols =
      DEFAULT_US_SYMBOLS;


    /*
      如果未來要指定股票：

      /api/quotes?symbols=NVDA,AAPL
    */

    if (req.query.symbols) {

      symbols =
        String(
          req.query.symbols
        )
        .split(",")
        .map(cleanSymbol)
        .filter(Boolean)
        .slice(0, 10);

    }


    const results = [];


    /*
      一支一支處理。

      已有快取 → 不消耗 API。

      沒有快取 → 才詢問 Alpha Vantage。
    */

    for (
      const symbol of symbols
    ) {

      const quote =
        await fetchAlphaVantage(
          symbol
        );


      if (quote.ok) {

        results.push(
          quote
        );

      }

    }


    res.json(results);

  }
);



/* =====================================================
   GET /api/quote/:symbol
===================================================== */

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

        error:
          "Invalid symbol"

      });

    }


    const quote =
      await fetchAlphaVantage(
        symbol
      );


    if (!quote.ok) {

      return res.status(502).json(
        quote
      );

    }


    res.json(
      quote
    );

  }
);



/* =====================================================
   GET /api/search
===================================================== */

app.get(
  "/api/search",
  async (req, res) => {

    const keyword =
      String(
        req.query.q || ""
      )
      .trim()
      .toUpperCase();


    /*
      現階段先提供前端搜尋所需的基本資料。

      未來接真正股票搜尋資料源後，
      這裡可以改成完整搜尋 API。
    */

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
      ? stocks.filter(stock =>

          stock.symbol
            .toUpperCase()
            .includes(keyword)

          ||

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



/* =====================================================
   GET /api/status
===================================================== */

app.get(
  "/api/status",
  async (req, res) => {

    /*
      測試 NVDA。

      如果已經在快取裡，
      就不會再次消耗 Alpha Vantage 額度。
    */

    const nvda =
      await fetchAlphaVantage(
        "NVDA"
      );


    res.json({

      server:
        SERVER_NAME,

      apiKeyConfigured:
        Boolean(API_KEY),

      alphaVantage:
        nvda.ok
        ? "OK"
        : "ERROR",

      detail:
        nvda.ok
        ? "Alpha Vantage quote data is available."
        : nvda.error,

      cached:
        nvda.cached || false,

      cacheEntries:
        Object.keys(
          quoteCache
        ).length,

      supportedTestSymbols:
        DEFAULT_US_SYMBOLS,

      note:
        "API key is never returned."

    });

  }
);



/* =====================================================
   GET /api/cache
===================================================== */

app.get(
  "/api/cache",
  (req, res) => {

    const result = {};


    Object.keys(
      quoteCache
    ).forEach(symbol => {

      const item =
        quoteCache[symbol];


      const age =
        Date.now() -
        item.time;


      result[symbol] = {

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


    res.json({

      cacheTimeMinutes:
        CACHE_TIME / 60000,

      symbols:
        result

    });

  }
);



/* =====================================================
   Taiwan API placeholder
===================================================== */

app.get(
  "/api/tw/quote/:symbol",
  (req, res) => {

    /*
      暫時不回傳假的台股價格。

      未來接合法台股資料源後，
      在這裡加入真正行情。
    */

    res.json({

      ok: false,

      symbol:
        cleanSymbol(
          req.params.symbol
        ),

      message:
        "Taiwan market data source is not connected yet."

    });

  }
);



/* =====================================================
   Historical API placeholder
===================================================== */

app.get(
  "/api/history/:symbol",
  (req, res) => {

    /*
      K 線、MA、RSI、MACD
      需要歷史 OHLCV 資料。

      現階段不產生假資料。
    */

    res.json({

      ok: false,

      symbol:
        cleanSymbol(
          req.params.symbol
        ),

      message:
        "Historical market data source is not connected yet."

    });

  }
);



/* =====================================================
   ROOT
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        SERVER_NAME,

      status:
        "ONLINE",

      version:
        "1.0.0"

    });

  }
);



/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "API route not found"

    });

  }
);



/* =====================================================
   ERROR HANDLER
===================================================== */

app.use(
  (error, req, res, next) => {

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



/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      SERVER_NAME +
      " running on port " +
      PORT
    );

  }
);
