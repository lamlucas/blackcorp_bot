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

/** Tên khách (cột D) có trong CONG_NO cột A và cột B có giá trị (sau trim). */
export function debtValidCustomerNames(debtMap: Map<string, string>): Set<string> {
  const s = new Set<string>();
  for (const [a, b] of debtMap) {
    const name = a.trim();
    if (name && String(b ?? "").trim()) s.add(name);
  }
  return s;
}

/**
 * Σ cột I (THỰC THU) trên mọi tab trong `tabRows`, các dòng có cột D = `customerDTrim`
 * và `customerDTrim` thuộc `validNames` (đã khớp CONG_NO A + B có giá trị).
 */
export function sumEligibleThucThuIForCustomer(
  tabRows: Record<string, string[][]>,
  customerDTrim: string,
  validNames: Set<string>
): number {
  const d = customerDTrim.trim();
  if (!d || !validNames.has(d)) return 0;
  let sum = 0;
  for (const rows of Object.values(tabRows)) {
    for (const r of rows) {
      const rd = String(r[3] ?? "").trim();
      if (rd === d) sum += parseMoneyNumber(String(r[8] ?? ""));
    }
  }
  return sum;
}

/**
 * TỔNG THU = số (cột B CONG_NO theo tên cột D) + ΣI các tab TINH_TIEN (chỉ khi D hợp lệ trên CONG_NO).
 * Nếu D không khớp A hoặc B rỗng trên CONG_NO → không cộng (0).
 */
export function computeTongThuForPaymentRow(opts: {
  debtMap: Map<string, string>;
  customerColD: string;
  allTabDataRows: Record<string, string[][]>;
}): { tongThuDisplay: string; tongThuNum: number } {
  const d = opts.customerColD.trim();
  const valid = debtValidCustomerNames(opts.debtMap);
  if (!d || !valid.has(d)) {
    return { tongThuDisplay: "0", tongThuNum: 0 };
  }
  const bStr = String(opts.debtMap.get(d) ?? "").trim();
  const bNum = parseMoneyNumber(bStr);
  const sumI = sumEligibleThucThuIForCustomer(opts.allTabDataRows, d, valid);
  const n = bNum + sumI;
  return { tongThuDisplay: formatNumberForCell(n), tongThuNum: n };
}

/** Một dòng Sheet A–I + LINK FILE tab + TỔNG THU đã tính. */
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
    line("TỔNG THU", opt.tongThu || "—"),
    line("LINK FILE", opt.linkFile.trim() || "—"),
  ];
  return parts.join("\n");
}

/**
 * Đại lý không tick nhưng có nợ trên tab CONG_NO (cột A = MÃ ĐL, cột B = NỢ CŨ).
 * Chuỗi A/B đọc từ Sheet; khi khớp tên tab đại lý, hiển thị đúng nhãn MÃ ĐL / NỢ CŨ.
 */
export function formatDebtOnlyNotify(opt: { maDl: string; noCu: string }): string {
  return [line("MÃ ĐL", opt.maDl), line("NỢ CŨ", opt.noCu)].join("\n");
}
