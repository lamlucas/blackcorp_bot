import { resolveTabForTelegramName, getChamCongEmployeeMap } from "./cham-cong-map";
import { markChamCongToday } from "./cham-cong-sheet";
import { sendPlainMessage } from "./telegram";
import { getAccessTokenFromEnv, type Env } from "./worker-lib";
import { thuChiBotToken } from "./thu-chi-hub";

const DEFAULT_CHAM_CONG_GROUP = "-1003885146971";
const DEFAULT_CHAM_CONG_SHEET = "1rZYkgdY6C4Tf1tOjqBw0hwkVE7pLGQlQSNS21ikjZ-w";

export type ChamCongTelegramFrom = {
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

export function chamCongGroupChatId(env: Env): string {
  const v = (env.CHAM_CONG_GROUP_CHAT_ID ?? "").trim();
  return v || DEFAULT_CHAM_CONG_GROUP;
}

export function chamCongSpreadsheetId(env: Env): string {
  const v = (env.CHAM_CONG_SPREADSHEET_ID ?? "").trim();
  return v || DEFAULT_CHAM_CONG_SHEET;
}

export function telegramDisplayName(from?: ChamCongTelegramFrom): string {
  const first = String(from?.first_name ?? "").trim();
  const last = String(from?.last_name ?? "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  if (full) return full;
  return String(from?.username ?? "").trim();
}

function isChamCongInMessage(text: string): boolean {
  return String(text ?? "").trim().toLowerCase() === "in";
}

/**
 * Nhóm Chấm công: tin « In » → tick cột B tab nhân viên (theo tên Telegram).
 */
export async function handleChamCongGroupMessage(
  env: Env,
  chatId: string,
  text: string,
  opts: { from?: ChamCongTelegramFrom; unixSec?: number } = {},
): Promise<boolean> {
  if (opts.from?.is_bot) return false;
  if (chatId !== chamCongGroupChatId(env)) return false;
  if (!isChamCongInMessage(text)) return false;

  const displayName = telegramDisplayName(opts.from);
  if (!displayName) return false;

  const map = await getChamCongEmployeeMap(env.STORE);
  const tabName = resolveTabForTelegramName(displayName, map);
  if (!tabName) {
    const tok = thuChiBotToken(env);
    if (tok) {
      try {
        await sendPlainMessage(
          tok,
          chatId,
          `Chưa cấu hình nhân viên « ${displayName} » trên panel Chấm công.`,
        );
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  try {
    const accessToken = await getAccessTokenFromEnv(env);
    const { ngay } = await markChamCongToday(
      accessToken,
      chamCongSpreadsheetId(env),
      tabName,
      opts.unixSec,
    );
    const tok = thuChiBotToken(env);
    if (tok) {
      try {
        await sendPlainMessage(tok, chatId, `Đã chấm công ${displayName} — ${ngay} (tab ${tabName}).`);
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const tok = thuChiBotToken(env);
    if (tok) {
      try {
        await sendPlainMessage(tok, chatId, `Lỗi chấm công: ${msg}`);
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
