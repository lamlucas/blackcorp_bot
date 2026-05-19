/**
 * Thu:/Chi: trong nhóm đại lý (reply ảnh) → chuyển ảnh + lệnh sang hub « Black Corp - Thu Chi »,
 * append tab THU_CHI (A ngày VN, B Thu, C Chi, D ghi chú). THU khớp nợ CONG_NO ±2 → xóa B.
 */
import { clearCongNoDebtColumnB } from "./cong-no-sheet";
import {
  amountMatchesCongNoDebt,
  getCongNoColumnBForCustomerD,
  parseMoneyNumber,
  stripTelegramHtml,
} from "./format";
import { sheetsValuesAppend } from "./google";
import { copyMessage, sendPlainMessage } from "./telegram";
import { getAccessTokenFromEnv, type Env } from "./worker-lib";

const SHEET_THU_CHI = "THU_CHI";
const DA_NHAN = "Đã nhận thông tin";
const DEFAULT_HUB_CHAT = "-1003727898214";

export type ThuChiCmd = {
  kind: "THU" | "CHI";
  amountStr: string;
  note: string;
};

export type PollTelegramMessage = {
  text?: string;
  date?: number;
  chat?: { id?: number };
  from?: { is_bot?: boolean };
  reply_to_message?: PollTelegramMessage;
  photo?: { file_id: string }[];
  document?: { mime_type?: string };
};

export function thuChiHubChatId(env: Env): string {
  const v = (env.TELEGRAM_THU_CHI_CHAT_ID ?? "").trim();
  return v || DEFAULT_HUB_CHAT;
}

export function thuChiSpreadsheetId(env: Env): string {
  const v = (env.THU_CHI_SPREADSHEET_ID ?? "").trim();
  return v || "1IikVlW74zW54b6b7n1a0ko0MxIQsr_qMH6IR9XNtXpE";
}

function debtSpreadsheetId(env: Env): string {
  return env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
}

/** Thu: 1000 - AT / Chi: 1000 - AT (không phân biệt hoa thường Thu/Chi). */
export function parseThuChiCommand(text: string): ThuChiCmd | null {
  const plain = stripTelegramHtml(text).trim();
  const head = plain.match(/^(Thu|Chi)\s*:\s*(.+)$/iu);
  if (!head) return null;
  const kind = head[1]!.toLowerCase() === "thu" ? "THU" : "CHI";
  const rest = head[2]!.trim();
  const idx = rest.search(/\s-\s/);
  if (idx === -1) return null;
  const amountStr = rest.slice(0, idx).trim();
  const note = rest.slice(idx + 3).trim();
  if (!amountStr || !note || !/\d/.test(amountStr.replace(/\s/g, ""))) return null;
  if (!Number.isFinite(parseMoneyNumber(amountStr))) return null;
  return { kind, amountStr, note };
}

function formatNgayVietnam(unixSec?: number): string {
  const d = unixSec != null ? new Date(unixSec * 1000) : new Date();
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function buildThuChiAppendRow(cmd: ThuChiCmd, ngay: string): (string | number)[] {
  const amount = parseMoneyNumber(cmd.amountStr);
  const thu = cmd.kind === "THU" ? amount : "";
  const chi = cmd.kind === "CHI" ? amount : "";
  return [ngay, thu, chi, cmd.note];
}

function replyHasImage(reply: PollTelegramMessage | undefined): boolean {
  if (!reply) return false;
  if (reply.photo?.length) return true;
  return String(reply.document?.mime_type ?? "").startsWith("image/");
}

async function appendThuChiRow(env: Env, cmd: ThuChiCmd, unixSec?: number): Promise<void> {
  const token = await getAccessTokenFromEnv(env);
  const ngay = formatNgayVietnam(unixSec);
  const row = buildThuChiAppendRow(cmd, ngay);
  const q = `'${SHEET_THU_CHI.replace(/'/g, "''")}'!A:D`;
  await sheetsValuesAppend(token, thuChiSpreadsheetId(env), q, [row], "USER_ENTERED");
}

async function maybeClearCongNoAfterThu(env: Env, cmd: ThuChiCmd): Promise<void> {
  if (cmd.kind !== "THU") return;
  try {
    const accessToken = await getAccessTokenFromEnv(env);
    const { getDebtMap } = await import("./worker-lib");
    const debtMap = await getDebtMap(
      accessToken,
      debtSpreadsheetId(env),
      env.DEBT_TAB_NAME.trim(),
    );
    const bDebt = getCongNoColumnBForCustomerD(debtMap, cmd.note);
    const amount = parseMoneyNumber(cmd.amountStr);
    if (amountMatchesCongNoDebt(amount, bDebt, 2)) {
      await clearCongNoDebtColumnB(
        accessToken,
        debtSpreadsheetId(env),
        env.DEBT_TAB_NAME.trim(),
        cmd.note,
      );
    }
  } catch {
    /* không chặn luồng Thu chi */
  }
}

/**
 * Xử lý lệnh Thu:/Chi: từ nhóm đại lý → hub + Sheet; trong hub chỉ ghi Sheet.
 */
export async function handleThuChiGroupCommand(
  env: Env,
  sourceChatId: string,
  text: string,
  opts: {
    fromIsBot?: boolean;
    replyTo?: PollTelegramMessage;
    unixSec?: number;
  } = {},
): Promise<boolean> {
  if (opts.fromIsBot) return false;

  const cmd = parseThuChiCommand(text);
  if (!cmd) return false;

  const tok = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!tok) return false;

  const hubId = thuChiHubChatId(env);
  const isHub = sourceChatId === hubId;

  try {
    if (!isHub) {
      if (replyHasImage(opts.replyTo) && opts.replyTo != null) {
        const srcId = Number(sourceChatId);
        const destId = Number(hubId);
        const mid = opts.replyTo as { message_id?: number };
        if (Number.isFinite(srcId) && Number.isFinite(destId) && mid.message_id != null) {
          await copyMessage(tok, destId, srcId, mid.message_id);
        }
      }
      const forwardLine = `${cmd.kind === "THU" ? "Thu" : "Chi"}: ${cmd.amountStr} - ${cmd.note}`;
      await sendPlainMessage(tok, hubId, forwardLine);
    }

    await appendThuChiRow(env, cmd, opts.unixSec);
    await maybeClearCongNoAfterThu(env, cmd);

    if (!isHub) {
      await sendPlainMessage(tok, sourceChatId, DA_NHAN);
    }

    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await sendPlainMessage(tok, sourceChatId, `Lỗi ghi Thu chi: ${msg}`);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
