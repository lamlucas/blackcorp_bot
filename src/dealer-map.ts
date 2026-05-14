const KV_KEY = "dealer_chat_map";

export async function getDealerChatMap(kv: KVNamespace | undefined): Promise<Record<string, string>> {
  if (!kv) return {};
  const raw = await kv.get(KV_KEY);
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

export async function setDealerChatMap(kv: KVNamespace | undefined, map: Record<string, string>): Promise<void> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace tên STORE. Cloudflare Dashboard → Worker → Settings → Bindings → Add → KV; hoặc chạy: wrangler kv namespace create STORE rồi chép id vào wrangler.toml [[kv_namespaces]] và deploy lại."
    );
  }
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

/**
 * Kiểm tra tên khách (cột D) tương ứng nhóm Telegram của tab:
 * — Nếu form « Đại lý » có khóa trùng D và Chat ID khác với nhóm tab → không gửi dòng này.
 * — Nếu không khai báo D trên form → coi như khớp nhóm tab (gửi theo B1/map tab).
 */
export function customerColumnDMatchesTabChat(
  customerColD: string,
  tabChatId: string | null,
  map: Record<string, string>
): boolean {
  const d = customerColD.trim();
  if (!d || !tabChatId) return false;
  const dChat = resolveChatId(d, null, map);
  if (dChat != null && dChat !== tabChatId) return false;
  return true;
}
