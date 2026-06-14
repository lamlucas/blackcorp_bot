import {
  deleteWebhook,
  getWebhookInfo,
  setTelegramWebhook,
} from "./telegram";
import {
  fetchTelegramUpdates,
  getTelegramUpdateOffset,
  setTelegramUpdateOffset,
} from "./telegram-updates";

/** Gom chat nhóm/siêu nhóm từ getUpdates (Telegram không có API list-all). */

export type GroupChatRow = {
  id: number;
  type: string;
  title?: string;
  username?: string;
};

function chatFromMessageLike(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return undefined;
  return (msg as { chat?: unknown }).chat;
}

export function extractGroupChatsFromUpdates(results: unknown[]): Map<number, GroupChatRow> {
  const map = new Map<number, GroupChatRow>();
  const tryAdd = (chat: unknown) => {
    if (!chat || typeof chat !== "object") return;
    const c = chat as { id?: number; type?: string; title?: string; username?: string };
    const id = c.id;
    const type = c.type;
    if (typeof id !== "number" || (type !== "group" && type !== "supergroup")) return;
    if (!map.has(id)) {
      map.set(id, {
        id,
        type: type ?? "",
        title: c.title,
        username: c.username,
      });
    }
  };

  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as Record<string, unknown>;
    tryAdd(chatFromMessageLike(u.message));
    tryAdd(chatFromMessageLike(u.edited_message));
    tryAdd(chatFromMessageLike(u.channel_post));
    const cb = u.callback_query;
    if (cb && typeof cb === "object") {
      tryAdd(chatFromMessageLike((cb as { message?: unknown }).message));
    }
    const mcm = u.my_chat_member;
    if (mcm && typeof mcm === "object") tryAdd((mcm as { chat?: unknown }).chat);
    const cm = u.chat_member;
    if (cm && typeof cm === "object") tryAdd((cm as { chat?: unknown }).chat);
    const cjr = u.chat_join_request;
    if (cjr && typeof cjr === "object") tryAdd((cjr as { chat?: unknown }).chat);
  }
  return map;
}

/**
 * Quét getUpdates (tối đa ~30×100 bản ghi). Mỗi lần chạy sẽ ACK update → làm trống hàng đợi.
 * Không dùng chung lúc đã bật Webhook cho cùng bot (Telegram sẽ báo lỗi / conflict).
 */
export async function fetchAllGroupChatsFromTelegram(
  botToken: string,
  opts?: { store?: KVNamespace; persistOffset?: boolean }
): Promise<{
  chats: GroupChatRow[];
  rounds: number;
  updatesConsumed: number;
  warning?: string;
}> {
  const merged = new Map<number, GroupChatRow>();
  let offset = opts?.store && opts.persistOffset ? await getTelegramUpdateOffset(opts.store) : 0;
  let rounds = 0;
  let totalUpdates = 0;
  const maxRounds = 30;

  for (; rounds < maxRounds; rounds++) {
    const { updates: batch, nextOffset } = await fetchTelegramUpdates(botToken, offset, 100);
    if (batch.length === 0) break;

    totalUpdates += batch.length;
    offset = nextOffset;

    extractGroupChatsFromUpdates(batch).forEach((v, k) => merged.set(k, v));

    if (opts?.store && batch.length > 0) {
      const { mergeKnownGroupChats } = await import("./telegram-group-cache");
      await mergeKnownGroupChats(opts.store, extractGroupChatsFromUpdates(batch));
    }
  }

  if (opts?.store && totalUpdates > 0 && opts.persistOffset) {
    await setTelegramUpdateOffset(opts.store, offset);
  }

  const chats = [...merged.values()].sort((a, b) =>
    (a.title || String(a.id)).localeCompare(b.title || String(b.id), "vi", { sensitivity: "base" })
  );

  let warning: string | undefined;
  if (chats.length === 0) {
    warning =
      "Chưa thấy nhóm nào trong hàng đợi update. Gửi một tin trong mỗi nhóm (vd nhắn tên bot), hoặc xóa bot khỏi nhóm rồi thêm lại để có bản ghi my_chat_member.";
  }

  return { chats, rounds, updatesConsumed: totalUpdates, warning };
}

/**
 * Tạm gỡ webhook → quét getUpdates (kể cả update đang chờ) → bật lại webhook.
 * Dùng khi panel « Lấy Chat ID » không gọi được getUpdates (bot đang webhook).
 */
export async function fetchGroupChatsWithTemporaryWebhookOff(
  botToken: string,
  opts: {
    store?: KVNamespace;
    restoreWebhookUrl: string;
    secretToken?: string;
  },
): Promise<{
  chats: GroupChatRow[];
  rounds: number;
  updatesConsumed: number;
  warning?: string;
  webhookWasCleared: boolean;
}> {
  const info = await getWebhookInfo(botToken);
  const hadWebhook = Boolean(info.url?.trim());
  if (hadWebhook) {
    await deleteWebhook(botToken, false);
  }

  try {
    const scanned = await fetchAllGroupChatsFromTelegram(botToken, {
      store: opts.store,
      persistOffset: true,
    });
    return { ...scanned, webhookWasCleared: hadWebhook };
  } finally {
    const restore = opts.restoreWebhookUrl.trim() || info.url?.trim();
    if (restore) {
      await setTelegramWebhook(botToken, restore, opts.secretToken);
    }
  }
}
