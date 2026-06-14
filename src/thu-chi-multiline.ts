import { parseMoneyNumber, stripTelegramHtml } from "./format";

export type ThuChiMultilineCmd = {
  kind: "THU" | "CHI";
  amountStr: string;
  amount: number;
  ten: string;
  note: string;
};

/**
 * Định dạng nhiều dòng:
 * Thu | Chi
 * <số tiền>
 * <tên>
 * [<note>]
 */
export function parseThuChiMultilineCommand(text: string): ThuChiMultilineCmd | null {
  const plain = stripTelegramHtml(text).trim();

  const lines = plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3 || lines.length > 4) return null;

  const kindMatch = lines[0]!.match(/^(Thu|Chi)$/iu);
  if (!kindMatch) return null;

  const amountStr = lines[1]!.trim();
  const ten = lines[2]!.trim();
  const note = lines.length >= 4 ? lines[3]!.trim() : "";

  if (!amountStr || !ten || !/\d/.test(amountStr.replace(/\s/g, ""))) return null;
  const amount = parseMoneyNumber(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    kind: kindMatch[1]!.toLowerCase() === "thu" ? "THU" : "CHI",
    amountStr,
    amount,
    ten,
    note,
  };
}

/** THU_CHI: A ngày | B Thu | C Chi | D Tên | E Note. */
export function buildThuChiMultilineRow(
  cmd: ThuChiMultilineCmd,
  ngay: string,
): (string | number)[] {
  const thu = cmd.kind === "THU" ? cmd.amount : "";
  const chi = cmd.kind === "CHI" ? cmd.amount : "";
  return [ngay, thu, chi, cmd.ten, cmd.note];
}

export function formatThuChiMultilineSummary(cmd: ThuChiMultilineCmd): string {
  const head = cmd.kind === "THU" ? "Thu" : "Chi";
  if (cmd.note) return `${head}\n${cmd.amountStr}\n${cmd.ten}\n${cmd.note}`;
  return `${head}\n${cmd.amountStr}\n${cmd.ten}`;
}
