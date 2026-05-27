import { parseMoneyNumber, stripTelegramHtml } from "./format";
import { sheetsPutValues } from "./google";
import { batchGetValues } from "./worker-lib";

/** Tab Thu chi — bot « Thu/Chi cọc » ghi A:D (panel Tiền cọc đọc cùng tab). */
export const THU_CHI_TAB_NAME = "THU_CHI";
const THU_CHI_MAX_ROW = 2000;
const THU_CHI_COLS = 4;

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

/** Cột D (Ghi chú) = « AT - Thẳng ». */
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

export type ThuChiSheetRow = {
  sheetRow1Based: number;
  ngay: string;
  thu: number;
  chi: number;
  ghiChu: string;
};

export type ThuChiRowPayload = {
  ngay: string;
  thu: string | number;
  chi: string | number;
  ghiChu: string;
};

function padThuChiRow(raw: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < THU_CHI_COLS; i++) out.push(String(raw[i] ?? ""));
  return out;
}

/** Đọc dòng 2+ tab THU_CHI (A:D). */
export async function readThuChiSheetRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string = THU_CHI_TAB_NAME,
): Promise<ThuChiSheetRow[]> {
  const q = quoteSheet(tabName);
  const parts = await batchGetValues(accessToken, spreadsheetId, [`${q}!A2:D${THU_CHI_MAX_ROW}`]);
  const rawRows = parts[0] ?? [];
  const out: ThuChiSheetRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const cells = padThuChiRow(rawRows[i]);
    const ngay = cells[0].trim();
    const thu = parseMoneyNumber(cells[1]);
    const chi = parseMoneyNumber(cells[2]);
    const ghiChu = cells[3].trim();
    if (!ngay && !ghiChu && thu === 0 && chi === 0) continue;
    out.push({
      sheetRow1Based: i + 2,
      ngay,
      thu,
      chi,
      ghiChu,
    });
  }
  return out;
}

function rowToValues(r: ThuChiRowPayload): (string | number)[] {
  const thuN = parseMoneyNumber(String(r.thu ?? ""));
  const chiN = parseMoneyNumber(String(r.chi ?? ""));
  return [
    String(r.ngay ?? "").trim(),
    thuN > 0 ? thuN : "",
    chiN > 0 ? chiN : "",
    String(r.ghiChu ?? "").trim(),
  ];
}

/** Ghi đè A2:D (giữ hàng 1 tiêu đề). */
export async function writeThuChiDataRows(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  rows: ThuChiRowPayload[],
): Promise<void> {
  const q = quoteSheet(tabName);
  const body = rows.map(rowToValues);
  if (body.length === 0) {
    await sheetsPutValues(accessToken, spreadsheetId, `${q}!A2:D2`, [[""]], "USER_ENTERED");
    return;
  }
  const end = 1 + body.length;
  await sheetsPutValues(accessToken, spreadsheetId, `${q}!A2:D${end}`, body, "USER_ENTERED");
}
