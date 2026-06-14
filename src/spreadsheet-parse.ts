/**
 * Đọc XLSX/CSV trên Worker — từng file, tránh OOM trình duyệt.
 */
import * as XLSX from "xlsx";
import { colLettersToIdx, HEADER_ROWS_SKIP } from "./ket-qua";

export type SlimParseConfig = {
  campaignCol: string;
  costCol: string;
  currencyCol: string;
  accountNameCol: string;
  headerRows?: number;
};

/** Cột sau khi thu gọn (A–D) gửi cho analyzeKetQuaFiles. */
export const SLIM_COLUMN_MAP = {
  campaignCol: "A",
  costCol: "B",
  currencyCol: "C",
  accountNameCol: "D",
} as const;

function cellStr(row: unknown[], colIdx: number): string {
  if (colIdx < 0 || colIdx >= row.length) return "";
  const v = row[colIdx];
  if (v == null) return "";
  return String(v).trim();
}

export function parseCsvText(text: string): unknown[][] {
  const raw = String(text ?? "").replace(/^\uFEFF/, "");
  const rows: unknown[][] = [];
  let row: unknown[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r" && next === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) {
    rows.push(row);
  }

  return rows;
}

export function parseSpreadsheetBuffer(fileName: string, buf: ArrayBuffer): unknown[][] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return parseCsvText(text);
  }
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    throw new Error(`Định dạng không hỗ trợ: ${fileName} (chỉ .xlsx, .xls, .csv).`);
  }

  const data = new Uint8Array(buf);
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, {
      type: "array",
      cellDates: false,
      dense: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetStubs: false,
    });
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Không đọc được file Excel « ${fileName} » (${hint}). Thử mở bằng Excel rồi Lưu lại, hoặc xuất CSV.`,
    );
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }) as unknown[][];
}

/** Chỉ giữ 4 cột cần dùng → giảm dung lượng JSON rất nhiều. */
export function toSlimRows(fullRows: unknown[][], config: SlimParseConfig): unknown[][] {
  const headerRows = config.headerRows ?? HEADER_ROWS_SKIP;
  const accIdx = colLettersToIdx(config.accountNameCol);
  const campIdx = colLettersToIdx(config.campaignCol);
  const costIdx = colLettersToIdx(config.costCol);
  const currIdx = colLettersToIdx(config.currencyCol);

  const slim: unknown[][] = [];
  for (let i = 0; i < fullRows.length; i++) {
    const row = fullRows[i] ?? [];
    if (i < headerRows) {
      slim.push(["", "", "", ""]);
      continue;
    }
    slim.push([
      cellStr(row, accIdx),
      cellStr(row, campIdx),
      costIdx < row.length ? row[costIdx] : "",
      cellStr(row, currIdx),
    ]);
  }
  return slim;
}

export function parseAndSlimFile(
  fileName: string,
  buf: ArrayBuffer,
  config: SlimParseConfig,
): unknown[][] {
  const full = parseSpreadsheetBuffer(fileName, buf);
  return toSlimRows(full, config);
}
