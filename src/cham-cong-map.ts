const KV_KEY = "cham_cong_employee_map";

/** Tên hiển thị Telegram → tên tab Sheet (vd Subeo → SU_BEO). */
export async function getChamCongEmployeeMap(
  kv: KVNamespace | undefined,
): Promise<Record<string, string>> {
  if (!kv) return defaultEmployeeMap();
  const raw = await kv.get(KV_KEY);
  if (!raw) return defaultEmployeeMap();
  try {
    const o = JSON.parse(raw) as Record<string, string>;
    if (!o || typeof o !== "object") return defaultEmployeeMap();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      const name = String(k ?? "").trim();
      const tab = String(v ?? "").trim();
      if (name && tab) out[name] = tab;
    }
    return out;
  } catch {
    return defaultEmployeeMap();
  }
}

function defaultEmployeeMap(): Record<string, string> {
  return { Subeo: "SU_BEO" };
}

export async function setChamCongEmployeeMap(
  kv: KVNamespace | undefined,
  map: Record<string, string>,
): Promise<void> {
  if (!kv) {
    throw new Error(
      "Chưa gắn KV namespace STORE — không thể lưu nhân viên chấm công.",
    );
  }
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const name = String(k ?? "").trim();
    const tab = String(v ?? "").trim();
    if (name && tab) cleaned[name] = tab;
  }
  await kv.put(KV_KEY, JSON.stringify(cleaned));
}

export async function addChamCongEmployee(
  kv: KVNamespace | undefined,
  telegramName: string,
  tabName: string,
): Promise<Record<string, string>> {
  const map = await getChamCongEmployeeMap(kv);
  map[telegramName.trim()] = tabName.trim();
  await setChamCongEmployeeMap(kv, map);
  return map;
}

/** Xóa nhân viên theo tên tab Sheet — trả tên Telegram đã xóa (nếu có). */
export async function removeChamCongEmployeeByTab(
  kv: KVNamespace | undefined,
  tabName: string,
): Promise<{ map: Record<string, string>; telegramName: string | null }> {
  const tab = tabName.trim();
  if (!tab) throw new Error("Thiếu tên tab.");
  const map = await getChamCongEmployeeMap(kv);
  let telegramName: string | null = null;
  for (const [k, v] of Object.entries(map)) {
    if (String(v ?? "").trim() === tab) {
      telegramName = k;
      delete map[k];
      break;
    }
  }
  await setChamCongEmployeeMap(kv, map);
  return { map, telegramName };
}

/** Khớp tên Telegram không phân biệt hoa thường. */
export function resolveTabForTelegramName(
  displayName: string,
  map: Record<string, string>,
): string | null {
  const d = displayName.trim();
  if (!d) return null;
  const exact = map[d];
  if (exact?.trim()) return exact.trim();
  const low = d.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    const kt = String(k ?? "").trim();
    if (!kt || !String(v ?? "").trim()) continue;
    if (kt.toLowerCase() === low) return String(v).trim();
  }
  return null;
}

/** Tên tab hợp lệ từ tên nhân viên (BLACK, SU_BEO). */
export function suggestTabName(employeeName: string): string {
  return String(employeeName ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .toUpperCase();
}
