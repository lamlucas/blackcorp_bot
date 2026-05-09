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

/** Tin đọc từ sheet (một đại lý) — có/không khối công nợ */
export function formatSheetRowMessage(opt: {
  titleLine: string;
  ngay: string;
  mcc: string;
  tongTieu: string;
  tienTe: string;
  quyDoiUsd: string;
  rate: string;
  thucThu: string;
  debtBlock?: {
    ngay: string;
    maDl: string;
    mcc: string;
    tongTieu: string;
    tienTe: string;
    quyDoiUsd: string;
    rate: string;
    thucThu: string;
    congNoCu: string;
  };
}): string {
  const parts: string[] = [];
  parts.push(boldValue(opt.titleLine));
  parts.push("");
  parts.push(line("NGÀY", opt.ngay));
  parts.push(line("MCC", opt.mcc));
  parts.push(line("TỔNG TIÊU", opt.tongTieu));
  parts.push(line("TIỀN TỆ", opt.tienTe));
  parts.push(line("QUY ĐỔI USD", opt.quyDoiUsd));
  parts.push(line("RATE", opt.rate));
  parts.push(line("THỰC THU", opt.thucThu));

  if (opt.debtBlock) {
    const d = opt.debtBlock;
    parts.push("");
    parts.push(line("NGÀY", d.ngay));
    parts.push(line("MÃ ĐL", d.maDl));
    parts.push(line("MCC", d.mcc));
    parts.push(line("TỔNG TIÊU", d.tongTieu));
    parts.push(line("TIỀN TỆ", d.tienTe));
    parts.push(line("QUY ĐỔI USD", d.quyDoiUsd));
    parts.push(line("RATE", d.rate));
    parts.push(line("THỰC THU", d.thucThu));
    parts.push(line("CÔNG NỢ CŨ", d.congNoCu));
  }
  return parts.join("\n");
}
