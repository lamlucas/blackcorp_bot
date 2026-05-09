const KV_KEY = "dealer_chat_map";

export async function getDealerChatMap(kv: KVNamespace): Promise<Record<string, string>> {
  const raw = await kv.get(KV_KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

export async function setDealerChatMap(kv: KVNamespace, map: Record<string, string>): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(map));
}

/** Ưu tiên map từ web; không có thì dùng chat_id đọc từ ô B1 tab Sheet */
export function resolveChatId(
  sheetTitle: string,
  sheetB1ChatId: string | null,
  map: Record<string, string>
): string | null {
  const key = sheetTitle.trim();
  const fromMap = map[key];
  if (fromMap != null && String(fromMap).trim() !== "") {
    return String(fromMap).trim();
  }
  return sheetB1ChatId && sheetB1ChatId.trim() !== "" ? sheetB1ChatId.trim() : null;
}
