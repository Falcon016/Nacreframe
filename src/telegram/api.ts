import { homedir } from 'node:os';

/**
 * The few Telegram Bot API calls the bot needs, over plain HTTPS with long polling (no webhook, so it works from
 * a home network without opening a port). The token is part of every URL, so errors never include the URL.
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

export interface SendOptions {
  html?: boolean;
  keyboard?: InlineKeyboard;
  /** Send without a notification sound (progress updates). */
  silent?: boolean;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

/** Telegram's limit on one message. */
export const MAX_MESSAGE = 4096;

export class TelegramApi {
  private base: string;
  constructor(token: string, opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    if (!/^\d+:[\w-]{20,}$/.test(token))
      throw new TelegramError('That does not look like a bot token (123456:ABC…).');
    this.base = `${(opts.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')}/bot${token}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  private fetchImpl: typeof fetch;

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        // The cause (DNS, refused, reset) is useful; the URL would contain the token.
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        throw new TelegramError(`Could not reach Telegram${cause ? ` (${cause})` : ''}`);
      }
      let body: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new TelegramError(`Telegram answered ${method} with HTTP ${res.status}`, res.status);
      }
      if (body.ok) return body.result as T;
      const retryAfter = body.parameters?.retry_after;
      // Flood control: wait as told, a few times, then give up.
      if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
        continue;
      }
      throw new TelegramError(
        body.description ?? `Telegram ${method} failed (HTTP ${res.status})`,
        res.status,
        retryAfter,
      );
    }
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call<TgUser>('getMe', {}, signal);
  }

  /** Long poll: waits up to `timeout` seconds for something new. */
  getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'callback_query'] },
      signal,
    );
  }

  /** Long polling stops working while a webhook is set, so the bot clears any left over. */
  deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  sendMessage(chatId: number, text: string, o: SendOptions = {}): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(o.html ? { parse_mode: 'HTML' } : {}),
      ...(o.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
      ...(o.silent ? { disable_notification: true } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, o: SendOptions = {}): Promise<unknown> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(o.html ? { parse_mode: 'HTML' } : {}),
      reply_markup: { inline_keyboard: o.keyboard ?? [] },
      link_preview_options: { is_disabled: true },
    });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  sendChatAction(chatId: number, action: 'typing'): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands });
  }
}

/** The token as it may appear in logs: the bot id only. */
export const maskToken = (token: string) => `${token.split(':')[0]}:…`;

/** Where the bot token is kept in auth.json (beside provider keys, owner-only). */
export const TELEGRAM_KEY = 'telegram';

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);
