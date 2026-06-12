const KV_KEY = "mail_list";

export function parseMailListText(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const email = line.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export async function getMailList(kv: KVNamespace | undefined): Promise<string[]> {
  if (!kv) return [];
  const raw = await kv.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const email = String(item ?? "").trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
    return out;
  } catch {
    return [];
  }
}

export async function setMailList(kv: KVNamespace | undefined, emails: string[]): Promise<string[]> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace STORE — không thể lưu danh sách email.",
    );
  }
  const cleaned = parseMailListText(emails.join("\n"));
  await kv.put(KV_KEY, JSON.stringify(cleaned));
  return cleaned;
}

export async function clearMailList(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace STORE — không thể xóa danh sách email.",
    );
  }
  await kv.delete(KV_KEY);
}

export function formatMailListForTelegram(emails: string[]): string {
  if (!emails.length) {
    return "Chưa có email nào trên panel.";
  }
  return ["Danh sách email:", ...emails.map((e, i) => `${i + 1}. ${e}`)].join("\n");
}
