/** Offset getUpdates dùng chung: cron poll + « Lấy Chat ID nhóm ». */

export const KV_TELEGRAM_UPDATE_OFFSET = "telegram:update_offset";

export async function getTelegramUpdateOffset(kv: KVNamespace): Promise<number> {
  const v = await kv.get(KV_TELEGRAM_UPDATE_OFFSET);
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function setTelegramUpdateOffset(kv: KVNamespace, offset: number): Promise<void> {
  await kv.put(KV_TELEGRAM_UPDATE_OFFSET, String(Math.max(0, offset)));
}

export async function fetchTelegramUpdates(
  botToken: string,
  offset: number,
  limit = 100
): Promise<{ updates: unknown[]; nextOffset: number }> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates?limit=${limit}&timeout=0&offset=${offset}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    ok?: boolean;
    result?: unknown[];
    description?: string;
    error_code?: number;
  };

  if (!data.ok) {
    const code = data.error_code;
    let msg = data.description || "getUpdates thất bại";
    if (code === 401 || /unauthorized/i.test(String(msg))) {
      throw new Error(
        "Telegram từ chối token (Unauthorized). Kiểm tra TELEGRAM_BOT_TOKEN trên Cloudflare."
      );
    }
    if (/webhook/i.test(String(msg)) || code === 409) {
      msg +=
        " Bot đang bật Webhook — gọi deleteWebhook cho token Black Corp - Thu Chi (blackcorp_bot), không phải bot baocao.";
    }
    throw new Error(msg);
  }

  const updates = data.result ?? [];
  let nextOffset = offset;
  for (const upd of updates) {
    const uid = (upd as { update_id?: number }).update_id;
    if (typeof uid === "number") nextOffset = uid + 1;
  }
  return { updates, nextOffset };
}
