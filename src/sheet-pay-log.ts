import type { Env } from "./worker-lib";
import { getAccessTokenFromEnv } from "./worker-lib";
import { sheetsValuesAppend } from "./google";

const KV_LOG_KEY = "sheet_pay:file_log";
const LOG_TAB_NAME = "BOT_LOG";
const MAX_LOG_LINES = 250;

export type SheetPayLogLevel = "error" | "warn" | "info";

export type SheetPayLogEntry = {
  at: string;
  level: SheetPayLogLevel;
  message: string;
  detail: Record<string, unknown>;
};

export async function readSheetPayLog(env: Env, limit = 100): Promise<SheetPayLogEntry[]> {
  if (!env.STORE) return [];
  const raw = await env.STORE.get(KV_LOG_KEY);
  if (!raw) return [];
  try {
    const lines = JSON.parse(raw) as SheetPayLogEntry[];
    if (!Array.isArray(lines)) return [];
    return lines.slice(-Math.min(limit, MAX_LOG_LINES));
  } catch {
    return [];
  }
}

/** Ghi log gửi chi phí — KV (luôn) + tab BOT_LOG trên Sheet công nợ (nếu có). */
export async function appendSheetPayLog(
  env: Env,
  level: SheetPayLogLevel,
  message: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const entry: SheetPayLogEntry = {
    at: new Date().toISOString(),
    level,
    message: message.slice(0, 2000),
    detail,
  };

  if (env.STORE) {
    const prev = await readSheetPayLog(env, MAX_LOG_LINES);
    prev.push(entry);
    const trimmed = prev.slice(-MAX_LOG_LINES);
    await env.STORE.put(KV_LOG_KEY, JSON.stringify(trimmed));
  }

  try {
    const token = await getAccessTokenFromEnv(env);
    const spreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
    const q = `'${LOG_TAB_NAME.replace(/'/g, "''")}'`;
    await sheetsValuesAppend(
      token,
      spreadsheetId,
      `${q}!A:D`,
      [[entry.at, entry.level, entry.message, JSON.stringify(entry.detail).slice(0, 4000)]],
      "USER_ENTERED",
    );
  } catch {
    /* Tab BOT_LOG có thể chưa tạo — vẫn có KV */
  }
}
