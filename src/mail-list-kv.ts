const KV_KEY = "mail_list";

export type MailListGroupKey = "admin" | "chuan" | "readonly";

export type MailListGroups = Record<MailListGroupKey, string[]>;

export const MAIL_GROUP_ORDER: MailListGroupKey[] = ["admin", "chuan", "readonly"];

export const MAIL_GROUP_LABELS: Record<MailListGroupKey, string> = {
  admin: "Mail Admin",
  chuan: "Mail Chuẩn",
  readonly: "Mail chỉ đọc",
};

const EMPTY_GROUPS = (): MailListGroups => ({
  admin: [],
  chuan: [],
  readonly: [],
});

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

function normalizeMailListGroups(raw: unknown): MailListGroups {
  if (Array.isArray(raw)) {
    return { ...EMPTY_GROUPS(), admin: parseMailListText(raw.map(String).join("\n")) };
  }
  if (!raw || typeof raw !== "object") return EMPTY_GROUPS();
  const o = raw as Record<string, unknown>;
  const out = EMPTY_GROUPS();
  for (const key of MAIL_GROUP_ORDER) {
    const v = o[key];
    if (Array.isArray(v)) {
      out[key] = parseMailListText(v.map(String).join("\n"));
    } else if (typeof v === "string") {
      out[key] = parseMailListText(v);
    }
  }
  return out;
}

export function groupsToTextFields(groups: MailListGroups): Record<MailListGroupKey, string> {
  return {
    admin: groups.admin.join("\n"),
    chuan: groups.chuan.join("\n"),
    readonly: groups.readonly.join("\n"),
  };
}

export async function getMailListGroups(kv: KVNamespace | undefined): Promise<MailListGroups> {
  if (!kv) return EMPTY_GROUPS();
  const raw = await kv.get(KV_KEY);
  if (!raw) return EMPTY_GROUPS();
  try {
    return normalizeMailListGroups(JSON.parse(raw));
  } catch {
    return EMPTY_GROUPS();
  }
}

export async function setMailListGroups(
  kv: KVNamespace | undefined,
  input: Partial<Record<MailListGroupKey, string>>,
): Promise<MailListGroups> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace STORE — không thể lưu danh sách email.",
    );
  }
  const groups = EMPTY_GROUPS();
  for (const key of MAIL_GROUP_ORDER) {
    groups[key] = parseMailListText(String(input[key] ?? ""));
  }
  await kv.put(KV_KEY, JSON.stringify(groups));
  return groups;
}

export async function clearMailList(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace STORE — không thể xóa danh sách email.",
    );
  }
  await kv.delete(KV_KEY);
}

export function hasAnyMail(groups: MailListGroups): boolean {
  return MAIL_GROUP_ORDER.some((key) => groups[key].length > 0);
}

/** Chỉ format nhóm có mail — trả null nếu cả 3 ô trống. */
export function formatMailListForTelegram(groups: MailListGroups): string | null {
  const blocks: string[] = [];
  for (const key of MAIL_GROUP_ORDER) {
    const emails = groups[key];
    if (!emails.length) continue;
    const lines = emails.map((e, i) => `${i + 1}. ${e}`);
    blocks.push(`${MAIL_GROUP_LABELS[key]}:\n${lines.join("\n")}`);
  }
  if (!blocks.length) return null;
  return blocks.join("\n\n");
}

export const MAIL_LIST_EMPTY_REPLY = "Chưa có mail nào.";
