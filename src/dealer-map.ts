const KV_KEY = "dealer_chat_map";

/** Chuẩn hóa tên đại lý / cột D — bỏ NBSP, gộp khoảng trắng (Sheet hay dính ký tự ẩn). */
export function normalizeDealerNameKey(name: string): string {
  return String(name ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

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
 * Chat ID nhóm cho một dòng chi phí: tên cột D (tên khách) phải trùng tên đại lý đã lưu form « Đại lý & Chat ID ».
 * Khớp khóa sau trim; không có thì thử không phân biệt hoa thường. Không dùng B1 tab — chỉ map KV.
 */
export function resolveChatIdForCustomerNameColumnD(
  customerColD: string,
  map: Record<string, string>
): string | null {
  const d = normalizeDealerNameKey(customerColD);
  if (!d) return null;
  const exact = resolveChatId(d, null, map);
  if (exact) return exact;
  const low = d.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    const kt = normalizeDealerNameKey(k);
    if (!kt || String(v ?? "").trim() === "") continue;
    if (kt.toLowerCase() === low) return String(v).trim();
  }
  return null;
}

/** Ngược map KV: Chat ID nhóm → tên đại lý / mã ĐL (cột D, cột A CONG_NO). */
export function resolveDealerNameForChatId(
  chatId: string,
  map: Record<string, string>
): string | null {
  const cid = String(chatId ?? "").trim();
  if (!cid) return null;
  for (const [name, id] of Object.entries(map)) {
    if (String(id ?? "").trim() === cid) {
      const n = String(name ?? "").trim();
      if (n) return n;
    }
  }
  return null;
}
