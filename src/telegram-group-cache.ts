import { extractGroupChatsFromUpdates, type GroupChatRow } from "./telegram-chats";

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
