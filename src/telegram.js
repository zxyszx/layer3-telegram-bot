export class TelegramBot {
  constructor(token, allowedChatIds, logger, offsetStore) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.allowedChatIds = allowedChatIds;
    this.logger = logger;
    this.offsetStore = offsetStore;
    this.offset = 0;
    this.running = false;
    this.handler = null;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description || response.status}`);
    return body.result;
  }

  async send(chatId, text, replyMarkup) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async answerCallback(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  isAllowed(chatId) {
    return this.allowedChatIds.has(String(chatId));
  }

  hasAllowedChats() {
    return this.allowedChatIds.size > 0;
  }

  setAllowedChatIds(chatIds) {
    this.allowedChatIds = new Set([...chatIds].map(String));
  }

  setHandler(handler) {
    this.handler = handler;
  }

  async broadcast(text) {
    await Promise.allSettled([...this.allowedChatIds].map((chatId) => this.send(chatId, text)));
  }

  async start() {
    const saved = await this.offsetStore.read();
    this.offset = Number.isSafeInteger(saved.offset) ? saved.offset : 0;
    this.running = true;
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset,
          timeout: 45,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          // Persist before side effects so a process crash cannot replay a paid action.
          await this.offsetStore.write({ offset: this.offset });
          await this.handler?.(update);
        }
      } catch (error) {
        this.logger.error('Telegram polling failed', { error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

export const mainKeyboard = {
  inline_keyboard: [
    [{ text: '刷新状态', callback_data: 'status' }],
    [
      { text: '启动', callback_data: 'start_request' },
      { text: '启动 1 小时', callback_data: 'start1h_request' },
      { text: '立即关机', callback_data: 'stop_request' },
    ],
  ],
};

export function confirmKeyboard(action) {
  const labels = {
    start: '确认持续启动',
    start1h: '确认启动 1 小时',
    stop: '确认立即关机',
  };
  return {
    inline_keyboard: [[
      { text: labels[action], callback_data: `${action}_confirm` },
      { text: '取消', callback_data: 'cancel' },
    ]],
  };
}
