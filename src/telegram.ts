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
  body: Record<string, unknown>,
  opts?: { maxRetries?: number },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 5;
  let lastDesc = `Telegram ${method} failed`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };

    if (data.ok) return data.result as T;

    lastDesc = data.description || lastDesc;
    const retryAfterSec =
      data.parameters?.retry_after ??
      (() => {
        const m = lastDesc.match(/retry after (\d+)/i);
        return m ? Number(m[1]) : undefined;
      })();

    const isRateLimit =
      res.status === 429 ||
      data.error_code === 429 ||
      /too many requests|retry after|flood/i.test(lastDesc);

    if (isRateLimit && attempt < maxRetries) {
      const waitMs = Math.min(Math.max((retryAfterSec ?? 2) * 1000, 1500), 60_000);
      await new Promise<void>((r) => setTimeout(r, waitMs));
      continue;
    }

    throw new Error(lastDesc);
  }

  throw new Error(lastDesc);
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

export async function sendPhotoUrl(
  token: string,
  chatId: string,
  photoUrl: string,
): Promise<{ message_id: number }> {
  // Telegram có thể cache ảnh theo URL; thêm query để luôn lấy bản mới khi bạn đổi ảnh/QR.
  let url = String(photoUrl ?? "").trim();
  try {
    const u = new URL(url);
    u.searchParams.set("_t", String(Date.now()));
    url = u.toString();
  } catch {
    // ignore invalid URL
  }
  return tgApi(token, "sendPhoto", {
    chat_id: chatId,
    photo: url,
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

export type TelegramWebhookInfo = {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_message?: string;
};

export async function getWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = (await res.json()) as { ok?: boolean; result?: TelegramWebhookInfo; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(data.description || "getWebhookInfo thất bại");
  }
  return data.result;
}

export async function deleteWebhook(token: string, dropPending = false): Promise<void> {
  const q = dropPending ? "?drop_pending_updates=true" : "";
  const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook${q}`);
  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (!data.ok) throw new Error(data.description || "deleteWebhook thất bại");
}

export async function setTelegramWebhook(
  token: string,
  url: string,
  secretToken?: string,
): Promise<void> {
  const body: Record<string, unknown> = { url };
  if (secretToken?.trim()) body.secret_token = secretToken.trim();
  await tgApi(token, "setWebhook", body);
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
