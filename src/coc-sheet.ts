import { parseMoneyNumber } from "./format";
import { sheetsPutValues, sheetsValuesAppend, sheetsValuesClear } from "./google";
import { batchGetValues } from "./worker-lib";
import type { ThuChiMultilineCmd } from "./thu-chi-multiline";

/** Tab tiền cọc — panel web đọc/ghi A:E. */
export const COC_TAB_NAME = "COC";
const COC_MAX_ROW = 2000;
const COC_COLS = 5;

export const THU_CHI_TAB_NAME = "THU_CHI";

/** Note cột E → ghi tab COC (không phân biệt hoa thường). */
export const COC_NOTE_KEYWORDS = ["thẳng", "tạ an", "mmo"] as const;

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function normalizeNoteKey(note: string): string {
  return String(note ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeCocTenKey(ten: string): string {
  return String(ten ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseVietnamDateCell(s: string): { y: number; m: number; d: number } | null {
  const t = String(s ?? "").trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  return { y, m: mo, d };
}

function vietnamDateKey(p: { y: number; m: number; d: number }): number {
  return p.y * 10000 + p.m * 100 + p.d;
}

function dateKeyFromCell(ngay: string): number {
  const p = parseVietnamDateCell(ngay);
  return p ? vietnamDateKey(p) : 0;
}

export function isCocNote(note: string): boolean {
  const n = normalizeNoteKey(note);
  if (!n) return false;
  return COC_NOTE_KEYWORDS.some((k) => k === n);
}

/** COC: A ngày | B Thu | C Chi | D Tên | E Note. */
export function buildCocRowValues(payload: CocRowPayload): (string | number)[] {
  const thuN = parseMoneyNumber(String(payload.thu ?? ""));
  const chiN = parseMoneyNumber(String(payload.chi ?? ""));
  return [
    String(payload.ngay ?? "").trim(),
    thuN > 0 ? thuN : "",
    chiN > 0 ? chiN : "",
    String(payload.ten ?? "").trim(),
    String(payload.note ?? "").trim(),
  ];
}

export type CocSheetRow = {
  sheetRow1Based: number;
  ngay: string;
  thu: number;
  chi: number;
  ten: string;
  note: string;
};

export type CocRowPayload = {
  ngay: string;
  thu: string | number;
  chi: string | number;
  ten: string;
  note: string;
};

/** Một dòng cần ghi đè trên Sheet — bắt buộc có số dòng (1-based). */
export type CocRowPatch = CocRowPayload & {
  sheetRow: number;
};

function padCocRow(raw: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < COC_COLS; i++) out.push(String(raw[i] ?? ""));
  return out;
}

/** Đọc dòng 2+ tab COC (A:E) — A Ngày, B Thu, C Chi, D Tên, E Note. */
export async function readCocSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string = COC_TAB_NAME,
): Promise<CocSheetRow[]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:E${COC_MAX_ROW}`]);
  const rawRows = parts[0] ?? [];
  const out: CocSheetRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const cells = padCocRow(rawRows[i]);
    const ngay = cells[0].trim();
    const thu = parseMoneyNumber(cells[1]);
    const chi = parseMoneyNumber(cells[2]);
    let ten = cells[3].trim();
    let note = cells[4].trim();
    const rawLen = rawRows[i]?.length ?? 0;
    if (note === "" && ten !== "" && rawLen < 5) {
      note = ten;
      ten = "";
    }
    if (!ngay && !ten && !note && thu === 0 && chi === 0) continue;
    out.push({
      sheetRow1Based: i + 2,
      ngay,
      thu,
      chi,
      ten,
      note,
    });
  }
  return out;
}

/** Ghi đè từng dòng A:E theo số dòng Sheet — không xóa vùng khác. */
export async function patchCocDataRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  rows: CocRowPatch[],
): Promise<number> {
  const q = quoteSheet(tabName);
  let written = 0;
  for (const row of rows) {
    const sheetRow = Math.trunc(Number(row.sheetRow));
    if (!Number.isFinite(sheetRow) || sheetRow < 2 || sheetRow > COC_MAX_ROW) continue;
    const range = `${q}!A${sheetRow}:E${sheetRow}`;
    await sheetsPutValues(accessToken, spreadsheetId, range, [buildCocRowValues(row)], "USER_ENTERED");
    written++;
  }
  return written;
}

export async function appendCocDataRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  rows: CocRowPayload[],
): Promise<number> {
  if (!rows.length) return 0;
  const q = quoteSheet(tabName);
  const values = rows.map((r) => buildCocRowValues(r));
  await sheetsValuesAppend(accessToken, spreadsheetId, `${q}!A:E`, values, "USER_ENTERED");
  return rows.length;
}

/** Dòng trống kế tiếp sau dữ liệu hiện có (panel thêm dòng mới). */
export async function findNextEmptyCocRowNumbers(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  const existing = await readCocSheetRows(accessToken, spreadsheetId, tabName);
  let lastOccupied = 1;
  for (const r of existing) {
    lastOccupied = Math.max(lastOccupied, r.sheetRow1Based);
  }
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:E${COC_MAX_ROW}`]);
  const rawLen = parts[0]?.length ?? 0;
  let start = Math.max(lastOccupied + 1, rawLen + 2);
  const out: number[] = [];
  for (let r = start; r <= COC_MAX_ROW && out.length < count; r++) {
    out.push(r);
  }
  if (out.length < count) {
    throw new Error("Tab COC đã đầy — không còn dòng trống để thêm.");
  }
  return out;
}

/** Ghi dòng mới vào các dòng trống kế tiếp (không append cuối bảng nếu có khoảng trống). */
export async function insertCocRowsAtNextEmpty(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  rows: CocRowPayload[],
): Promise<number> {
  if (!rows.length) return 0;
  const targets = await findNextEmptyCocRowNumbers(accessToken, spreadsheetId, tabName, rows.length);
  const patches: CocRowPatch[] = rows.map((row, i) => ({
    sheetRow: targets[i]!,
    ...row,
  }));
  return patchCocDataRows(accessToken, spreadsheetId, tabName, patches);
}

/** Xóa nội dung các dòng (không xóa hết tab). */
export async function clearCocSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  sheetRows: number[],
): Promise<number> {
  const q = quoteSheet(tabName);
  let cleared = 0;
  for (const raw of sheetRows) {
    const sheetRow = Math.trunc(Number(raw));
    if (!Number.isFinite(sheetRow) || sheetRow < 2 || sheetRow > COC_MAX_ROW) continue;
    await sheetsValuesClear(accessToken, spreadsheetId, `${q}!A${sheetRow}:E${sheetRow}`);
    cleared++;
  }
  return cleared;
}

export type CocPanelSaveInput = {
  patches?: CocRowPatch[];
  appends?: CocRowPayload[];
  deletedRows?: number[];
};

/** Panel web — chỉ ghi dòng sửa/thêm/xóa, không đụng dòng khác. */
export async function applyCocPanelChanges(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  input: CocPanelSaveInput,
): Promise<{ patched: number; appended: number; cleared: number }> {
  const patches = input.patches ?? [];
  const appends = input.appends ?? [];
  const deletedRows = input.deletedRows ?? [];
  const patched = await patchCocDataRows(accessToken, spreadsheetId, tabName, patches);
  const appended = appends.length
    ? await insertCocRowsAtNextEmpty(accessToken, spreadsheetId, tabName, appends)
    : 0;
  const cleared = await clearCocSheetRows(accessToken, spreadsheetId, tabName, deletedRows);
  return { patched, appended, cleared };
}

/**
 * Bot Thu/Chi → tab COC khi Note là Thẳng/Tạ An/MMO.
 * Cùng tên cột D (không phân biệt hoa thường): cộng dồn Thu/Chi, giữ ngày mới nhất, xóa dòng cũ.
 */
export async function upsertCocFromThuChi(
  accessToken: string,
  spreadsheetId: string,
  cmd: ThuChiMultilineCmd,
  ngay: string,
  tabName: string = COC_TAB_NAME,
): Promise<void> {
  const rows = await readCocSheetRows(accessToken, spreadsheetId, tabName);
  const tenKey = normalizeCocTenKey(cmd.ten);
  const matching = rows.filter((r) => normalizeCocTenKey(r.ten) === tenKey);

  const addThu = cmd.kind === "THU" ? cmd.amount : 0;
  const addChi = cmd.kind === "CHI" ? cmd.amount : 0;

  let totalThu = addThu;
  let totalChi = addChi;
  let bestNgay = ngay;
  let bestKey = dateKeyFromCell(ngay);

  for (const r of matching) {
    totalThu += r.thu;
    totalChi += r.chi;
    const key = dateKeyFromCell(r.ngay);
    if (key >= bestKey) {
      bestKey = key;
      bestNgay = r.ngay || ngay;
    }
  }

  const merged: CocRowPayload = {
    ngay: bestKey === dateKeyFromCell(ngay) ? ngay : bestNgay,
    thu: totalThu > 0 ? totalThu : "",
    chi: totalChi > 0 ? totalChi : "",
    ten: cmd.ten.trim(),
    note: cmd.note,
  };

  if (matching.length === 0) {
    await appendCocDataRows(accessToken, spreadsheetId, tabName, [merged]);
    return;
  }

  let target = matching[0]!;
  let targetKey = dateKeyFromCell(target.ngay);
  for (const r of matching) {
    const key = dateKeyFromCell(r.ngay);
    if (key > targetKey || (key === targetKey && r.sheetRow1Based < target.sheetRow1Based)) {
      target = r;
      targetKey = key;
    }
  }

  await patchCocDataRows(accessToken, spreadsheetId, tabName, [
    { sheetRow: target.sheetRow1Based, ...merged },
  ]);

  const toClear = matching
    .filter((r) => r.sheetRow1Based !== target.sheetRow1Based)
    .map((r) => r.sheetRow1Based);
  if (toClear.length) {
    await clearCocSheetRows(accessToken, spreadsheetId, tabName, toClear);
  }
}
