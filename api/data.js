// Vercel Serverless Function — S&P 500 YTD Best & Worst Performers
// Self-updating: fetches current constituent list from GitHub (datahub),
// then parallel-fetches YTD returns from Yahoo Finance (~5s for ~503 stocks)

const SP500_CSV_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

async function fetchSP500List() {
  const resp = await fetch(SP500_CSV_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SP500Dash/1.0)" },
  });
  if (!resp.ok) throw new Error("Failed to fetch S&P 500 list from GitHub");
  const text = await resp.text();
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  const symIdx = headers.indexOf("Symbol");
  const secIdx = headers.indexOf("GICS Sector");
  const subIdx = headers.indexOf("GICS Sub-Industry");

  const stocks = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle CSV with possible commas in quoted fields
    const cols = lines[i].match(/(".*?"|[^",]+)(?=,|$)/g) || [];
    const symbol = (cols[symIdx] || "").replace(/"/g, "").trim();
    const sector = (cols[secIdx] || "").replace(/"/g, "").trim();
    const subIndustry = (cols[subIdx] || "").replace(/"/g, "").trim();
    if (symbol) stocks.push({ symbol, sector, subIndustry });
  }
  return stocks;
}

async function fetchYTD(ticker) {
  try {
    const url =
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?range=ytd&interval=3mo`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SP500Dash/1.0)" },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const meta = json.chart.result[0].meta;
    const prev = meta.chartPreviousClose;
    const cur = meta.regularMarketPrice;
    if (!prev || !cur) return null;
    return {
      symbol: meta.symbol,
      name: (meta.shortName || "")
        .replace(
          /,?\s*(Inc\.?|Corp\.?|Company|Corporation|plc|Ltd\.?|N\.?V\.?|Holdings?|Group|Technologies|Incorporated)\s*$/gi,
          ""
        )
        .trim(),
      price: +cur.toFixed(2),
      ytd: +((cur / prev - 1) * 100).toFixed(2),
      prevClose: +prev.toFixed(2),
    };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");

  const count = Math.min(parseInt(req.query.count || "20", 10), 50);

  try {
    // 1. Fetch current S&P 500 constituent list
    const sp500 = await fetchSP500List();
    const sectorMap = {};
    sp500.forEach((s) => (sectorMap[s.symbol] = { sector: s.sector, subIndustry: s.subIndustry }));

    // 2. Parallel-fetch YTD for all constituents + SPY benchmark
    const [spyResult, ...results] = await Promise.all([
      fetchYTD("SPY"),
      ...sp500.map((s) => fetchYTD(s.symbol)),
    ]);

    // 3. Merge sector data & filter
    const valid = results
      .filter((r) => r && r.ytd != null)
      .map((r) => ({ ...r, sector: sectorMap[r.symbol]?.sector || "", subIndustry: sectorMap[r.symbol]?.subIndustry || "" }));
    valid.sort((a, b) => b.ytd - a.ytd);

    const now = new Date();
    res.status(200).json({
      ok: true,
      totalFetched: valid.length,
      totalConstituents: sp500.length,
      count,
      benchmark: spyResult ? { symbol: "SPY", ytd: spyResult.ytd, price: spyResult.price } : null,
      winners: valid.slice(0, count),
      losers: valid.slice(-count).reverse(),
      updatedAt: now.toISOString(),
      year: now.getFullYear(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
