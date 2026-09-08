import { applyBotConfig, hasLayer3Binding, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JsonStateStore } from './state-store.js';
import { Layer3Browser } from './layer3-browser.js';
import { AutoStopScheduler } from './auto-stop.js';
import { formatStatusReport } from './estimate.js';
import { TelegramBot, confirmKeyboard, mainKeyboard } from './telegram.js';

const baseConfig = loadConfig();
const logger = createLogger(baseConfig.logLevel);
const botConfigStore = new JsonStateStore(baseConfig.botConfigPath);
let botConfig = {};
try {
  botConfig = await botConfigStore.read();
} catch (error) {
  logger.warn('Could not read saved bot binding; starting unbound', { error: error.message });
}
let config = applyBotConfig(baseConfig, botConfig);
const bindingSessions = new Map();
const telegramOffsetStore = new JsonStateStore(config.telegramStatePath);
const telegram = new TelegramBot(config.telegramToken, config.allowedChatIds, logger, telegramOffsetStore);
const layer3 = new Layer3Browser(config, logger);
const store = new JsonStateStore(config.runtimeStatePath);
const scheduler = new AutoStopScheduler(
  store,
  () => {
    if (!hasLayer3Binding(config)) {
      throw new Error('Layer3 machine is not bound');
    }
    return layer3.stop();
  },
  (message) => telegram.broadcast(message),
  logger,
);

async function sendStatus(chatId) {
  if (!hasLayer3Binding(config)) {
    await telegram.send(chatId, '还没有绑定 Layer3 机器。请发送 /bind 开始绑定。');
    return;
  }
  const [status, autoStopAt] = await Promise.all([layer3.status(), scheduler.dueAt()]);
  await telegram.send(chatId, formatStatusReport(status, config, autoStopAt), mainKeyboard);
}

async function saveBotConfig(nextConfig) {
  botConfig = nextConfig;
  await botConfigStore.write(botConfig);
  config = applyBotConfig(baseConfig, botConfig);
  telegram.setAllowedChatIds(config.allowedChatIds);
  layer3.config = config;
}

async function bindFirstChat(chatId) {
  if (telegram.hasAllowedChats()) return;
  const nextConfig = {
    ...botConfig,
    allowedChatIds: [String(chatId)],
  };
  await saveBotConfig(nextConfig);
  await telegram.send(chatId, '已把当前 Telegram Chat ID 设为管理员。接下来发送 /bind 绑定 Layer3 账号和机器。');
}

function startBinding(chatId) {
  bindingSessions.set(String(chatId), {
    step: 'email',
    values: {},
  });
}

async function promptBindingStep(chatId, session) {
  const prompts = {
    email: '请输入 Layer3 登录邮箱：',
    password: '请输入 Layer3 登录密码：\n提示：Telegram 聊天记录会保存这条消息，建议绑定完成后手动删除密码消息。',
    projectSlug: '请输入 Layer3 项目标识，不是页面显示名。请打开机器详情页，从地址栏 /app/projects/<这里>/机器名/overview 复制，例如 default-828：',
    instanceName: '请输入 Layer3 机器实例名称，例如 vm-f9k5yf10c：',
    hourlyPrice: '请输入完整小时价格 NGN，例如 22.37702。发送“默认”使用 22.37702：',
    autoStopMinutes: '请输入“启动 1 小时”按钮的自动关机分钟数。发送“默认”使用 60：',
  };
  await telegram.send(chatId, prompts[session.step]);
}

async function finishBinding(chatId, values) {
  const nextConfig = {
    ...botConfig,
    allowedChatIds: [...config.allowedChatIds].length ? [...config.allowedChatIds] : [String(chatId)],
    email: values.email,
    passwordBase64: Buffer.from(values.password, 'utf8').toString('base64'),
    projectSlug: values.projectSlug,
    instanceName: values.instanceName,
    hourlyPrice: values.hourlyPrice,
    autoStopMinutes: values.autoStopMinutes,
    estimatedHoursPerDay: 1,
  };
  await saveBotConfig(nextConfig);
  bindingSessions.delete(String(chatId));
  await telegram.send(chatId, '绑定信息已保存。正在自动检查 Layer3 机器状态，请稍候...');
  await sendStatus(chatId);
  await telegram.send(chatId, '检查完成。现在可以使用下方按钮或命令启动、启动 1 小时、关机。', mainKeyboard);
}

async function handleBindingMessage(chatId, text) {
  const session = bindingSessions.get(String(chatId));
  if (!session) return false;

  let value = text.trim();
  if (value.toLowerCase() === '/cancel') {
    bindingSessions.delete(String(chatId));
    await telegram.send(chatId, '绑定流程已取消。', mainKeyboard);
    return true;
  }
  if (session.step === 'email') {
    value = value.replace(/^\/bind(@\w+)?\s+/i, '').trim();
  }
  if (session.step !== 'hourlyPrice' && session.step !== 'autoStopMinutes' && !value) {
    await telegram.send(chatId, '这一项不能为空，请重新输入。');
    await promptBindingStep(chatId, session);
    return true;
  }

  if (session.step === 'email') {
    session.values.email = value;
    session.step = 'password';
  } else if (session.step === 'password') {
    session.values.password = value;
    session.step = 'projectSlug';
  } else if (session.step === 'projectSlug') {
    session.values.projectSlug = value;
    session.step = 'instanceName';
  } else if (session.step === 'instanceName') {
    session.values.instanceName = value;
    session.step = 'hourlyPrice';
  } else if (session.step === 'hourlyPrice') {
    const hourlyPrice = ['默认', 'default', 'd'].includes(value.toLowerCase()) ? 22.37702 : Number(value);
    if (!Number.isFinite(hourlyPrice) || hourlyPrice <= 0) {
      await telegram.send(chatId, '小时价格必须是大于 0 的数字，或发送“默认”。请重新输入。');
      return true;
    }
    session.values.hourlyPrice = hourlyPrice;
    session.step = 'autoStopMinutes';
  } else if (session.step === 'autoStopMinutes') {
    const autoStopMinutes = ['默认', 'default', 'd'].includes(value.toLowerCase()) ? 60 : Number(value);
    if (!Number.isFinite(autoStopMinutes) || autoStopMinutes <= 0) {
      await telegram.send(chatId, '自动关机分钟数必须是大于 0 的数字，或发送“默认”。请重新输入。');
      return true;
    }
    session.values.autoStopMinutes = autoStopMinutes;
    await finishBinding(chatId, session.values);
    return true;
  }

  await promptBindingStep(chatId, session);
  return true;
}

async function requireBinding(chatId) {
  if (hasLayer3Binding(config)) return true;
  await telegram.send(chatId, '还没有绑定 Layer3 机器。请发送 /bind 按提示输入账号、密码和机器信息。');
  return false;
}

async function handleUpdate(update) {
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  if (!chatId) return;
  if (!telegram.hasAllowedChats()) {
    const firstCommand = update.message?.text?.trim().split(/\s+/)[0].toLowerCase();
    const chatType = update.message?.chat?.type;
    if (firstCommand === '/start' && chatType !== 'private') {
      await telegram.send(chatId, '首次绑定管理员请私聊机器人发送 /start，不要在群组里绑定。');
      return;
    }
    if (firstCommand !== '/start') {
      await telegram.send(chatId, '首次使用请发送 /start 绑定当前 Telegram 账号为管理员。');
      return;
    }
    await bindFirstChat(chatId);
  }
  if (!telegram.isAllowed(chatId)) {
    logger.warn('Ignored update from unauthorized chat', { chatId });
    return;
  }

  if (update.message) {
    const text = update.message.text || '';
    const command = text.trim().split(/\s+/)[0].toLowerCase();
    if (await handleBindingMessage(chatId, text)) return;
    if (command === '/start' || command === '/help') {
      await telegram.send(chatId, [
        '<b>Layer3 机器控制</b>',
        '/bind - 绑定或重新绑定 Layer3 账号和机器',
        '/status - 查看余额、状态和预计可用时间',
        '/startvm - 持续启动机器',
        '/start1h - 启动机器 1 小时后自动关机',
        '/stopvm - 请求立即关机',
      ].join('\n'), mainKeyboard);
      if (!hasLayer3Binding(config)) {
        await telegram.send(chatId, '首次使用请发送 /bind 绑定 Layer3 账号和机器。');
      }
    } else if (command === '/bind') {
      startBinding(chatId);
      await promptBindingStep(chatId, bindingSessions.get(String(chatId)));
    } else if (command === '/status') {
      await sendStatus(chatId);
    } else if (command === '/startvm') {
      if (!await requireBinding(chatId)) return;
      await telegram.send(chatId, '机器将持续运行并开始计费，同时取消现有自动关机任务。', confirmKeyboard('start'));
    } else if (command === '/start1h') {
      if (!await requireBinding(chatId)) return;
      await telegram.send(chatId, `启动后将开始计费，并在 ${config.autoStopMinutes} 分钟后执行控制台 Power Off。到期前请保存数据。`, confirmKeyboard('start1h'));
    } else if (command === '/stopvm') {
      if (!await requireBinding(chatId)) return;
      await telegram.send(chatId, '确认执行控制台 Power Off 吗？这可能是强制断电，请先保存数据。', confirmKeyboard('stop'));
    }
    return;
  }

  const query = update.callback_query;
  await telegram.answerCallback(query.id, '处理中');
  const action = query.data;
  if (action === 'status') {
    await sendStatus(chatId);
  } else if (action === 'start_request') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, '机器将持续运行并开始计费，同时取消现有自动关机任务。', confirmKeyboard('start'));
  } else if (action === 'start1h_request') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, `启动后将开始计费，并在 ${config.autoStopMinutes} 分钟后执行控制台 Power Off。到期前请保存数据。`, confirmKeyboard('start1h'));
  } else if (action === 'stop_request') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, '确认执行控制台 Power Off 吗？这可能是强制断电，请先保存数据。', confirmKeyboard('stop'));
  } else if (action === 'start_confirm') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, '正在启动机器，请稍候...');
    const result = await layer3.start();
    await scheduler.cancel();
    await telegram.send(chatId, `${result.changed ? '机器已启动' : '机器已经在运行'}，当前没有自动关机任务。`, mainKeyboard);
  } else if (action === 'start1h_confirm') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, '正在启动机器，请稍候...');
    const result = await layer3.start();
    const dueAt = await scheduler.schedule(config.autoStopMinutes);
    await telegram.send(chatId, `${result.changed ? '机器已启动' : '机器已经在运行'}。\n计划关机时间：${new Date(dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, mainKeyboard);
  } else if (action === 'stop_confirm') {
    if (!await requireBinding(chatId)) return;
    await telegram.send(chatId, '正在执行控制台 Power Off，请稍候...');
    const result = await layer3.stop();
    await scheduler.cancel();
    await telegram.send(chatId, result.changed ? '机器已关机。' : '机器原本就是关机状态。', mainKeyboard);
  } else if (action === 'cancel') {
    await telegram.send(chatId, '操作已取消。', mainKeyboard);
  }
}

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
  await layer3.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await scheduler.restore();
logger.info('Bot started');
await telegram.start();
