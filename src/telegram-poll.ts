import { upsertCongNoDebt } from "./cong-no-sheet";
import { getDealerChatMap, resolveDealerNameForChatId } from "./dealer-map";
import { parseTongTienCanThanhToanTotal } from "./format";
import { getAccessTokenFromEnv, type Env } from "./worker-lib";
import {
  handleThuChiGroupCommand,
  thuChiBotToken,
  type PollTelegramMessage,
} from "./thu-chi-hub";
import {
  getTelegramUpdateOffset,
  fetchTelegramUpdates,
  setTelegramUpdateOffset,
} from "./telegram-updates";

const KV_POLL_LOCK = "telegram:poll_lock";
const POLL_LOCK_TTL_SEC = 90;

type TgUser = { id?: number; is_bot?: boolean };
type TgChat = { id?: number; type?: string };
type TgMessage = PollTelegramMessage & {
  chat?: TgChat;
  from?: TgUser;
};

/** Lệnh Thu:/Chi: có thể gửi text hoặc caption ảnh (reply ảnh giao dịch). */
export function messageTextFromTelegramMessage(msg: PollTelegramMessage): string | null {
  const t = (msg.text ?? msg.caption ?? "").trim();
  return t || null;
}

/** all/thuchi = Thu:/Chi: + CONG_NO; none = bỏ qua (webhook bot Báo cáo không dùng). */
export type TelegramUpdateScope = "all" | "thuchi" | "none";

function debtSpreadsheetId(env: Env): string {
  return env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
}

function isGroupChat(chat: TgChat | undefined): boolean {
  const t = String(chat?.type ?? "");
  return t === "group" || t === "supergroup";
}

function messageFromUpdate(raw: unknown): TgMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const msg = (u.message ?? u.edited_message) as TgMessage | undefined;
  if (!msg || !messageTextFromTelegramMessage(msg)) return null;
  return msg;
}

/** Tin bot Báo cáo « TỔNG TIỀN CẦN THANH TOÁN » — bot Thu Chi trong nhóm nhận webhook → ghi CONG_NO. */
async function handleTongTienCongNo(
  env: Env,
  chatId: string,
  text: string,
  fromIsBot: boolean
): Promise<void> {
  if (!fromIsBot) return;
  const total = parseTongTienCanThanhToanTotal(text);
  if (total == null) return;

  const dealerMap = await getDealerChatMap(env.STORE);
  const maDl = resolveDealerNameForChatId(chatId, dealerMap);
  if (!maDl) return;

  try {
    const accessToken = await getAccessTokenFromEnv(env);
    await upsertCongNoDebt(
      accessToken,
      debtSpreadsheetId(env),
      env.DEBT_TAB_NAME.trim(),
      maDl,
      String(total),
    );
  } catch {
    /* không chặn poll */
  }
}

export async function handleGroupTelegramText(
  env: Env,
  chatId: string,
  text: string,
  fromIsBot: boolean,
  msg?: TgMessage,
  scope: TelegramUpdateScope = "all",
): Promise<void> {
  if (scope === "none") return;

  if (scope === "all" || scope === "thuchi") {
    const handledThuChi = await handleThuChiGroupCommand(env, chatId, text, {
      fromIsBot,
      replyTo: msg?.reply_to_message,
      unixSec: msg?.date,
    });
    if (handledThuChi) return;

    await handleTongTienCongNo(env, chatId, text, fromIsBot);
  }
}

export async function processTelegramUpdateBatch(
  env: Env,
  batch: unknown[],
  scope: TelegramUpdateScope = "all",
): Promise<void> {
  for (const raw of batch) {
    const msg = messageFromUpdate(raw);
    if (!msg || !isGroupChat(msg.chat)) continue;
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) continue;
    const text = messageTextFromTelegramMessage(msg);
    if (!text) continue;
    await handleGroupTelegramText(
      env,
      chatId,
      text,
      Boolean(msg.from?.is_bot),
      msg,
      scope,
    );
  }
}

/** Webhook bot Báo cáo: không xử lý tin nhóm (chỉ gửi). Thu Chi webhook/poll xử lý Thu:/Chi: + CONG_NO. */
export function mainWebhookScope(env: Env): TelegramUpdateScope {
  const thuChiTok = (env.TELEGRAM_THU_CHI_BOT_TOKEN ?? "").trim();
  return thuChiTok ? "none" : "all";
}

/** Một vòng getUpdates — token Thu Chi nếu có, không thì TELEGRAM_BOT_TOKEN. */
export async function pollTelegramUpdates(env: Env): Promise<void> {
  if (env.TELEGRAM_POLL_ENABLED === "0" || env.TELEGRAM_POLL_ENABLED === "false") {
    return;
  }
  const tok = thuChiBotToken(env) || env.TELEGRAM_BOT_TOKEN?.trim();
  if (!tok || !env.STORE) return;

  const scope: TelegramUpdateScope = (env.TELEGRAM_THU_CHI_BOT_TOKEN ?? "").trim()
    ? "thuchi"
    : "all";

  const lock = await env.STORE.get(KV_POLL_LOCK);
  if (lock === "1") return;
  await env.STORE.put(KV_POLL_LOCK, "1", { expirationTtl: POLL_LOCK_TTL_SEC });

  try {
    let offset = await getTelegramUpdateOffset(env.STORE);
    const { updates, nextOffset } = await fetchTelegramUpdates(tok, offset, 100);
    if (updates.length === 0) return;
    await processTelegramUpdateBatch(env, updates, scope);
    await setTelegramUpdateOffset(env.STORE, nextOffset);
  } finally {
    await env.STORE.delete(KV_POLL_LOCK);
  }
}
