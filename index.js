// index.js — Real Alerts: Contract Creation + Pancake v2 pair within 30m
import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = process.env.CHAT_ID;

const BSCSCAN_API = process.env.BSCSCAN_API; // https://bscscan.com/myapikey
const DEPLOYER    = (process.env.DEPLOYER || '').toLowerCase();
const POLL_MS     = Number(process.env.POLL_MS || 60000);

const DEX_MIN_LP_USD       = Number(process.env.DEX_MIN_LP || 50000);
const DEXCHECK_WINDOW_MIN  = Number(process.env.DEXCHECK_WINDOW_MIN || 30);
const DEXCHECK_INTERVAL_MS = Number(process.env.DEXCHECK_INTERVAL_MS || 30000);

if (!BOT_TOKEN || !CHAT_ID || !BSCSCAN_API || !DEPLOYER) {
  console.error('Missing required ENV: BOT_TOKEN, CHAT_ID, BSCSCAN_API, DEPLOYER');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---- helpers ----
async function tgSend(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('tgSend error', e);
  }
}

const seenTx = new Set();  // дедуп по txhash (в памяти)
let lastBlockChecked = 0;  // чтобы не пропускать между перезапусками можно вынести в KV/Redis

function short(addr) { return addr ? addr.slice(0,6) + '…' + addr.slice(-4) : ''; }

// BscScan: получить последние транзакции деплойера
async function fetchDeployerTxs() {
  // account.txlist вернёт обычные внешние tx
  const url = `https://api.bscscan.com/api?module=account&action=txlist&address=${DEPLOYER}`
            + `&startblock=0&endblock=99999999&sort=desc&apikey=${BSCSCAN_API}`;
  const r = await fetch(url); const j = await r.json();
  if (j.status !== '1') return [];
  return j.result; // массив tx
}

// Для каждой tx получим адрес созданного контракта (если это Contract Creation)
async function getCreatedContract(txhash) {
  // eth_getTransactionReceipt содержит contractAddress
  const url = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txhash}&apikey=${BSCSCAN_API}`;
  const r = await fetch(url); const j = await r.json();
  const receipt = j.result || {};
  return receipt.contractAddress && receipt.contractAddress !== '0x0000000000000000000000000000000000000000'
    ? receipt.contractAddress
    : null;
}

async function dexFindPairs(tokenAddr) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.pairs) ? j.pairs : [];
}

function formatPairLine(p) {
  const liq = p.liquidity?.usd ?? 0;
  const dex = p.dexId || 'dex';
  const quote = p.quoteToken?.symbol || p.quoteToken?.address || '?';
  const link = p.url || (p.pairAddress ? `https://dexscreener.com/bsc/${p.pairAddress}` : '');
  return `• ${dex} ${p.baseToken?.symbol || ''}/${quote} — LP ~$${Math.round(liq).toLocaleString()} ${link ? `\n${link}`:''}`;
}

// Планировщик проверки пары 30 мин после деплоя
function scheduleDexWatch(createdAddr, createdAtUtc) {
  const started = Date.now();
  const until = started + DEXCHECK_WINDOW_MIN * 60_000;

  const timer = setInterval(async () => {
    if (Date.now() > until) return clearInterval(timer);

    try {
      const pairs = await dexFindPairs(createdAddr);
      if (!pairs.length) return;

      // Ищем Pancake v2 + quote WBNB (если есть) и LP >= threshold
      const good = pairs.filter(p => 
        (p.dexId || '').toLowerCase().includes('pancake') &&
        (p.quoteToken?.symbol === 'WBNB' || (p.quoteToken?.address || '').toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') &&
        (p.liquidity?.usd || 0) >= DEX_MIN_LP_USD
      );

      if (good.length) {
        const lines = good.map(formatPairLine).join('\n');
        await tgSend(
          `🚨 *Pair detected within ${DEXCHECK_WINDOW_MIN}m*\n`
          + `Token: \`${createdAddr}\`\n`
          + `Created @ ${createdAtUtc} UTC\n`
          + `Threshold: $${DEX_MIN_LP_USD}\n`
          + `${lines}`
        );
        clearInterval(timer);
      }
    } catch (e) {
      // глушим, просто попробуем в следующем тике
    }
  }, DEXCHECK_INTERVAL_MS);
}

// Основной цикл: ловим новые Contract Creation
async function tick() {
  try {
    const txs = await fetchDeployerTxs();
    for (const tx of txs) {
      const isNewerBlock = Number(tx.blockNumber) > lastBlockChecked;
      const isCreation = (tx.to === '' || tx.to === null); // у creation поле 'to' пустое
      const fresh = (Date.now()/1000 - Number(tx.timeStamp)) < (60*60*6); // ограничим последние 6ч

      if (!isNewerBlock && seenTx.has(tx.hash)) continue;
      if (!isCreation || !fresh) continue;

      // узнаём адрес созданного контракта
      const contractAddr = await getCreatedContract(tx.hash);
      if (!contractAddr) continue;

      seenTx.add(tx.hash);
      lastBlockChecked = Math.max(lastBlockChecked, Number(tx.blockNumber));

      const createdAtUtc = new Date(Number(tx.timeStamp)*1000).toISOString().replace('T',' ').replace('.000Z','');

      await tgSend(
        `🆕 *Contract Creation detected*\n`
        + `Deployer: \`${DEPLOYER}\`\n`
        + `Tx: \`${tx.hash}\`\n`
        + `Created: \`${contractAddr}\`\n`
        + `Block: ${tx.blockNumber}\n`
        + `Time (UTC): ${createdAtUtc}`
      );

      // Сразу запускаем слежение за появлением пары
      scheduleDexWatch(contractAddr, createdAtUtc);
    }
  } catch (e) {
    console.error('tick error', e);
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

// boot
bot.launch().then(() => {
  tgSend('🤖 Omni Agent live. Monitoring deployer: `' + DEPLOYER + '`');
  tick();
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- keep Render happy ---
import express from "express";
const app = express();
app.get("/", (req, res) => res.send("Omni Agent running"));
app.listen(process.env.PORT || 10000, () => {
  console.log(`Server ready on port ${process.env.PORT || 10000}`);
});
