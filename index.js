import express from "express";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const BSCSCAN_API = process.env.BSCSCAN_API;
const DEPLOYER = (process.env.DEPLOYER || "").toLowerCase();
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || "2", 10);

let lastRun = null;
let lastCheckedBlock = 0;
let lastHash = null;

async function send(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(msg)}`);
  } catch (e) {
    console.error("Telegram send error:", e);
  }
}

async function checkNewContracts() {
  console.log("Polling BSC…", new Date().toISOString());
  lastRun = new Date().toISOString();

  if (!BSCSCAN_API || !DEPLOYER) {
    console.warn("Missing BSCSCAN_API or DEPLOYER");
    return;
  }

  const url = `https://api.bscscan.com/api?module=account&action=txlist&address=${DEPLOYER}&startblock=${lastCheckedBlock}&endblock=99999999&sort=desc&apikey=${BSCSCAN_API}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data || data.status !== "1" || !Array.isArray(data.result)) {
    console.log("BscScan: empty / rate limited / error");
    return;
  }

  const created = data.result.filter(tx => tx.contractAddress && tx.isError === "0");
  if (!created.length) {
    console.log("No new contracts yet.");
    return;
  }

  created.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
  const newest = created[0];
  const txHash = newest.hash;
  const createdAddr = newest.contractAddress;
  const timeUTC = new Date(Number(newest.timeStamp) * 1000).toISOString();

  lastCheckedBlock = Number(newest.blockNumber);
  lastHash = txHash;

  console.log("Found new contract:", createdAddr, "at", timeUTC);
  await send(`🆕 New Contract Creation:
tx: ${txHash}
time: ${timeUTC}
address: ${createdAddr}`);

  try {
    const ds = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${createdAddr}`);
    const dj = await ds.json();
    if (dj && Array.isArray(dj.pairs) && dj.pairs.length) {
      const pair = dj.pairs.find(p => p.chainId === "bsc" && /pancake/i.test(p.dexId) && /WBNB/i.test(p.quoteToken?.symbol || ""));
      if (pair) {
        await send(`🔗 Pair detected: ${pair.pairAddress}
Liquidity: $${pair.liquidity?.usd || "?"}
Dexscreener: https://dexscreener.com/bsc/${pair.pairAddress}`);
      } else {
        await send("ℹ️ Pair not yet found for " + createdAddr);
      }
    }
  } catch (e) {
    console.error("Dexscreener error:", e);
  }
}

// Web endpoints
app.get("/", (req, res) => res.send("Omni Agent is running"));
app.get("/status", (req, res) => res.json({ lastRun, lastHash, lastCheckedBlock, interval: INTERVAL_MINUTES }));
app.get("/force", async (req, res) => {
  await checkNewContracts();
  res.send("Manual check complete");
});

app.listen(port, () => console.log(`Server ready on port ${port}`));

// 🔁 Автозапуск цикла
setInterval(checkNewContracts, INTERVAL_MINUTES * 60 * 1000);
checkNewContracts();
