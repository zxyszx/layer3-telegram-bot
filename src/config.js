import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveNumber(name, fallback) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function parseChatIds(value) {
  const ids = new Set(
    value.split(',').map((id) => id.trim()).filter(Boolean),
  );
  if (ids.size === 0) throw new Error('TELEGRAM_ALLOWED_CHAT_IDS must contain at least one chat ID');
  return ids;
}

export function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const instancesUrl = process.env.LAYER3_INSTANCES_URL?.trim()
    || 'https://console.layer3.cloud/app/virtual-machines';
  const instanceName = required('LAYER3_INSTANCE_NAME');
  const projectSlug = required('LAYER3_PROJECT_SLUG');
  const consoleOrigin = new URL(instancesUrl).origin;
  const encodedPassword = process.env.LAYER3_PASSWORD_BASE64?.trim();
  const password = encodedPassword
    ? Buffer.from(encodedPassword, 'base64').toString('utf8')
    : (process.env.LAYER3_PASSWORD || '');
  return {
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    allowedChatIds: parseChatIds(required('TELEGRAM_ALLOWED_CHAT_IDS')),
    instanceName,
    projectSlug,
    instancesUrl,
    instanceUrl: `${consoleOrigin}/app/projects/${encodeURIComponent(projectSlug)}/${encodeURIComponent(instanceName)}/overview`,
    email: process.env.LAYER3_EMAIL?.trim() || '',
    password,
    hourlyPrice: positiveNumber('INSTANCE_HOURLY_NGN', 22.37702),
    autoStopMinutes: positiveNumber('AUTO_STOP_MINUTES', 60),
    estimatedHoursPerDay: positiveNumber('ESTIMATED_HOURS_PER_DAY', 1),
    headless: (process.env.HEADLESS || 'true').toLowerCase() !== 'false',
    dataDir,
    profileDir: path.join(dataDir, 'browser-profile'),
    runtimeStatePath: path.join(dataDir, 'runtime.json'),
    telegramStatePath: path.join(dataDir, 'telegram.json'),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
