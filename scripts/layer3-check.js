import { applyBotConfig, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { JsonStateStore } from '../src/state-store.js';
import { Layer3Browser } from '../src/layer3-browser.js';

function sanitize(value) {
  return JSON.parse(JSON.stringify(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/password["']?\s*:\s*["'][^"']+["']/gi, 'password":"[redacted]"'));
}

const baseConfig = loadConfig();
const store = new JsonStateStore(baseConfig.botConfigPath);
const botConfig = await store.read();
const config = applyBotConfig(baseConfig, botConfig);

if (!config.email || !config.password) {
  throw new Error('还没有保存 Layer3 邮箱和密码。请先在 Telegram 发送 /bind 输入一次。');
}

const logger = createLogger(config.logLevel);
const layer3 = new Layer3Browser({
  ...config,
  profileDir: `${config.dataDir}/browser-test-profile`,
}, logger);

try {
  const discovery = await layer3.listInstances();
  console.log(JSON.stringify(sanitize(discovery), null, 2));
} finally {
  await layer3.close();
}
