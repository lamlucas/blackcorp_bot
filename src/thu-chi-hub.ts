/**
 * Bot Thu Chi: lệnh nhiều dòng → THU_CHI; note đặc biệt → HH_LOAI_TRU / COC;
 * nhận tin bot Báo cáo « TỔNG TIỀN… » → CONG_NO (telegram-poll).
 */
import { appendCocRow, isCocNote } from "./coc-sheet";
import { appendHhLoaiTruRow, isHhLoaiTruNote, isUngNote } from "./hh-loai-tru-sheet";
import { sheetsValuesAppend } from "./google";
import {
  buildThuChiMultilineRow,
  formatThuChiMultilineSummary,
  parseThuChiMultilineCommand,
  type ThuChiMultilineCmd,
} from "./thu-chi-multiline";
import { copyMessage, sendPlainMessage } from "./telegram";
import { getAccessTokenFromEnv, type Env } from "./worker-lib";

const SHEET_THU_CHI = "THU_CHI";
const DA_NHAN = "Đã nhận thông tin";
const DEFAULT_HUB_CHAT = "-1003727898214";

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

function formatNgayVietnam(unixSec?: number): string {
  const d = unixSec != null ? new Date(unixSec * 1000) : new Date();
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

async function appendThuChiMultilineRow(
  env: Env,
  cmd: ThuChiMultilineCmd,
  unixSec?: number,
): Promise<void> {
  const token = await getAccessTokenFromEnv(env);
  const ngay = formatNgayVietnam(unixSec);
  const row = buildThuChiMultilineRow(cmd, ngay);
  const q = `'${SHEET_THU_CHI.replace(/'/g, "''")}'!A:E`;
  await sheetsValuesAppend(token, thuChiSpreadsheetId(env), q, [row], "USER_ENTERED");
}

async function maybeAppendHhLoaiTruAfterThuChi(
  env: Env,
  cmd: ThuChiMultilineCmd,
  unixSec?: number,
): Promise<void> {
  if (!isHhLoaiTruNote(cmd.note)) return;
  try {
    const token = await getAccessTokenFromEnv(env);
    const ngay = formatNgayVietnam(unixSec);
    await appendHhLoaiTruRow(token, thuChiSpreadsheetId(env), {
      ngay,
      kind: cmd.kind,
      amount: cmd.amount,
      ten: cmd.ten,
      note: cmd.note,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("hh-loai-tru append", msg);
  }
}

async function maybeAppendCocAfterThuChi(
  env: Env,
  cmd: ThuChiMultilineCmd,
  unixSec?: number,
): Promise<void> {
  if (!isCocNote(cmd.note)) return;
  try {
    const token = await getAccessTokenFromEnv(env);
    const ngay = formatNgayVietnam(unixSec);
    await appendCocRow(token, thuChiSpreadsheetId(env), cmd, ngay);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("coc append", msg);
  }
}

const DEFAULT_CHAM_CONG_SHEET = "1rZYkgdY6C4Tf1tOjqBw0hwkVE7pLGQlQSNS21ikjZ-w";

function chamCongSpreadsheetIdFromEnv(env: Env): string {
  const v = (env.CHAM_CONG_SPREADSHEET_ID ?? "").trim();
  return v || DEFAULT_CHAM_CONG_SHEET;
}

async function maybeUpdateChamCongTienUngAfterThuChi(
  env: Env,
  cmd: ThuChiMultilineCmd,
  unixSec?: number,
): Promise<void> {
  if (!isUngNote(cmd.note)) return;
  try {
    const { getChamCongEmployeeMap, resolveTabForEmployeeName } = await import("./cham-cong-map");
    const { ensureTodayDateRow, writeChamCongAmountByNgay } = await import("./cham-cong-sheet");
    const map = await getChamCongEmployeeMap(env.STORE);
    const tabName = resolveTabForEmployeeName(cmd.ten, map);
    if (!tabName) return;

    const token = await getAccessTokenFromEnv(env);
    const spreadsheetId = chamCongSpreadsheetIdFromEnv(env);
    const ngay = formatNgayVietnam(unixSec);
    await ensureTodayDateRow(token, spreadsheetId, tabName, unixSec);
    await writeChamCongAmountByNgay(token, spreadsheetId, tabName, ngay, "C", cmd.amount);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("cham-cong tien ung", msg);
  }
}

function replyHasImage(reply: PollTelegramMessage | undefined): boolean {
  if (!reply) return false;
  if (reply.photo?.length) return true;
  return String(reply.document?.mime_type ?? "").startsWith("image/");
}

/**
 * Xử lý lệnh Thu/Chi nhiều dòng từ nhóm đại lý → hub + Sheet (reply ảnh tùy chọn).
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

  const multilineCmd = parseThuChiMultilineCommand(text);
  if (!multilineCmd) return false;

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
    await appendThuChiMultilineRow(env, multilineCmd, opts.unixSec);
    await maybeAppendHhLoaiTruAfterThuChi(env, multilineCmd, opts.unixSec);
    await maybeAppendCocAfterThuChi(env, multilineCmd, opts.unixSec);
    await maybeUpdateChamCongTienUngAfterThuChi(env, multilineCmd, opts.unixSec);

    if (!isHub) {
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
      const forwardLine = formatThuChiMultilineSummary(multilineCmd);
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
