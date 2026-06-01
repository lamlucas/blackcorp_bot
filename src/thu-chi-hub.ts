/**
 * Bot Thu Chi: Thu:/Chi: → THU_CHI; Thu/Chi cọc (reply ảnh) → THU_CHI (ghi chú AT - Thẳng);
 * nhận tin bot Báo cáo « TỔNG TIỀN… » → CONG_NO (telegram-poll).
 * Thu:/Chi: trong nhóm đại lý (reply ảnh) → chuyển ảnh + lệnh sang hub;
 * CONG_NO: chênh nợ ±1 → xóa B; chênh >1 → B = B − số tiền lệnh.
 */
import { clearCongNoDebtColumnB, upsertCongNoDebt } from "./cong-no-sheet";
import {
  computeCongNoAfterThuChi,
  getCongNoColumnBForCustomerD,
  parseMoneyNumber,
  stripTelegramHtml,
} from "./format";
import { buildThuChiRowFromCoc, parseCocCommand } from "./coc-sheet";
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
  caption?: string;
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

/** Đã tách hai bot (có secret TELEGRAM_THU_CHI_BOT_TOKEN). */
export function hasSeparateThuChiBot(env: Env): boolean {
  return Boolean((env.TELEGRAM_THU_CHI_BOT_TOKEN ?? "").trim());
}

/** Token bot Thu Chi — không fallback sang Báo cáo khi đã tách hai bot. */
export function thuChiBotToken(env: Env): string {
  const thuChi = (env.TELEGRAM_THU_CHI_BOT_TOKEN ?? "").trim();
  if (thuChi) return thuChi;
  return (env.TELEGRAM_BOT_TOKEN ?? "").trim();
}

export function baocaoBotToken(env: Env): string {
  return (env.TELEGRAM_BOT_TOKEN ?? "").trim();
}

function debtSpreadsheetId(env: Env): string {
  return env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
}

/** Thu: 1000 - AT / Chi: 1000 - AT (không phân biệt hoa thường Thu/Chi). */
export function parseThuChiCommand(text: string): ThuChiCmd | null {
  const plain = stripTelegramHtml(text).trim();
  if (/^(Thu|Chi)\s*cọc\s*:/iu.test(plain)) return null;
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

async function handleCocGroupCommand(
  env: Env,
  text: string,
  opts: { unixSec?: number; replyTo?: PollTelegramMessage },
): Promise<boolean> {
  if (!replyHasImage(opts.replyTo)) return false;
  const coc = parseCocCommand(text);
  if (!coc) return false;

  const tok = thuChiBotToken(env);
  if (!tok) return false;

  try {
    const accessToken = await getAccessTokenFromEnv(env);
    const ngay = formatNgayVietnam(opts.unixSec);
    const row = buildThuChiRowFromCoc(coc, ngay);
    const q = `'${SHEET_THU_CHI.replace(/'/g, "''")}'!A:D`;
    await sheetsValuesAppend(accessToken, thuChiSpreadsheetId(env), q, [row], "USER_ENTERED");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("coc command", msg);
    throw e;
  }
}

async function appendThuChiRow(env: Env, cmd: ThuChiCmd, unixSec?: number): Promise<void> {
  const token = await getAccessTokenFromEnv(env);
  const ngay = formatNgayVietnam(unixSec);
  const row = buildThuChiAppendRow(cmd, ngay);
  const q = `'${SHEET_THU_CHI.replace(/'/g, "''")}'!A:D`;
  await sheetsValuesAppend(token, thuChiSpreadsheetId(env), q, [row], "USER_ENTERED");
}

async function maybeUpdateCongNoAfterThuChi(env: Env, cmd: ThuChiCmd): Promise<void> {
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
    const next = computeCongNoAfterThuChi(bDebt, amount, 1);
    if (!next) return;

    const sheetId = debtSpreadsheetId(env);
    const tab = env.DEBT_TAB_NAME.trim();
    if (next.action === "clear") {
      await clearCongNoDebtColumnB(accessToken, sheetId, tab, cmd.note);
      return;
    }
    await upsertCongNoDebt(accessToken, sheetId, tab, cmd.note, next.display);
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

  const cocHandled = await handleCocGroupCommand(env, text, {
    unixSec: opts.unixSec,
    replyTo: opts.replyTo,
  });
  if (cocHandled) {
    const tok = thuChiBotToken(env);
    const hubId = thuChiHubChatId(env);
    const isHub = sourceChatId === hubId;
    if (!isHub && tok) {
      if (replyHasImage(opts.replyTo) && opts.replyTo != null) {
        const srcId = Number(sourceChatId);
        const destId = Number(hubId);
        const mid = opts.replyTo as { message_id?: number };
        if (Number.isFinite(srcId) && Number.isFinite(destId) && mid.message_id != null) {
          try {
            await copyMessage(tok, destId, srcId, mid.message_id);
          } catch {
            /* ignore */
          }
        }
      }
      const coc = parseCocCommand(text)!;
      const forwardLine = `${coc.kind === "THU" ? "Thu" : "Chi"} cọc: ${coc.amount} - ${coc.ten} - ${coc.note}`;
      try {
        await sendPlainMessage(tok, hubId, forwardLine);
      } catch {
        /* ignore */
      }
      await sendPlainMessage(tok, sourceChatId, DA_NHAN);
    }
    return true;
  }

  const cmd = parseThuChiCommand(text);
  if (!cmd) return false;

  const tok = thuChiBotToken(env);
  if (!tok) {
    console.error(
      "thu-chi: thiếu TELEGRAM_THU_CHI_BOT_TOKEN — webhook phải đăng ký trên bot Black Corp - Thu Chi",
    );
    return false;
  }

  const hubId = thuChiHubChatId(env);
  const isHub = sourceChatId === hubId;

  if (!isHub && env.STORE) {
    const { rememberGroupChatById } = await import("./telegram-group-cache");
    void rememberGroupChatById(env.STORE, tok, sourceChatId);
  }

  try {
    await appendThuChiRow(env, cmd, opts.unixSec);
    await maybeUpdateCongNoAfterThuChi(env, cmd);

    if (!isHub) {
      if (replyHasImage(opts.replyTo) && opts.replyTo != null) {
        const srcId = Number(sourceChatId);
        const destId = Number(hubId);
        const mid = opts.replyTo as { message_id?: number };
        if (Number.isFinite(srcId) && Number.isFinite(destId) && mid.message_id != null) {
          try {
            await copyMessage(tok, destId, srcId, mid.message_id);
          } catch {
            /* ảnh gốc đã xóa / không copy được — vẫn ghi Sheet + báo Đã nhận */
          }
        }
      }
      const forwardLine = `${cmd.kind === "THU" ? "Thu" : "Chi"}: ${cmd.amountStr} - ${cmd.note}`;
      try {
        await sendPlainMessage(tok, hubId, forwardLine);
      } catch {
        /* hub lỗi không chặn đại lý */
      }
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
