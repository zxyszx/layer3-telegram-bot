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
    values: {
      email: isValidEmail(config.email) ? config.email : '',
      password: config.password || '',
    },
  });
}

async function promptBindingStep(chatId, session) {
  const hasSavedEmail = Boolean(config.email || session.values.email);
  const hasSavedPassword = Boolean(config.password || session.values.password);
  const prompts = {
    email: hasSavedEmail
      ? '请输入 Layer3 登录邮箱，或发送“默认”继续使用已保存邮箱。'
      : '请输入 Layer3 登录邮箱：',
    password: hasSavedPassword
      ? '请输入 Layer3 登录密码，或发送“默认”继续使用已保存密码：'
      : '请输入 Layer3 登录密码：\n提示：Telegram 聊天记录会保存这条消息，建议绑定完成后手动删除密码消息。',
    instanceChoice: '请输入要绑定的机器编号：',
  };
  await telegram.send(chatId, prompts[session.step]);
}

function isDefaultInput(value) {
  return ['默认', 'default', 'd'].includes(value.toLowerCase());
}

function normalizeEmailInput(value) {
  return value.trim().replace(/\\@/g, '@').replace(/\s+/g, '');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function formatInstanceList(discovery) {
  const balanceLine = discovery.balance == null
    ? '账户余额：未能自动读取'
    : `账户余额：NGN ${new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(discovery.balance)}`;
  const countsLine = discovery.counts
    ? `机器统计：${discovery.counts.total} 台，运行 ${discovery.counts.running}，停止 ${discovery.counts.stopped}，错误 ${discovery.counts.error}`
    : `机器统计：读取到 ${discovery.instances.length} 台`;
  const rows = discovery.instances.map((instance, index) => {
    const details = [
      instance.status,
      instance.ip && `IP ${instance.ip}`,
      instance.cpu,
      instance.ram && `内存 ${instance.ram}`,
      instance.storage && `硬盘 ${instance.storage}`,
      instance.allTimeConsumption != null && `累计 NGN ${new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(instance.allTimeConsumption)}`,
    ].filter(Boolean).join(' / ');
    const project = instance.projectSlug ? `项目：${instance.projectSlug}` : '项目：未自动识别';
    return `${index + 1}. ${instance.name}\n   ${project}${details ? `\n   ${details}` : ''}`;
  });
  return [
    '已登录 Layer3，并读取到机器列表：',
    balanceLine,
    countsLine,
    '',
    ...rows,
  ].join('\n');
}

function formatSelectedInstance(instance) {
  return [
    `已选择机器：${instance.name}`,
    instance.projectSlug && `项目标识：${instance.projectSlug}`,
    instance.status && `当前状态：${instance.status}`,
    instance.ip && `公网 IP：${instance.ip}`,
    instance.cpu && `CPU：${instance.cpu}`,
    instance.ram && `内存：${instance.ram}`,
    instance.storage && `硬盘：${instance.storage}`,
    instance.allTimeConsumption != null && `累计消费：NGN ${new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(instance.allTimeConsumption)}`,
  ].filter(Boolean).join('\n');
}

async function finishBindingWithInstance(chatId, session, instance) {
  if (!instance?.projectSlug || !instance?.name) {
    await telegram.send(chatId, [
      '自动读取到了机器，但没有拿到完整项目标识和机器名，无法安全绑定。',
      '请在服务器运行 ngn diagnostics 查看页面诊断信息。',
    ].join('\n'));
    bindingSessions.delete(String(chatId));
    return;
  }

  session.values.instanceName = instance.name;
  session.values.projectSlug = instance.projectSlug;
  session.values.hourlyPrice = config.hourlyPrice || baseConfig.hourlyPrice;
  session.values.autoStopMinutes = config.autoStopMinutes || baseConfig.autoStopMinutes;
  await telegram.send(chatId, formatSelectedInstance(instance));
  await finishBinding(chatId, session.values);
}

async function discoverInstancesForBinding(chatId, session) {
  const temporaryConfig = applyBotConfig(baseConfig, {
    ...botConfig,
    allowedChatIds: [...config.allowedChatIds].length ? [...config.allowedChatIds] : [String(chatId)],
    email: session.values.email,
    passwordBase64: Buffer.from(session.values.password, 'utf8').toString('base64'),
  });

  layer3.config = temporaryConfig;
  await telegram.send(chatId, '正在登录 Layer3 并读取账户余额和机器列表，请稍候...');
  let discovery;
  try {
    discovery = await layer3.listInstances();
  } catch (error) {
    logger.warn('Layer3 discovery failed during binding', {
      error: error.message,
    });
    await telegram.send(chatId, [
      `自动读取机器列表失败：${error.message}`,
      '',
      '已取消绑定流程，不再要求手动输入项目标识和机器名。',
      '请在服务器运行 ngn diagnostics 查看登录页面、接口状态和最近日志。',
    ].join('\n'));
    bindingSessions.delete(String(chatId));
    return;
  }
  session.discovery = discovery;

  if (discovery.instances.length === 0) {
    await telegram.send(chatId, [
      '已经登录 Layer3，但没有自动读取到任何机器。',
      '已取消绑定流程，不再要求手动输入项目标识和机器名。',
      '请确认 Layer3 控制台实例列表里有机器，或在服务器运行 ngn diagnostics 查看页面诊断信息。',
    ].join('\n'));
    bindingSessions.delete(String(chatId));
    return;
  }

  await telegram.send(chatId, formatInstanceList(discovery));
  if (discovery.instances.length === 1 && discovery.instances[0].projectSlug) {
    await finishBindingWithInstance(chatId, session, discovery.instances[0]);
    return;
  }

  session.step = 'instanceChoice';
  await promptBindingStep(chatId, session);
}

async function savePartialCredentials(chatId, values) {
  await saveBotConfig({
    ...botConfig,
    allowedChatIds: [...config.allowedChatIds].length ? [...config.allowedChatIds] : [String(chatId)],
    email: values.email,
    passwordBase64: Buffer.from(values.password, 'utf8').toString('base64'),
  });
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
  try {
    await sendStatus(chatId);
    await telegram.send(chatId, '检查完成。现在可以使用下方按钮或命令启动、启动 1 小时、关机。', mainKeyboard);
  } catch (error) {
    logger.warn('Layer3 status check failed after saving binding', { error: error.message });
    await telegram.send(chatId, [
      `绑定已保存，但自动检查暂时失败：${error.message}`,
      '',
      '后续不用重新输入账号密码。请稍后发送 /status 重试，或在服务器运行 ngn 查看日志。',
    ].join('\n'), mainKeyboard);
  }
}

async function handleBindingMessage(chatId, text) {
  const session = bindingSessions.get(String(chatId));
  if (!session) return false;

  let value = text.trim();
  const command = value.split(/\s+/)[0].toLowerCase();
  if (value.toLowerCase() === '/cancel') {
    bindingSessions.delete(String(chatId));
    await telegram.send(chatId, '绑定流程已取消。', mainKeyboard);
    return true;
  }
  if (command.startsWith('/') && command !== '/bind') {
    bindingSessions.delete(String(chatId));
    return false;
  }
  if (session.step === 'email') {
    value = value.replace(/^\/bind(@\w+)?\s+/i, '').trim();
  }
  if (!value) {
    await telegram.send(chatId, '这一项不能为空，请重新输入。');
    await promptBindingStep(chatId, session);
    return true;
  }

  if (session.step === 'email') {
    if (isDefaultInput(value)) {
      if (!session.values.email) {
        await telegram.send(chatId, '还没有保存过有效 Layer3 邮箱，请输入邮箱。');
        return true;
      }
      value = session.values.email;
    }
    value = normalizeEmailInput(value);
    if (!isValidEmail(value)) {
      await telegram.send(chatId, '邮箱格式不正确，请重新输入 Layer3 登录邮箱。');
      return true;
    }
    session.values.email = value;
    session.step = 'password';
  } else if (session.step === 'password') {
    if (isDefaultInput(value)) {
      if (!session.values.password) {
        await telegram.send(chatId, '还没有保存过 Layer3 密码，请输入密码。');
        return true;
      }
      value = session.values.password;
    }
    session.values.password = value;
    await savePartialCredentials(chatId, session.values);
    await discoverInstancesForBinding(chatId, session);
    return true;
  } else if (session.step === 'instanceChoice') {
    const choice = Number(value);
    const instance = Number.isInteger(choice) ? session.discovery?.instances[choice - 1] : null;
    if (!instance) {
      await telegram.send(chatId, '机器编号无效，请重新输入列表中的编号。');
      return true;
    }
    await finishBindingWithInstance(chatId, session, instance);
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
      if (text.trim().split(/\s+/).length > 1) {
        await handleBindingMessage(chatId, text);
      } else {
        await promptBindingStep(chatId, bindingSessions.get(String(chatId)));
      }
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
