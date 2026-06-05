import { parseMoneyNumber, stripTelegramHtml } from "./format";
import { sheetsPutValues } from "./google";
import { batchGetValues } from "./worker-lib";

/** Tab tiền cọc — panel web đọc/ghi A:E. */
export const COC_TAB_NAME = "COC";
const COC_MAX_ROW = 2000;
const COC_COLS = 5;

/** Bot « Thu/Chi cọc » vẫn ghi tab THU_CHI (A:D). */
export const THU_CHI_TAB_NAME = "THU_CHI";

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export type CocParsedCmd = {
  kind: "THU" | "CHI";
  amount: number;
  ten: string;
  note: string;
};

/** Thu cọc: 1000 - AT - Thẳng / Chi cọc: … */
export function parseCocCommand(text: string): CocParsedCmd | null {
  const plain = stripTelegramHtml(text).trim();
  const m = plain.match(/^(Thu|Chi)\s*cọc\s*:\s*([\d.,\s]+)\s*-\s*(.+?)\s*-\s*(.+)$/iu);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() === "thu" ? "THU" : "CHI";
  const amountStr = String(m[2] ?? "").trim();
  const ten = String(m[3] ?? "").trim();
  const note = String(m[4] ?? "").trim();
  if (!amountStr || !ten || !/\d/.test(amountStr.replace(/\s/g, ""))) return null;
  const amount = parseMoneyNumber(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { kind, amount, ten, note };
}

/** Cột D (Ghi chú) trên THU_CHI = « AT - Thẳng ». */
export function cocGhiChu(cmd: CocParsedCmd): string {
  return `${cmd.ten} - ${cmd.note}`;
}

/** Một dòng THU_CHI: A ngày | B thu | C chi | D ghi chú. */
export function buildThuChiRowFromCoc(cmd: CocParsedCmd, ngay: string): (string | number)[] {
  return [
    ngay,
    cmd.kind === "THU" ? cmd.amount : "",
    cmd.kind === "CHI" ? cmd.amount : "",
    cocGhiChu(cmd),
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

/** Đọc dòng 2+ tab COC (A:E) — A Ngày, B Thu, C Chi, D Tên, E Ghi chú. */
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
    /** Dòng cũ 4 cột: D là ghi chú (chỉ khi sheet chưa có cột E). */
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

function rowToValues(r: CocRowPayload): (string | number)[] {
  const thuN = parseMoneyNumber(String(r.thu ?? ""));
  const chiN = parseMoneyNumber(String(r.chi ?? ""));
  return [
    String(r.ngay ?? "").trim(),
    thuN > 0 ? thuN : "",
    chiN > 0 ? chiN : "",
    String(r.ten ?? "").trim(),
    String(r.note ?? "").trim(),
  ];
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
    await sheetsPutValues(accessToken, spreadsheetId, range, [rowToValues(row)], "USER_ENTERED");
    written++;
  }
  return written;
}
