import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

// --- ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;   // токен BotFather
const CHAT_ID   = process.env.CHAT_ID;     // id лички или канала
// Ниже — заготовка под фильтр (можно оставить по умолчанию и позже допилить)
const FILTERS_JSON = process.env.FILTERS_JSON || '{"chains":["bsc"],"watch":["contract_creation","add_liquidity"]}';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing BOT_TOKEN or CHAT_ID env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Простая команда для проверки
bot.command('ping', (ctx) => ctx.reply('✅ Bot is alive!'));

// Пример «фиктивного» мониторинга (каждые 60 сек)
async function tick() {
  try {
    // TODO: здесь подключим реальные проверки (BscScan, Dexscreener и т.п.)
    // Пока просто демонстрационное сообщение раз в 10 минут:
    // (чтобы не спамить, ставим таймер ниже на 600000)
  } catch (e) {
    console.error('tick error', e);
  } finally {
    setTimeout(tick, 600000);
  }
}
tick();

// Стартуем long polling
bot.launch().then(() => {
  console.log('Bot started');
  // Отправим привет один раз при старте:
  bot.telegram.sendMessage(
    CHAT_ID,
    '🤖 Omni Agent запущен. Команда: /ping — проверка связи.'
  ).catch(()=>{});
});

// Корректная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
