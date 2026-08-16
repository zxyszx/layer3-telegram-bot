import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JsonStateStore } from './state-store.js';
import { Layer3Browser } from './layer3-browser.js';
import { AutoStopScheduler } from './auto-stop.js';
import { TelegramBot, mainKeyboard } from './telegram.js';
import { createUpdateHandler } from './update-handler.js';
import { BillingTracker } from './billing.js';
import { createBillingAwareLayer3 } from './lifecycle.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const telegramOffsetStore = new JsonStateStore(config.telegramStatePath);
const telegram = new TelegramBot(config.telegramToken, config.allowedChatIds, logger, telegramOffsetStore);
const rawLayer3 = new Layer3Browser(config, logger);
const billingStore = new JsonStateStore(config.billingHistoryPath);
const billing = new BillingTracker({
  config,
  layer3: rawLayer3,
  store: billingStore,
  notify: (message) => telegram.broadcast(message),
  logger,
});
const layer3 = createBillingAwareLayer3(rawLayer3, billing, logger);
const store = new JsonStateStore(config.runtimeStatePath);
const scheduler = new AutoStopScheduler(
  store,
  () => layer3.stop(),
  (message) => telegram.broadcast(message),
  logger,
);

const handleUpdate = createUpdateHandler({ config, logger, telegram, layer3, scheduler, billing });

telegram.setHandler(async (update) => {
  try {
    await handleUpdate(update);
  } catch (error) {
    logger.error('Update handling failed', { error: error.message });
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId && telegram.isAllowed(chatId)) {
      await telegram.send(chatId, `操作失败：${error.message}`, mainKeyboard).catch(() => {});
    }
  }
});

async function shutdown(signal) {
  logger.info('Shutting down', { signal });
  telegram.stop();
  await billing.close();
  await rawLayer3.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await rawLayer3.init();
await billing.restore();
await scheduler.restore();
logger.info('Bot started');
await telegram.start();
