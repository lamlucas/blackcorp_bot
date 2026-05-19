import { clearCongNoDebtColumnB, upsertCongNoDebt } from "./cong-no-sheet";
import { getDealerChatMap, resolveDealerNameForChatId } from "./dealer-map";
import {
  amountMatchesCongNoDebt,
  getCongNoColumnBForCustomerD,
  parseThuCommand,
  parseTongTienCanThanhToanTotal,
} from "./format";
import { getAccessTokenFromEnv, getDebtMap, type Env } from "./worker-lib";
import { sendPlainMessage } from "./telegram";
import {
  getTelegramUpdateOffset,
  fetchTelegramUpdates,
  setTelegramUpdateOffset,
} from "./telegram-updates";

const DA_NHAN_THONG_TIN = "Đã nhận thông tin";
const KV_POLL_LOCK = "telegram:poll_lock";
const POLL_LOCK_TTL_SEC = 90;

type TgUser = { id?: number; is_bot?: boolean };
type TgChat = { id?: number; type?: string };
type TgMessage = {
  text?: string;
  chat?: TgChat;
  from?: TgUser;
};

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
  return msg?.text ? msg : null;
}

/** Xử lý một tin nhóm: Thu: (số tiền - Mã ĐL) và TỔNG TIỀN CẦN THANH TOÁN. */
export async function handleGroupTelegramText(
  env: Env,
  chatId: string,
  text: string,
  fromIsBot: boolean
): Promise<void> {
  const tok = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!tok) return;

  const thu = parseThuCommand(text);
  if (thu && !fromIsBot) {
    try {
      await sendPlainMessage(tok, chatId, DA_NHAN_THONG_TIN);
    } catch {
      return;
    }

    try {
      const accessToken = await getAccessTokenFromEnv(env);
      const debtMap = await getDebtMap(
        accessToken,
        debtSpreadsheetId(env),
        env.DEBT_TAB_NAME.trim()
      );
      const bDebt = getCongNoColumnBForCustomerD(debtMap, thu.maDl);
      if (amountMatchesCongNoDebt(thu.amount, bDebt, 2)) {
        await clearCongNoDebtColumnB(
          accessToken,
          debtSpreadsheetId(env),
          env.DEBT_TAB_NAME.trim(),
          thu.maDl
        );
      }
    } catch {
      /* không chặn poll */
    }
    return;
  }

  const total = parseTongTienCanThanhToanTotal(text);
  if (!total) return;

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
      total
    );
  } catch {
    /* không chặn poll */
  }
}

export async function processTelegramUpdateBatch(env: Env, batch: unknown[]): Promise<void> {
  for (const raw of batch) {
    const msg = messageFromUpdate(raw);
    if (!msg || !isGroupChat(msg.chat)) continue;
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) continue;
    await handleGroupTelegramText(
      env,
      chatId,
      msg.text!,
      Boolean(msg.from?.is_bot)
    );
  }
}

/** Một vòng getUpdates (offset lưu KV) — dùng cron, không dùng webhook. */
export async function pollTelegramUpdates(env: Env): Promise<void> {
  if (env.TELEGRAM_POLL_ENABLED === "0" || env.TELEGRAM_POLL_ENABLED === "false") {
    return;
  }
  const tok = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!tok || !env.STORE) return;

  const lock = await env.STORE.get(KV_POLL_LOCK);
  if (lock === "1") return;
  await env.STORE.put(KV_POLL_LOCK, "1", { expirationTtl: POLL_LOCK_TTL_SEC });

  try {
    let offset = await getTelegramUpdateOffset(env.STORE);
    const { updates, nextOffset } = await fetchTelegramUpdates(tok, offset, 100);
    if (updates.length === 0) return;
    await processTelegramUpdateBatch(env, updates);
    await setTelegramUpdateOffset(env.STORE, nextOffset);
  } finally {
    await env.STORE.delete(KV_POLL_LOCK);
  }
}
