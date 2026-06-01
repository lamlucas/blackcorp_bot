import { extractGroupChatsFromUpdates, type GroupChatRow } from "./telegram-chats";
import { tgApi } from "./telegram";

const KV_KNOWN_GROUPS = "telegram:known_group_chats";

export async function getKnownGroupChats(kv: KVNamespace | undefined): Promise<GroupChatRow[]> {
  if (!kv) return [];
  const raw = await kv.get(KV_KNOWN_GROUPS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as GroupChatRow[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function mergeKnownGroupChats(
  kv: KVNamespace | undefined,
  incoming: Map<number, GroupChatRow>,
): Promise<void> {
  if (!kv || incoming.size === 0) return;
  const byId = new Map<number, GroupChatRow>();
  for (const c of await getKnownGroupChats(kv)) byId.set(c.id, c);
  incoming.forEach((v, k) => byId.set(k, v));
  const sorted = [...byId.values()].sort((a, b) =>
    (a.title || String(a.id)).localeCompare(b.title || String(b.id), "vi", { sensitivity: "base" }),
  );
  await kv.put(KV_KNOWN_GROUPS, JSON.stringify(sorted));
}

/** Ghi nhớ nhóm từ webhook/getUpdates (không xử lý Thu/Chi). */
export async function recordGroupChatsFromUpdates(
  kv: KVNamespace | undefined,
  updates: unknown[],
): Promise<void> {
  if (!kv || updates.length === 0) return;
  await mergeKnownGroupChats(kv, extractGroupChatsFromUpdates(updates));
}

/** Ghi nhớ một nhóm qua getChat (sau Thu/Chi hoặc khi chỉ có chat_id). */
export async function rememberGroupChatById(
  kv: KVNamespace | undefined,
  botToken: string,
  chatId: string,
): Promise<void> {
  if (!kv || !botToken.trim() || !chatId.trim()) return;
  const id = Number(chatId);
  if (!Number.isFinite(id) || id >= 0) return;
  try {
    const chat = await tgApi<{
      id: number;
      type: string;
      title?: string;
      username?: string;
    }>(botToken, "getChat", { chat_id: chatId });
    const type = chat.type ?? "";
    if (type !== "group" && type !== "supergroup") return;
    const row: GroupChatRow = {
      id: chat.id,
      type,
      title: chat.title,
      username: chat.username,
    };
    await mergeKnownGroupChats(kv, new Map([[row.id, row]]));
  } catch {
    await mergeKnownGroupChats(kv, new Map([[id, { id, type: "supergroup" }]]));
  }
}
