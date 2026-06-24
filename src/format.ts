import { escapeHtmlTelegram } from "./telegram";

export function boldValue(v: string): string {
  return `<b>${escapeHtmlTelegram(v)}</b>`;
}

export function line(label: string, value: string): string {
  return `${escapeHtmlTelegram(label)}: ${boldValue(value)}`;
}

/** Ngày hiện tại theo giờ Việt Nam (dd/mm/yyyy). */
export function formatNgayVietnamNow(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
}

/** Khóa ngày yyyy-mm-dd theo giờ Việt Nam (KV rollover cột C CONG_NO). */
export function getVietnamDateKeyNow(unixSec?: number): string {
  const d = unixSec != null ? new Date(unixSec * 1000) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function isRowEmpty(cells: string[]): boolean {
  return cells.every((c) => !String(c ?? "").trim());
}

export function hashRow(cells: string[]): string {
  return cells.map((c) => String(c ?? "").trim()).join("\x1e");
}

/** Cột A–I dữ liệu chi phí (J = NOTE bot ghi, không gộp vào hash dòng TINH_TIEN). */
const PAYMENT_DATA_COLS = 9;

export function hashRowDataColumns(cells: string[]): string {
  return hashRow(cells.slice(0, PAYMENT_DATA_COLS));
}

/** Hash một dòng A–I (dedupe gửi theo từng dòng Sheet). */
export function hashPaymentRowSnapshot(row: string[]): string {
  return hashRowDataColumns(row);
}

/**
 * Parse số từ ô (công nợ, THỰC THU cột I). Hiển thị Telegram dùng chuỗi gốc cột, không dùng hàm này cho phần hiển thị.
 */
export function parseMoneyNumber(raw: string): number {
  let s = String(raw ?? "").trim().replace(/\s/g, "");
  if (!s) return 0;
  s = s.replace(/%/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const p = s.split(",");
    if (p.length === 2 && p[1].length <= 2) {
      s = p[0] + "." + p[1];
    } else {
      s = s.replace(/,/g, "");
    }
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function formatNumberForCell(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/**
 * Hiển thị / ghi Sheet: dấu phẩy thập phân (vd 407,6 — khớp locale VN, tránh Sheets hiểu sai).
 */
export function formatMoneyForThanhToanLine(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  if (Object.is(r, -0)) return "0";
  const s = r.toFixed(2).replace(/\.?0+$/, "");
  if (s === "") return "0";
  return s.replace(".", ",");
}

/** Chuỗi nợ từ CONG_NO → hiển thị Telegram (luôn dấu phẩy nếu là số). */
export function formatDebtDisplayForTelegram(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "0";
  return formatMoneyForThanhToanLine(parseMoneyNumber(t));
}

/** Tin thủ công (form web) — MÃ CAMP đầy đủ do Worker ghép tiền tố + tên tab Sheet */
export function formatManualMessage(input: {
  ngay: string;
  mcc: string;
  maCamp: string;
  rate: string;
  ruleLines: string[];
}): string {
  const lines: string[] = [
    line("NGÀY", input.ngay),
    line("MCC", input.mcc),
    line("MÃ CAMP", input.maCamp),
    line("RATE", input.rate),
    "RULE:",
  ];
  for (const r of input.ruleLines) {
    const t = r.trim();
    if (t) lines.push(boldValue(t));
  }
  return lines.join("\n");
}

/**
 * Giá trị cột B CONG_NO khi cột A khớp tên cột D (trim; thử không phân biệt hoa thường).
 * `null` = không có dòng khớp; chuỗi rỗng = có dòng nhưng B trống (tính 0).
 */
export function getCongNoColumnBForCustomerD(
  debtMap: Map<string, string>,
  customerColD: string
): string | null {
  const d = customerColD.trim();
  if (!d) return null;
  if (debtMap.has(d)) {
    return String(debtMap.get(d) ?? "").trim();
  }
  const low = d.toLowerCase();
  for (const [a, b] of debtMap) {
    const at = String(a ?? "").trim();
    if (at.toLowerCase() !== low) continue;
    return String(b ?? "").trim();
  }
  return null;
}

/** Có dòng CONG_NO (cột A) khớp tên cột D — không yêu cầu B có giá trị. */
export function hasCongNoRowForCustomerD(
  debtMap: Map<string, string>,
  customerColD: string,
): boolean {
  return getCongNoColumnBForCustomerD(debtMap, customerColD) !== null;
}

export type CongNoRowCells = { maDl: string; b: string; c: string };

/** Tìm dòng CONG_NO theo tên cột D (không phân biệt hoa thường). */
export function findCongNoRowForCustomerD(
  fullMap: Map<string, CongNoRowCells>,
  customerColD: string,
): CongNoRowCells | null {
  const d = customerColD.trim();
  if (!d) return null;
  if (fullMap.has(d)) return fullMap.get(d)!;
  const low = d.toLowerCase();
  for (const [a, row] of fullMap) {
    if (a.toLowerCase() === low) return row;
  }
  return null;
}

/** Nợ đầu ngày cột C — không có dòng hoặc C trống → 0. */
export function getCongNoOpeningColumnCForCustomerD(
  fullMap: Map<string, CongNoRowCells>,
  customerColD: string,
): number {
  const row = findCongNoRowForCustomerD(fullMap, customerColD);
  if (!row) return 0;
  return parseMoneyNumber(row.c);
}

/** Khóa cột A CONG_NO khớp tên cột D (trim, không phân biệt hoa thường) — dùng khi ghi/xóa dòng. */
export function resolveCongNoMaDlKeyForCustomerD(
  debtMap: Map<string, string>,
  customerColD: string,
): string | null {
  const d = customerColD.trim();
  if (!d) return null;
  if (debtMap.has(d)) {
    const b = String(debtMap.get(d) ?? "").trim();
    return b ? d : null;
  }
  const low = d.toLowerCase();
  for (const [a, b] of debtMap) {
    const at = String(a ?? "").trim();
    if (at.toLowerCase() !== low) continue;
    const bt = String(b ?? "").trim();
    return bt ? at : null;
  }
  return null;
}

/** Khóa cột A CONG_NO khớp tên cột D — chỉ cần trùng A (B có thể trống). */
export function resolveCongNoMaDlKeyByCustomerName(
  debtMap: Map<string, string>,
  customerColD: string,
): string | null {
  const d = customerColD.trim();
  if (!d) return null;
  if (debtMap.has(d)) return d;
  const low = d.toLowerCase();
  for (const [a] of debtMap) {
    const at = String(a ?? "").trim();
    if (at.toLowerCase() === low) return at;
  }
  return null;
}

/**
 * Hiển thị CÔNG NỢ trong tin: cột B khi A = D; không có hoặc B trống → "0".
 */
export function congNoColumnBForDealerName(
  debtMap: Map<string, string>,
  dealerNameColD: string
): string {
  const v = getCongNoColumnBForCustomerD(debtMap, dealerNameColD);
  if (v == null || !v) return "0";
  return formatDebtDisplayForTelegram(v);
}

/**
 * Σ cột I (THỰC THU) trên các tab TINH_TIEN (chỉ dòng có cột D trùng tên khách),
 * chỉ khi tên đó có trong CONG_NO (A khớp D) và cột B có giá trị.
 */
export function sumEligibleThucThuIForCustomer(
  tabRows: Record<string, string[][]>,
  customerColD: string,
  debtMap: Map<string, string>
): number {
  if (!hasCongNoRowForCustomerD(debtMap, customerColD)) return 0;
  const dNorm = customerColD.trim().toLowerCase();
  if (!dNorm) return 0;
  let sum = 0;
  for (const rows of Object.values(tabRows)) {
    for (const r of rows) {
      const rd = String(r[3] ?? "").trim().toLowerCase();
      if (rd === dNorm) sum += parseMoneyNumber(String(r[8] ?? ""));
    }
  }
  return sum;
}

/**
 * Tổng cột I (THỰC THU) mọi dòng có cột D trùng tên — không lọc CONG_NO (dùng cho « TỔNG TIỀN CẦN THANH TOÁN »).
 */
export function sumThucThuColumnIForCustomerD(
  tabRows: Record<string, string[][]>,
  customerColD: string
): number {
  const dNorm = customerColD.trim().toLowerCase();
  if (!dNorm) return 0;
  let sum = 0;
  for (const rows of Object.values(tabRows)) {
    for (const r of rows) {
      const rd = String(r[3] ?? "").trim().toLowerCase();
      if (rd === dNorm) sum += parseMoneyNumber(String(r[8] ?? ""));
    }
  }
  return sum;
}

/**
 * Tin tổng thanh toán (trước ảnh QR):
 * Nợ cũ cột B CONG_NO + từng cột I trong bộ lọc = tổng (chỉ số tiền).
 */
export function formatTongTienCanThanhToanMessage(opt: {
  bOld: string;
  mccLines: { mcc: string; amount: string }[];
  total: string;
}): string {
  const terms: string[] = [];
  if (parseMoneyNumber(opt.bOld) > 0) {
    terms.push(boldValue(opt.bOld));
  }
  for (const line of opt.mccLines) {
    terms.push(boldValue(line.amount));
  }
  if (terms.length === 0) {
    terms.push(boldValue("0"));
  }
  return `${escapeHtmlTelegram("TỔNG TIỀN CẦN THANH TOÁN")}: ${terms.join(" + ")} = ${boldValue(
    opt.total,
  )}`;
}

/** So khớp nợ CONG_NO cột B với nợ cũ + Σ cột I (sai số < 1). */
export function congNoDebtMatchesTongTien(
  bOldCongNo: number,
  sumColumnI: number,
  bCurrentCongNo: number,
): boolean {
  const expected = Math.round((bOldCongNo + sumColumnI) * 100) / 100;
  const current = Math.round(bCurrentCongNo * 100) / 100;
  return Math.abs(current - expected) < 1;
}

/** Bỏ thẻ HTML Telegram trước khi parse tin nhắn. */
export function stripTelegramHtml(text: string): string {
  return String(text ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

const RE_TONG_TIEN =
  /TỔNG\s*TIỀN\s*CẦN\s*THANH\s*TOÁN\s*:\s*.+=\s*([\d.,\s]+)\s*$/iu;

/** Parse dòng « TỔNG TIỀN CẦN THANH TOÁN: … = c » — trả về tổng (phần sau dấu =). */
export function parseTongTienCanThanhToanTotal(text: string): string | null {
  const plain = stripTelegramHtml(text);
  const m = RE_TONG_TIEN.exec(plain);
  if (!m) return null;
  const totalRaw = String(m[1] ?? "").trim();
  if (!totalRaw) return null;
  return formatMoneyForThanhToanLine(parseMoneyNumber(totalRaw));
}

const RE_THU_CMD = /^Thu\s*:\s*([\d.,\s]+)\s*-\s*(.+)$/iu;

/**
 * Parse « Thu: X - Y » — X = số tiền thu/chi; Y = ghi chú (thường là Mã ĐL, khớp cột A tab CONG_NO).
 */
export function parseThuCommand(text: string): { amount: number; maDl: string } | null {
  const plain = stripTelegramHtml(text).trim();
  const m = RE_THU_CMD.exec(plain);
  if (!m) return null;
  const amountStr = String(m[1] ?? "").trim();
  const maDl = String(m[2] ?? "").trim();
  if (!amountStr || !maDl || !/\d/.test(amountStr.replace(/\s/g, ""))) return null;
  return { amount: parseMoneyNumber(amountStr), maDl };
}

/** Số tiền trong lệnh Thu khớp cột B (nợ) của mã ĐL trong CONG_NO, sai lệch ≤ maxDiff. */
export function amountMatchesCongNoDebt(
  thuAmount: number,
  debtColumnB: string | null,
  maxDiff = 2
): boolean {
  if (debtColumnB == null) return false;
  const b = parseMoneyNumber(debtColumnB);
  if (!Number.isFinite(b)) return false;
  return Math.abs(thuAmount - b) <= maxDiff;
}

export type CongNoAfterThuChiAction =
  | { action: "deleteRow" }
  | { action: "set"; display: string };

/**
 * Sau lệnh Thu (THU_CHI cột D khớp CONG_NO cột A):
 * |Thu − nợ B| < threshold hoặc nợ còn lại < threshold → xóa cả dòng; else → ghi B = B − Thu.
 */
export function computeCongNoAfterThuChi(
  debtColumnB: string | null,
  paymentAmount: number,
  threshold = 1,
): CongNoAfterThuChiAction | null {
  if (debtColumnB == null) return null;
  const b = parseMoneyNumber(debtColumnB);
  if (!Number.isFinite(b) || b < 0) return null;
  if (b === 0) {
    const diff = Math.abs(paymentAmount);
    if (diff < threshold) return { action: "deleteRow" };
    return null;
  }
  const remaining = Math.round((b - paymentAmount) * 100) / 100;
  const diff = Math.abs(paymentAmount - b);
  if (diff < threshold || remaining < threshold) return { action: "deleteRow" };
  return { action: "set", display: formatMoneyForThanhToanLine(remaining) };
}

/**
 * TỔNG THU = số (cột B CONG_NO theo A = D) + Σ cột I các tab TINH_TIEN (cùng điều kiện khớp CONG_NO).
 * Không khớp CONG_NO → 0 (không cộng phần I). B rỗng → 0.
 */
export function computeTongThuForPaymentRow(opts: {
  debtMap: Map<string, string>;
  customerColD: string;
  allTabDataRows: Record<string, string[][]>;
}): { tongThuDisplay: string; tongThuNum: number } {
  const bStr = getCongNoColumnBForCustomerD(opts.debtMap, opts.customerColD);
  if (bStr == null) {
    return { tongThuDisplay: "0", tongThuNum: 0 };
  }
  const bNum = parseMoneyNumber(bStr);
  const sumI = sumEligibleThucThuIForCustomer(opts.allTabDataRows, opts.customerColD, opts.debtMap);
  const n = bNum + sumI;
  return { tongThuDisplay: formatNumberForCell(n), tongThuNum: n };
}

/** Một dòng tab BAO_CAO_TK — TỔNG THU = cột I; NOTE (Done/Error) = cột J; LINK FILE = cột M. */
export function formatSheetPaymentRowMessage(opt: {
  ngay: string;
  mcc: string;
  taiKhoan: string;
  maDlTenKhach: string;
  rate: string;
  tongTieu: string;
  tienTe: string;
  quyDoiUsd: string;
  congNoCu: string;
  tongThu: string;
  linkFile: string;
}): string {
  const parts: string[] = [
    line("NGÀY", opt.ngay || "—"),
    line("MCC", opt.mcc || "—"),
    line("TÀI KHOẢN", opt.taiKhoan || "—"),
    line("MÃ ĐL", opt.maDlTenKhach || "—"),
    line("RATE", opt.rate || "—"),
    line("TỔNG TIÊU", opt.tongTieu || "—"),
    line("TIỀN TỆ", opt.tienTe || "—"),
    line("QUY ĐỔI USD", opt.quyDoiUsd || "—"),
    line("CÔNG NỢ", opt.congNoCu || "0"),
    line("TỔNG THU", opt.tongThu || "0"),
    line("LINK FILE", opt.linkFile.trim() || "—"),
  ];
  return parts.join("\n");
}

/** Σ cột I (TỔNG THU) các dòng BAO_CAO_TK cùng tên khách cột D (đã lọc ngày). */
export function sumTongThuColumnIInRows(rows: string[][], customerColD: string): number {
  const dNorm = customerColD.trim().toLowerCase();
  if (!dNorm) return 0;
  let sum = 0;
  for (const r of rows) {
    const rd = String(r[3] ?? "").trim().toLowerCase();
    if (rd !== dNorm) continue;
    const tongThuRaw = String(r[8] ?? "").trim();
    const low = tongThuRaw.toLowerCase();
    if (low === "done" || low === "error") continue;
    sum += parseMoneyNumber(tongThuRaw);
  }
  return sum;
}

/**
 * Thông báo công nợ cron: cột A CONG_NO (mã đại lý / tên khách), cột B hiển thị là NỢ CŨ.
 */
export function formatDebtOnlyNotify(opt: { maDl: string; noCu: string }): string {
  return [line("MÃ ĐL", opt.maDl), line("NỢ CŨ", opt.noCu)].join("\n");
}
