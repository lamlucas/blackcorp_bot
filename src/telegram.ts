const botUserIdByToken = new Map<string, number>();

export type TelegramBotIdentity = {
  id: number;
  username?: string;
  first_name?: string;
};

/** getMe — cache theo token trong vòng đời Worker. */
export async function getTelegramBotIdentity(token: string): Promise<TelegramBotIdentity> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await res.json()) as {
    ok?: boolean;
    result?: TelegramBotIdentity;
    description?: string;
  };
  if (!data.ok || data.result?.id == null) {
    throw new Error(data.description || "getMe thất bại");
  }
  botUserIdByToken.set(token, data.result.id);
  return data.result;
}

export async function getTelegramBotUserId(token: string): Promise<number> {
  const cached = botUserIdByToken.get(token);
  if (cached != null) return cached;
  const me = await getTelegramBotIdentity(token);
  return me.id;
}

export function escapeHtmlTelegram(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function tgApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok?: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result as T;
}

export async function sendHtmlMessage(
  token: string,
  chatId: string,
  html: string
): Promise<{ message_id: number }> {
  return tgApi(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function pinMessage(token: string, chatId: string, messageId: number): Promise<void> {
  await tgApi(token, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

export async function sendPhotoUrl(token: string, chatId: string, photoUrl: string): Promise<void> {
  await tgApi(token, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
  });
}

export async function sendPlainMessage(
  token: string,
  chatId: string,
  text: string
): Promise<{ message_id: number }> {
  return tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

/** Chuyển tin (ảnh) sang nhóm hub Thu chi. */
export async function copyMessage(
  token: string,
  toChatId: number,
  fromChatId: number,
  messageId: number
): Promise<void> {
  await tgApi(token, "copyMessage", {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}
