import {
  getMailListGroups,
  formatMailListForTelegram,
  MAIL_LIST_EMPTY_REPLY,
} from "./mail-list-kv";
import { sendPlainMessage } from "./telegram";
import { thuChiBotToken } from "./thu-chi-hub";
import type { Env } from "./worker-lib";

/** Lệnh /mail hoặc /mail@TenBot trong nhóm Telegram. */
export function isMailTelegramCommand(text: string): boolean {
  const t = String(text ?? "").trim();
  return /^\/mail(?:@\w+)?$/i.test(t);
}

export async function handleMailTelegramCommand(env: Env, chatId: string): Promise<boolean> {
  const tok = thuChiBotToken(env);
  if (!tok) return false;

  const groups = await getMailListGroups(env.STORE);
  const body = formatMailListForTelegram(groups) ?? MAIL_LIST_EMPTY_REPLY;
  try {
    await sendPlainMessage(tok, chatId, body);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("mail command", chatId, msg);
    try {
      await sendPlainMessage(tok, chatId, `Lỗi lấy danh sách email: ${msg}`);
    } catch {
      /* ignore */
    }
    return true;
  }
}
