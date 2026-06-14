import {
  computeCongNoAfterThuChi,
  formatMoneyForThanhToanLine,
  getCongNoColumnBForCustomerD,
  getVietnamDateKeyNow,
  parseMoneyNumber,
  resolveCongNoMaDlKeyByCustomerName,
  resolveCongNoMaDlKeyForCustomerD,
} from "./format";
import { sheetsBatchUpdate, sheetsGet, sheetsPutValues, type SheetGrid } from "./google";
import { batchGetValues, getDebtMap } from "./worker-lib";

const DEBT_SHEET_MAX_ROW = 500;

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

function findRowIndexForMaDl(
  rows: string[][],
  maDl: string,
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
  tabName: string,
): Promise<string[][]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [
    `${q}!A2:C${DEBT_SHEET_MAX_ROW}`,
  ]);
  return parts[0] ?? [];
}

function findCongNoRowByMaDl(
  rows: string[][],
  maDl: string,
): { matchRow1Based: number | null; lastFilledRow1Based: number; cells: string[] } {
  const keyLow = maDl.trim().toLowerCase();
  let matchRow1Based: number | null = null;
  let lastFilledRow1Based = 1;
  let matchCells: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const a = String(cells[0] ?? "").trim();
    const rowNum = i + 2;
    if (a) lastFilledRow1Based = rowNum;
    if (a && a.toLowerCase() === keyLow) {
      matchRow1Based = rowNum;
      matchCells = cells;
    }
  }
  return { matchRow1Based, lastFilledRow1Based, cells: matchCells };
}

async function getSheetIdByTitle(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<number | null> {
  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
  );
  for (const s of grid.sheets ?? []) {
    if (s.properties?.title === title && s.properties.sheetId != null) {
      return s.properties.sheetId;
    }
  }
  return null;
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
  debtDisplay: string,
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

/** Xóa cả dòng A:B khi A khớp mã đại lý (không phân biệt hoa thường). */
export async function deleteCongNoRowByMaDl(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  maDl: string,
): Promise<boolean> {
  const key = maDl.trim();
  if (!key) return false;

  const rows = await readCongNoRows(accessToken, spreadsheetId, tabName);
  const { matchRow1Based } = findRowIndexForMaDl(rows, key);
  if (matchRow1Based == null) return false;

  const sheetId = await getSheetIdByTitle(accessToken, spreadsheetId, tabName);
  if (sheetId == null) return false;

  const startIndex = matchRow1Based - 1;
  await sheetsBatchUpdate(accessToken, spreadsheetId, [
    {
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex,
          endIndex: startIndex + 1,
        },
      },
    },
  ]);
  return true;
}

/** Xóa giá trị cột B (nợ) khi A khớp mã đại lý. */
export async function clearCongNoDebtColumnB(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  maDl: string,
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

/**
 * Lệnh Thu (THU_CHI cột D) → trừ nợ tab CONG_NO (A khớp D qua getCongNoColumnBForCustomerD).
 * Trả đủ (remaining < 1) → xóa cả dòng; còn nợ ≥ 1 → ghi B mới.
 */
export async function applyCongNoAfterThuPayment(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  customerNameColD: string,
  paymentAmount: number,
): Promise<boolean> {
  const debtMap = await getDebtMap(accessToken, spreadsheetId, tabName);
  const maDlKey = resolveCongNoMaDlKeyForCustomerD(debtMap, customerNameColD);
  if (!maDlKey) return false;

  const bStr = getCongNoColumnBForCustomerD(debtMap, customerNameColD);
  const action = computeCongNoAfterThuChi(bStr, paymentAmount);
  if (!action) return false;

  if (action.action === "deleteRow") {
    return deleteCongNoRowByMaDl(accessToken, spreadsheetId, tabName, maDlKey);
  }

  await upsertCongNoDebt(accessToken, spreadsheetId, tabName, maDlKey, action.display);
  return true;
}

/**
 * Gửi chi phí — cộng dồn cột I (TỔNG THU) vào nợ cột B khi A khớp tên khách cột D.
 * Chỉ cập nhật nếu đã có dòng CONG_NO (cột A khớp).
 */
export async function accumulateCongNoDebtFromExpense(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  customerNameColD: string,
  expenseAmount: number,
): Promise<{ updated: boolean; maDlKey?: string; newDebtDisplay?: string }> {
  if (!Number.isFinite(expenseAmount) || expenseAmount <= 0) {
    return { updated: false };
  }

  const debtMap = await getDebtMap(accessToken, spreadsheetId, tabName);
  const maDlKey = resolveCongNoMaDlKeyByCustomerName(debtMap, customerNameColD);
  if (!maDlKey) return { updated: false };

  const bStr = getCongNoColumnBForCustomerD(debtMap, customerNameColD);
  const current = bStr != null ? parseMoneyNumber(bStr) : 0;
  const newTotal = Math.round((current + expenseAmount) * 100) / 100;
  const newDebtDisplay = formatMoneyForThanhToanLine(newTotal);

  await upsertCongNoDebt(accessToken, spreadsheetId, tabName, maDlKey, newDebtDisplay);
  return { updated: true, maDlKey, newDebtDisplay };
}

/**
 * KV: ngày rollover cột C gần nhất (giờ Việt Nam).
 */
export function congNoColumnCRolloverKvKey(spreadsheetId: string, tabName: string): string {
  return `congno:cvnday:${spreadsheetId}:${tabName.trim()}`;
}

/**
 * Sang ngày mới (giờ Việt Nam): ghi cột C = cột B cho mọi dòng có cột A (một lần/ngày, KV).
 * Trả true nếu vừa rollover.
 */
export async function rolloverCongNoColumnCForNewVietnamDay(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  store: KVNamespace,
): Promise<boolean> {
  const todayKey = getVietnamDateKeyNow();
  const kvKey = congNoColumnCRolloverKvKey(spreadsheetId, tabName);
  const lastKey = await store.get(kvKey);
  if (lastKey === todayKey) return false;

  const rows = await readCongNoRows(accessToken, spreadsheetId, tabName);
  const q = quoteSheet(tabName);

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const a = String(cells[0] ?? "").trim();
    if (!a) continue;

    const rowNum = i + 2;
    const bNum = parseMoneyNumber(String(cells[1] ?? ""));
    const cDisplay = bNum > 0 ? formatMoneyForThanhToanLine(bNum) : "";
    await sheetsPutValues(accessToken, spreadsheetId, `${q}!C${rowNum}`, [[cDisplay]]);
  }

  await store.put(kvKey, todayKey);
  return true;
}

/**
 * Nợ đầu ngày cột C — sau rollover ngày mới (VN) thì C = snapshot B; cùng ngày giữ nguyên C.
 */
export async function ensureCongNoOpeningDebtColumnC(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  customerNameColD: string,
  store: KVNamespace,
): Promise<{ maDlKey: string; openingC: number } | null> {
  await rolloverCongNoColumnCForNewVietnamDay(accessToken, spreadsheetId, tabName, store);

  const debtMap = await getDebtMap(accessToken, spreadsheetId, tabName);
  const maDlKey = resolveCongNoMaDlKeyByCustomerName(debtMap, customerNameColD);
  if (!maDlKey) return null;

  const rows = await readCongNoRows(accessToken, spreadsheetId, tabName);
  const { matchRow1Based, cells } = findCongNoRowByMaDl(rows, maDlKey);
  if (matchRow1Based == null) return null;

  const cNum = parseMoneyNumber(String(cells[2] ?? ""));
  return { maDlKey, openingC: cNum > 0 ? cNum : 0 };
}

/** Sau TỔNG TIỀN: ghi tổng nợ mới vào cột B (Σ cột I + nợ đầu ngày C). */
export async function setCongNoDebtColumnBTotal(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  maDlKey: string,
  totalAmount: number,
): Promise<void> {
  if (!Number.isFinite(totalAmount) || totalAmount < 0) return;
  await upsertCongNoDebt(
    accessToken,
    spreadsheetId,
    tabName,
    maDlKey,
    formatMoneyForThanhToanLine(totalAmount),
  );
}
