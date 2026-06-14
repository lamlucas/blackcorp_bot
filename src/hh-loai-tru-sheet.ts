import { sheetsValuesAppend } from "./google";

export const HH_LOAI_TRU_TAB = "HH_LOAI_TRU";

/** Note cột E THU_CHI → ghi thêm tab HH_LOAI_TRU (không phân biệt hoa thường). */
export const HH_LOAI_TRU_NOTE_KEYWORDS = [
  "ứng",
  "bank",
  "rf",
  "mượn",
  "trả",
  "lỗ",
] as const;

function normalizeNoteKey(note: string): string {
  return String(note ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isHhLoaiTruNote(note: string): boolean {
  const n = normalizeNoteKey(note);
  if (!n) return false;
  return HH_LOAI_TRU_NOTE_KEYWORDS.some((k) => k === n);
}

export function isUngNote(note: string): boolean {
  return normalizeNoteKey(note) === "ứng";
}

export type HhLoaiTruAppendInput = {
  ngay: string;
  kind: "THU" | "CHI";
  amount: number;
  ten: string;
  note: string;
};

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** HH_LOAI_TRU: A ngày | B Khoản Thu | C Khoản Chi | D Tên | E Note. */
export function buildHhLoaiTruAppendRow(input: HhLoaiTruAppendInput): (string | number)[] {
  const thu = input.kind === "THU" ? input.amount : "";
  const chi = input.kind === "CHI" ? input.amount : "";
  return [input.ngay, thu, chi, input.ten, input.note];
}

export async function appendHhLoaiTruRow(
  accessToken: string,
  spreadsheetId: string,
  input: HhLoaiTruAppendInput,
): Promise<void> {
  const q = `${quoteSheet(HH_LOAI_TRU_TAB)}!A:E`;
  const row = buildHhLoaiTruAppendRow(input);
  await sheetsValuesAppend(accessToken, spreadsheetId, q, [row], "USER_ENTERED");
}
