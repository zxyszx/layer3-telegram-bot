import { formatStatusReport } from './estimate.js';
import {
  confirmKeyboard,
  mainKeyboard,
  statusKeyboard,
} from './telegram.js';

export function createUpdateHandler({ config, logger, telegram, layer3, scheduler }) {
  async function sendStatus(chatId) {
    const [status, autoStopAt] = await Promise.all([layer3.status(), scheduler.dueAt()]);
    await telegram.send(
      chatId,
      formatStatusReport(status, config, autoStopAt),
      statusKeyboard(status.instanceStatus),
    );
  }

  return async function handleUpdate(update) {
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (!chatId || !telegram.isAllowed(chatId)) {
      logger.warn('Ignored update from unauthorized chat', { chatId });
      return;
    }

    if (update.message) {
      const command = update.message.text?.trim().split(/\s+/)[0].toLowerCase();
      if (command === '/start' || command === '/help') {
        await telegram.send(chatId, [
          '<b>Layer3 机器控制</b>',
          '/status - 查看余额、状态和预计可用时间',
          '/startvm - 持续启动机器',
          '/start1h - 启动机器 1 小时后自动关机',
          '/stopvm - 请求立即关机',
        ].join('\n'), mainKeyboard);
      } else if (command === '/status') {
        await sendStatus(chatId);
      } else if (command === '/startvm') {
        await telegram.send(chatId, '机器将持续运行并开始计费，同时取消现有自动关机任务。', confirmKeyboard('start'));
      } else if (command === '/start1h') {
        await telegram.send(chatId, `启动后将开始计费，并在 ${config.autoStopMinutes} 分钟后执行控制台 Power Off。到期前请保存数据。`, confirmKeyboard('start1h'));
      } else if (command === '/stopvm') {
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
      await telegram.send(chatId, '机器将持续运行并开始计费，同时取消现有自动关机任务。', confirmKeyboard('start'));
    } else if (action === 'start1h_request') {
      await telegram.send(chatId, `启动后将开始计费，并在 ${config.autoStopMinutes} 分钟后执行控制台 Power Off。到期前请保存数据。`, confirmKeyboard('start1h'));
    } else if (action === 'stop_request') {
      await telegram.send(chatId, '确认执行控制台 Power Off 吗？这可能是强制断电，请先保存数据。', confirmKeyboard('stop'));
    } else if (action === 'start_confirm') {
      await telegram.send(chatId, '正在启动机器，请稍候...');
      const result = await layer3.start();
      await scheduler.cancel();
      await telegram.send(chatId, `${result.changed ? '机器已启动' : '机器已经在运行'}，当前没有自动关机任务。`, statusKeyboard(result.status));
    } else if (action === 'start1h_confirm') {
      await telegram.send(chatId, '正在启动机器，请稍候...');
      const result = await layer3.start();
      const dueAt = await scheduler.schedule(config.autoStopMinutes);
      await telegram.send(chatId, `${result.changed ? '机器已启动' : '机器已经在运行'}。\n计划关机时间：${new Date(dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, statusKeyboard(result.status));
    } else if (action === 'stop_confirm') {
      await telegram.send(chatId, '正在执行控制台 Power Off，请稍候...');
      const result = await layer3.stop();
      await scheduler.cancel();
      await telegram.send(chatId, result.changed ? '机器已关机。' : '机器原本就是关机状态。', statusKeyboard(result.status));
    } else if (action === 'cancel') {
      await telegram.send(chatId, '操作已取消。', mainKeyboard);
    }
  };
}
