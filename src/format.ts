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

/**
 * Chỉ A2–G2: bot ghi đè H2 nên hash không gồm H — tránh gửi lại tin khi H đổi.
 */
export function hashRowDataColumns(cells: string[]): string {
  return hashRow(cells.slice(0, 7));
}

/**
 * Parse số từ ô (công nợ, cột G). THỰC THU hiển thị trên Telegram = chuỗi gốc cột G, không dùng hàm này.
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

/** Tin thủ công (form web) — gửi mọi nhóm */
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

/** Một khối — đúng cú pháp: THỰC THU = nội dung cột G; TỔNG THU = G + công nợ (và ghi cột H). */
export function formatSheetRowMessage(opt: {
  titleLine?: string;
  ngay: string;
  maDl: string;
  mcc: string;
  tongTieu: string;
  tienTe: string;
  quyDoiUsd: string;
  rate: string;
  /** Giá trị hiển thị THỰC THU = đúng như cột G trên Sheet */
  thucThuFromG: string;
  congNoCu: string;
  /** TỔNG THU = số (G + nợ) */
  tongThu: string;
}): string {
  const parts: string[] = [];
  if (opt.titleLine?.trim()) {
    parts.push(boldValue(opt.titleLine.trim()));
    parts.push("");
  }
  parts.push(line("NGÀY", opt.ngay));
  parts.push(line("MÃ ĐL", opt.maDl));
  parts.push(line("MCC", opt.mcc));
  parts.push(line("TỔNG TIÊU", opt.tongTieu));
  parts.push(line("TIỀN TỆ", opt.tienTe));
  parts.push(line("QUY ĐỔI USD", opt.quyDoiUsd));
  parts.push(line("RATE", opt.rate));
  parts.push(line("THỰC THU", opt.thucThuFromG));
  parts.push(line("CÔNG NỢ CŨ", opt.congNoCu));
  parts.push(line("TỔNG THU", opt.tongThu));
  return parts.join("\n");
}
