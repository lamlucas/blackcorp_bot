import { formatMoneyForThanhToanLine, parseMoneyNumber } from "./format";
import { batchGetValues } from "./worker-lib";

export const BAO_CAO_TK_TAB_NAME = "BAO_CAO_TK";

const MAX_ROW = 500;
const COL_COUNT = 13;

/** Cột tab BAO_CAO_TK (hàng 1 tiêu đề). */
export const BAO_CAO_COL = {
  NGAY: 0,
  MCC: 1,
  TAI_KHOAN: 2,
  TEN_KHACH: 3,
  RATE: 4,
  TONG_TIEU: 5,
  TIEN_TE: 6,
  QUY_DOI_USD: 7,
  /** Cột I — TỔNG THU */
  TONG_THU: 8,
  /** Cột J — bot ghi trạng thái gửi: Done / Error */
  NOTE: 9,
  /** Chữ cột J (ghi NOTE) */
  NOTE_COL_LETTER: "J",
  LINK_FILE: 12,
} as const;

/** Giá trị cột I (TỔNG THU) — bỏ qua nếu từng ghi nhầm Done/Error vào cột I. */
export function readBaoCaoTongThuCell(row: string[]): string {
  const raw = String(row[BAO_CAO_COL.TONG_THU] ?? "").trim();
  const low = raw.toLowerCase();
  if (low === "done" || low === "error") return "";
  return raw;
}

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function padRow(raw: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < COL_COUNT; i++) out.push(String(raw[i] ?? ""));
  return out;
}

export function normalizePanelDateKey(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

type DateParts = { y: number; m: number; d: number };

function datePartsKey(p: DateParts): string {
  return `${p.y}-${p.m}-${p.d}`;
}

/** Google Sheets serial (ô ngày lưu dạng số) → ngày lịch. */
function googleSerialToDateParts(serial: number): DateParts | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const epochMs = Date.UTC(1899, 11, 30);
  const d = new Date(epochMs + Math.round(serial) * 86400000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  return { y, m, d: day };
}

/**
 * Parse ngày từ panel hoặc cột A Sheet: dd/mm/yyyy, serial Sheets, yyyy-mm-dd, m/d/yyyy (US).
 */
export function parseSheetNgayCell(raw: string): DateParts | null {
  const t = normalizePanelDateKey(String(raw ?? ""));
  if (!t) return null;

  const compact = t.replace(/,/g, "");
  if (/^\d+(\.\d+)?$/.test(compact)) {
    const serial = Math.floor(Number(compact));
    if (serial >= 30000 && serial <= 120000) {
      const fromSerial = googleSerialToDateParts(serial);
      if (fromSerial) return fromSerial;
    }
  }

  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y, m, d };
  }

  const slash = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (slash) {
    const n1 = Number(slash[1]);
    const n2 = Number(slash[2]);
    let y = Number(slash[3]);
    if (y < 100) y += 2000;
    let day: number;
    let month: number;
    if (n1 > 12) {
      day = n1;
      month = n2;
    } else if (n2 > 12) {
      month = n1;
      day = n2;
    } else {
      day = n1;
      month = n2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { y, m: month, d: day };
  }

  return parseFlexibleDateParts(t);
}

/** dd/mm/yyyy, d/m/yy — không parse dạng 13-14/5 (phải khớp chuỗi đúng). */
export function parseFlexibleDateParts(s: string): DateParts | null {
  const t = normalizePanelDateKey(s);
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const month = Number(m[2]);
  const day = Number(m[1]);
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y, m: month, d: day };
}

function sameCalendarDate(a: string, b: string): boolean {
  const pa = parseSheetNgayCell(a);
  const pb = parseSheetNgayCell(b);
  if (pa && pb) return datePartsKey(pa) === datePartsKey(pb);
  const na = normalizePanelDateKey(a).toLowerCase();
  const nb = normalizePanelDateKey(b).toLowerCase();
  return Boolean(na && nb && na === nb);
}

/** Chuẩn hóa danh sách ngày từ panel (tối đa 3 ô, bỏ trống). */
export function parseFilterDatesFromPanel(raw: unknown[]): string[] {
  return parseFilterSlotsFromPanel(raw, []).map((s) => s.panelNgay);
}

export type BaoCaoFilterSlot = { panelNgay: string; panelMcc: string };

/** Chuẩn hóa MCC (cột B) để so khớp — bỏ khoảng thừa, gạch unicode, không phân biệt hoa thường. */
export function normalizeMccKey(s: string): string {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/&amp;/gi, "&")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Mã MCC dạng 960-341-6876 trong chuỗi cột B. */
function extractMccIdKey(s: string): string | null {
  const m = normalizeMccKey(s).match(/(\d{3}-\d{3}-\d{4})/);
  return m ? m[1] : null;
}

/**
 * Cột B khớp ô MCC panel — chuẩn hóa rồi so trùng toàn chuỗi (không khớp lỏng / contains).
 * Panel chỉ nhập mã xxx-xxx-xxxx → khớp khi mã Sheet trùng hệt.
 */
export function matchMccForRow(rowMcc: string, panelMcc: string): boolean {
  const b = normalizeMccKey(panelMcc);
  if (!b) return true;
  const a = normalizeMccKey(rowMcc);
  if (!a) return false;
  if (a === b) return true;
  const idA = extractMccIdKey(a);
  const idB = extractMccIdKey(b);
  if (idA && idB && idA === idB && (a === idA || b === idB)) return true;
  return false;
}

/** Tách chuỗi nhiều dòng (panel textarea) thành danh sách không rỗng. */
export function parseMultilineInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  }
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Danh sách MCC loại trừ từ panel (mỗi dòng một MCC). */
export function parseExcludeMccs(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of parseMultilineInput(raw)) {
    const k = normalizeMccKey(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Mỗi dòng NGÀY ghép MCC cùng chỉ số (MCC trống = chỉ lọc ngày). */
export function parseFilterSlotsFromPanel(dates: unknown[], mccs: unknown[]): BaoCaoFilterSlot[] {
  const dateLines = parseMultilineInput(dates);
  const mccLines = parseMultilineInput(mccs);
  const out: BaoCaoFilterSlot[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < dateLines.length; i++) {
    const panelNgay = normalizePanelDateKey(dateLines[i]);
    if (!panelNgay) continue;
    const panelMcc = normalizeMccKey(mccLines[i] ?? "");
    const sig = (() => {
      const p = parseSheetNgayCell(panelNgay);
      const d = p ? datePartsKey(p) : panelNgay.toLowerCase();
      return `${d}|${panelMcc}`;
    })();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ panelNgay, panelMcc });
  }
  return out;
}

/** Dòng khớp ngày lọc và MCC nằm trong danh sách loại trừ → không gửi. */
export function isRowExcludedByMcc(
  rowNgay: string,
  rowMcc: string,
  panelNgay: string,
  excludeMccs: string[],
): boolean {
  if (excludeMccs.length === 0) return false;
  if (!matchPanelDateForRow(rowNgay, panelNgay)) return false;
  return excludeMccs.some((ex) => matchMccForRow(rowMcc, ex));
}

const PAYMENT_REQUIRED_COLS: { col: number; label: string }[] = [
  { col: BAO_CAO_COL.NGAY, label: "NGÀY" },
  { col: BAO_CAO_COL.MCC, label: "MCC" },
  { col: BAO_CAO_COL.RATE, label: "RATE" },
  { col: BAO_CAO_COL.TIEN_TE, label: "TIỀN TỆ" },
  { col: BAO_CAO_COL.QUY_DOI_USD, label: "QUY ĐỔI USD" },
  { col: BAO_CAO_COL.TONG_THU, label: "TỔNG THU" },
];

/** Các cột bắt buộc còn thiếu để gửi tin chi phí (LINK FILE hiển thị — nếu trống, không chặn gửi). */
export function getBaoCaoRowPaymentMissingLabels(row: string[]): string[] {
  const missing: string[] = [];
  for (const { col, label } of PAYMENT_REQUIRED_COLS) {
    if (col === BAO_CAO_COL.TONG_THU) {
      if (!readBaoCaoTongThuCell(row)) missing.push(label);
    } else if (!String(row[col] ?? "").trim()) {
      missing.push(label);
    }
  }
  return missing;
}

/** Thiếu trường bắt buộc để gửi tin chi phí. */
export function isBaoCaoRowPaymentIncomplete(row: string[]): boolean {
  return getBaoCaoRowPaymentMissingLabels(row).length > 0;
}

/** Cột A khớp một ngày panel → trả về chuỗi ngày user nhập (hiển thị NGÀY trong tin). */
export function matchPanelDateForRow(rowNgay: string, panelDate: string): boolean {
  if (!normalizePanelDateKey(rowNgay) || !normalizePanelDateKey(panelDate)) return false;
  return sameCalendarDate(rowNgay, panelDate);
}

/** Cột J = Done (đã gửi chi phí). */
export function readBaoCaoRowNote(row: string[]): string {
  return String(row[BAO_CAO_COL.NOTE] ?? "").trim();
}

export function isBaoCaoRowNoteDone(row: string[]): boolean {
  return readBaoCaoRowNote(row).toLowerCase() === "done";
}

/** Chữ ký bộ lọc NGÀY+MCC (KV footer TỔNG TIỀN). */
export function filterSlotsSignature(slots: BaoCaoFilterSlot[]): string {
  return slots
    .map((s) => {
      const p = parseSheetNgayCell(s.panelNgay);
      const d = p ? datePartsKey(p) : s.panelNgay.toLowerCase();
      return `${d}|${normalizeMccKey(s.panelMcc)}`;
    })
    .join(";");
}

/** Σ cột I — mọi dòng lọc cùng tên khách cột D. */
export function sumTongThuColumnIForCustomerFilterRows(
  rows: BaoCaoTkFilteredRow[],
  customerColD: string,
): number {
  const dNorm = customerColD.trim().toLowerCase();
  if (!dNorm) return 0;
  let sum = 0;
  for (const e of rows) {
    const rd = String(e.cells[BAO_CAO_COL.TEN_KHACH] ?? "").trim().toLowerCase();
    if (rd !== dNorm) continue;
    sum += parseMoneyNumber(readBaoCaoTongThuCell(e.cells));
  }
  return sum;
}

/** Dòng có TỔNG THU > 0 — dùng cho điều kiện Done trước khi gửi TỔNG TIỀN + QR. */
export function isBaoCaoRowPayableForTongTien(row: string[]): boolean {
  return parseMoneyNumber(readBaoCaoTongThuCell(row)) > 0;
}

/** Mọi dòng lọc có TỔNG THU > 0 của khách đều Note = Done (đã gửi tin chi phí). */
export function allBaoCaoFilterRowsDoneForCustomer(
  rows: BaoCaoTkFilteredRow[],
  customerColD: string,
): boolean {
  const dNorm = customerColD.trim().toLowerCase();
  const matched = rows.filter(
    (e) => String(e.cells[BAO_CAO_COL.TEN_KHACH] ?? "").trim().toLowerCase() === dNorm,
  );
  const payable = matched.filter((e) => isBaoCaoRowPayableForTongTien(e.cells));
  if (payable.length === 0) return false;
  return payable.every((e) => isBaoCaoRowNoteDone(e.cells));
}

/** Dòng lọc có TỔNG THU > 0 của khách (theo thứ tự Sheet). */
export function listPayableFilterRowsForCustomer(
  rows: BaoCaoTkFilteredRow[],
  customerColD: string,
): BaoCaoTkFilteredRow[] {
  const dNorm = customerColD.trim().toLowerCase();
  return rows.filter(
    (e) =>
      String(e.cells[BAO_CAO_COL.TEN_KHACH] ?? "").trim().toLowerCase() === dNorm &&
      isBaoCaoRowPayableForTongTien(e.cells),
  );
}

export type TongTienMccLine = { mcc: string; amount: number; amountDisplay: string };

/** Chi tiết TỔNG TIỀN: nợ cũ cột B CONG_NO + từng cột I (MCC) trong bộ lọc. */
export function buildTongTienBreakdownForCustomer(
  rows: BaoCaoTkFilteredRow[],
  customerColD: string,
  bOldCongNo: number,
): { sumI: number; total: number; mccLines: TongTienMccLine[] } {
  const payable = listPayableFilterRowsForCustomer(rows, customerColD);
  let sumI = 0;
  const mccLines: TongTienMccLine[] = [];
  for (const e of payable) {
    const amount = parseMoneyNumber(readBaoCaoTongThuCell(e.cells));
    if (amount <= 0) continue;
    sumI += amount;
    mccLines.push({
      mcc: String(e.cells[BAO_CAO_COL.MCC] ?? "").trim(),
      amount,
      amountDisplay: formatMoneyForThanhToanLine(amount),
    });
  }
  const total = Math.round((bOldCongNo + sumI) * 100) / 100;
  return { sumI, total, mccLines };
}

/** Dòng lọc đã gửi chi phí (cột J = Done). */
export type BaoCaoDoneRowInfo = {
  ngay: string;
  mcc: string;
  tenKhach: string;
  sheetRow1Based: number;
};

export function listDoneFilterRows(rows: BaoCaoTkFilteredRow[]): BaoCaoDoneRowInfo[] {
  const out: BaoCaoDoneRowInfo[] = [];
  for (const e of rows) {
    if (!isBaoCaoRowNoteDone(e.cells)) continue;
    const ngay =
      String(e.cells[BAO_CAO_COL.NGAY] ?? "").trim() || e.panelNgay.trim();
    out.push({
      ngay,
      mcc: String(e.cells[BAO_CAO_COL.MCC] ?? "").trim(),
      tenKhach: String(e.cells[BAO_CAO_COL.TEN_KHACH] ?? "").trim(),
      sheetRow1Based: e.sheetRow1Based,
    });
  }
  return out;
}

/** Σ cột I (payable) của khách — các dòng lọc có sheetRow ≤ upToRow. */
export function sumPayableColumnIUpToRow(
  rows: BaoCaoTkFilteredRow[],
  customerColD: string,
  upToSheetRow1Based: number,
): number {
  const payable = listPayableFilterRowsForCustomer(rows, customerColD);
  let sum = 0;
  for (const e of payable) {
    if (e.sheetRow1Based > upToSheetRow1Based) continue;
    sum += parseMoneyNumber(readBaoCaoTongThuCell(e.cells));
  }
  return sum;
}

/** Dòng chi phí hợp lệ: có tên khách cột D. */
export function isBaoCaoTkDataRow(row: string[]): boolean {
  return Boolean(String(row[BAO_CAO_COL.TEN_KHACH] ?? "").trim());
}

export function hashBaoCaoTkRowSnapshot(row: string[]): string {
  const cells = row.slice(0, COL_COUNT).map((c) => String(c ?? "").trim());
  if (cells.length > BAO_CAO_COL.NOTE) cells[BAO_CAO_COL.NOTE] = "";
  return cells.join("\x1e");
}

export type BaoCaoTkSheetRow = { sheetRow1Based: number; cells: string[] };

/** NGÀY/MCC hiệu lực — kế thừa từ dòng header khi ô gộp Sheet để trống. */
export type BaoCaoTkEnrichedRow = BaoCaoTkSheetRow & {
  effectiveNgay: string;
  effectiveMcc: string;
};

/** Điền NGÀY (cột A) và MCC (cột B) xuống các dòng con trong cùng khối Sheet. */
export function enrichBaoCaoTkRowsWithBlockHeaders(
  entries: BaoCaoTkSheetRow[],
): BaoCaoTkEnrichedRow[] {
  let lastNgay = "";
  let lastMcc = "";
  const out: BaoCaoTkEnrichedRow[] = [];
  for (const e of entries) {
    const rawA = String(e.cells[BAO_CAO_COL.NGAY] ?? "").trim();
    const rawB = String(e.cells[BAO_CAO_COL.MCC] ?? "").trim();
    if (rawA) lastNgay = rawA;
    if (rawB) lastMcc = rawB;
    out.push({
      ...e,
      effectiveNgay: rawA || lastNgay,
      effectiveMcc: rawB || lastMcc,
    });
  }
  return out;
}

/** Dòng đã lọc — `panelNgay` = ngày nhập trên website (không dùng cột A để hiển thị). */
export type BaoCaoTkFilteredRow = BaoCaoTkSheetRow & {
  panelNgay: string;
  effectiveNgay: string;
  effectiveMcc: string;
};

/** Đọc dòng 2+ tab BAO_CAO_TK (A:M), giữ số dòng Sheet. */
export async function readBaoCaoTkSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string = BAO_CAO_TK_TAB_NAME,
): Promise<BaoCaoTkSheetRow[]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:M${MAX_ROW}`], {
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rawRows = parts[0] ?? [];
  const dataRows: BaoCaoTkSheetRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = padRow(rawRows[i]);
    if (!isBaoCaoTkDataRow(row)) {
      /* Không break — tránh dừng đọc khi có dòng trống giữa các ngày trên Sheet. */
      continue;
    }
    dataRows.push({ sheetRow1Based: i + 2, cells: row });
  }
  return dataRows;
}

/** Gợi ý khi lọc NGÀY/MCC không ra dòng — liệt kê MCC thực tế trên Sheet theo ngày. */
export function buildFilterMismatchDiagnostic(
  entries: BaoCaoTkSheetRow[],
  slots: BaoCaoFilterSlot[],
): { summary: string; detail: Record<string, unknown> } {
  const enriched = enrichBaoCaoTkRowsWithBlockHeaders(entries);
  const hints: string[] = [];
  const slotDetails: Record<string, unknown>[] = [];

  for (const slot of slots) {
    const panel = normalizePanelDateKey(slot.panelNgay);
    const mccOnDate: string[] = [];
    let rowsOnDate = 0;
    for (const e of enriched) {
      if (!matchPanelDateForRow(e.effectiveNgay, panel)) continue;
      rowsOnDate++;
      const mcc = e.effectiveMcc.trim();
      if (mcc && !mccOnDate.includes(mcc)) mccOnDate.push(mcc);
    }
    const panelMccRaw = slot.panelMcc;
    const mccHint =
      mccOnDate.length > 0
        ? mccOnDate.slice(0, 8).join(" | ")
        : "(không có dòng có tên khách cột D)";
    hints.push(
      `Ngày ${panel}: ${rowsOnDate} dòng; MCC Sheet: ${mccHint}` +
        (panelMccRaw ? `; panel MCC: «${panelMccRaw}»` : ""),
    );
    slotDetails.push({
      panelNgay: panel,
      panelMcc: panelMccRaw,
      rowsOnDate,
      mccOnSheet: mccOnDate,
    });
  }

  return {
    summary: hints.join(" — "),
    detail: { slots: slotDetails },
  };
}

/**
 * Gộp dòng: cột A trùng ngày panel; nếu ô MCC có giá trị thì cột B phải khớp MCC.
 */
export function filterBaoCaoSheetRowsBySlots(
  entries: BaoCaoTkSheetRow[],
  slots: BaoCaoFilterSlot[],
): BaoCaoTkFilteredRow[] {
  const enriched = enrichBaoCaoTkRowsWithBlockHeaders(entries);
  const bySheetRow = new Map<number, BaoCaoTkFilteredRow>();
  for (const slot of slots) {
    const panel = normalizePanelDateKey(slot.panelNgay);
    if (!panel) continue;
    for (const e of enriched) {
      if (!matchPanelDateForRow(e.effectiveNgay, panel)) continue;
      if (!matchMccForRow(e.effectiveMcc, slot.panelMcc)) continue;
      bySheetRow.set(e.sheetRow1Based, {
        sheetRow1Based: e.sheetRow1Based,
        cells: e.cells,
        panelNgay: panel,
        effectiveNgay: e.effectiveNgay,
        effectiveMcc: e.effectiveMcc,
      });
    }
  }
  return [...bySheetRow.values()].sort((a, b) => a.sheetRow1Based - b.sheetRow1Based);
}

/** @deprecated dùng filterBaoCaoSheetRowsBySlots */
export function filterBaoCaoSheetRowsByDates(
  entries: BaoCaoTkSheetRow[],
  filterDates: string[],
): BaoCaoTkFilteredRow[] {
  return filterBaoCaoSheetRowsBySlots(
    entries,
    filterDates.map((d) => ({ panelNgay: d, panelMcc: "" })),
  );
}
