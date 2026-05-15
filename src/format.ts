import { escapeHtmlTelegram } from "./telegram";

export function boldValue(v: string): string {
  return `<b>${escapeHtmlTelegram(v)}</b>`;
}

export function line(label: string, value: string): string {
  return `${escapeHtmlTelegram(label)}: ${boldValue(value)}`;
}

export function isRowEmpty(cells: string[]): boolean {
  return cells.every((c) => !String(c ?? "").trim());
}

export function hashRow(cells: string[]): string {
  return cells.map((c) => String(c ?? "").trim()).join("\x1e");
}

/** Cột A–I dữ liệu chi phí (không gồm J bot ghi TỔNG THU). */
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

/** Hiển thị số trong dòng « … + … = … » (tối đa 2 chữ số thập phân, bỏ số 0 thừa). */
export function formatMoneyForThanhToanLine(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  if (Object.is(r, -0)) return "0";
  const s = r.toFixed(2).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
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
 * `null` = không có dòng khớp hoặc B rỗng → không dùng trong tổng TỔNG THU.
 */
export function getCongNoColumnBForCustomerD(
  debtMap: Map<string, string>,
  customerColD: string
): string | null {
  const d = customerColD.trim();
  if (!d) return null;
  if (debtMap.has(d)) {
    const b = String(debtMap.get(d) ?? "").trim();
    return b ? b : null;
  }
  const low = d.toLowerCase();
  for (const [a, b] of debtMap) {
    const at = String(a ?? "").trim();
    if (at.toLowerCase() !== low) continue;
    const bt = String(b ?? "").trim();
    return bt ? bt : null;
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
  return v ?? "0";
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
  if (getCongNoColumnBForCustomerD(debtMap, customerColD) == null) return 0;
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
 * Tin tổng thanh toán (trước ảnh QR): Σ cột I mọi tab TINH_TIEN có link (cùng tên cột D) + công nợ cột B CONG_NO (A = D).
 */
export function formatTongTienCanThanhToanMessage(opt: {
  sumI: string;
  congNo: string;
  total: string;
}): string {
  return `${escapeHtmlTelegram("TỔNG TIỀN CẦN THANH TOÁN")}: ${boldValue(
    opt.sumI
  )} + ${boldValue(opt.congNo)} = ${boldValue(opt.total)}`;
}

/**
 * TỔNG THU = số (cột B CONG_NO theo A = D) + Σ cột I các tab TINH_TIEN (cùng điều kiện khớp CONG_NO).
 * Không khớp CONG_NO hoặc B rỗng → 0 (không cộng phần I).
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

/** Một dòng Sheet A–I: CÔNG NỢ + TỔNG THU đã tính + LINK FILE. */
export function formatSheetPaymentRowMessage(opt: {
  ngay: string;
  mcc: string;
  taiKhoan: string;
  maDlTenKhach: string;
  rate: string;
  tongTieu: string;
  tienTe: string;
  quyDoiUsd: string;
  thucThuColI: string;
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
    line("THỰC THU", opt.thucThuColI || "—"),
    line("CÔNG NỢ", opt.congNoCu || "0"),
    line("TỔNG THU", opt.tongThu || "0"),
    line("LINK FILE", opt.linkFile.trim()),
  ];
  return parts.join("\n");
}

/**
 * Thông báo công nợ cron: cột A CONG_NO (mã đại lý / tên khách), cột B hiển thị là NỢ CŨ.
 */
export function formatDebtOnlyNotify(opt: { maDl: string; noCu: string }): string {
  return [line("MÃ ĐL", opt.maDl), line("NỢ CŨ", opt.noCu)].join("\n");
}
