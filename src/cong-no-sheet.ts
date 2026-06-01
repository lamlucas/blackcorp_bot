import { sheetsPutValues } from "./google";
import { batchGetValues } from "./worker-lib";

const DEBT_SHEET_MAX_ROW = 500;

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

function findRowIndexForMaDl(
  rows: string[][],
  maDl: string
): { matchRow1Based: number | null; lastFilledRow1Based: number } {
  const keyLow = maDl.trim().toLowerCase();
  let matchRow1Based: number | null = null;
  let lastFilledRow1Based = 1;
  for (let i = 0; i < rows.length; i++) {
    const a = String(rows[i][0] ?? "").trim();
    const rowNum = i + 2;
    if (a) lastFilledRow1Based = rowNum;
    if (a && a.toLowerCase() === keyLow) matchRow1Based = rowNum;
  }
  return { matchRow1Based, lastFilledRow1Based };
}

async function readCongNoRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string
): Promise<string[][]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [
    `${q}!A2:B${DEBT_SHEET_MAX_ROW}`,
  ]);
  return parts[0] ?? [];
}

/**
 * Cột A = mã đại lý; cột B = nợ.
 * Đã có A trùng (không phân biệt hoa thường) → chỉ sửa B; chưa có → thêm dòng mới sau dòng cuối có A.
 */
export async function upsertCongNoDebt(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  maDl: string,
  debtDisplay: string
): Promise<void> {
  const key = maDl.trim();
  if (!key) return;

  const rows = await readCongNoRows(accessToken, spreadsheetId, tabName);
  const { matchRow1Based, lastFilledRow1Based } = findRowIndexForMaDl(rows, key);
  const q = quoteSheet(tabName);

  if (matchRow1Based != null) {
    await sheetsPutValues(accessToken, spreadsheetId, `${q}!B${matchRow1Based}`, [[debtDisplay]]);
    return;
  }

  const newRow = lastFilledRow1Based < 2 ? 2 : lastFilledRow1Based + 1;
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!A${newRow}:B${newRow}`, [[key, debtDisplay]]);
}

/** Xóa giá trị cột B (nợ) khi A khớp mã đại lý. */
export async function clearCongNoDebtColumnB(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  maDl: string
): Promise<boolean> {
  const key = maDl.trim();
  if (!key) return false;

  const rows = await readCongNoRows(accessToken, spreadsheetId, tabName);
  const { matchRow1Based } = findRowIndexForMaDl(rows, key);
  if (matchRow1Based == null) return false;

  const q = quoteSheet(tabName);
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!B${matchRow1Based}`, [[""]]);
  return true;
}
