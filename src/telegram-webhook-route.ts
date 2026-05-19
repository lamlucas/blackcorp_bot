import type { Env } from "./worker-lib";
import {
  mainWebhookScope,
  processTelegramUpdateBatch,
  type TelegramUpdateScope,
} from "./telegram-poll";

/** Secret khớp header `X-Telegram-Bot-Api-Secret-Token` (ưu tiên TELEGRAM_WEBHOOK_SECRET, hoặc TELEGRAM_SECRET trên Dashboard). */
export function telegramWebhookSecret(env: Env): string {
  const e = env as { TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_SECRET?: string };
  return (e.TELEGRAM_WEBHOOK_SECRET ?? e.TELEGRAM_SECRET ?? "").trim();
}

async function handleTelegramWebhookPostScoped(
  request: Request,
  env: Env,
  scope: TelegramUpdateScope,
  logTag: string,
): Promise<Response> {
  const secret = telegramWebhookSecret(env);
  if (secret) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (got !== secret) {
      return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  try {
    await processTelegramUpdateBatch(env, [update], scope);
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(logTag, msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** Webhook bot Báo cáo (tùy chọn) — không xử lý khi đã có TELEGRAM_THU_CHI_BOT_TOKEN */
export async function handleTelegramWebhookPost(
  request: Request,
  env: Env,
): Promise<Response> {
  return handleTelegramWebhookPostScoped(request, env, mainWebhookScope(env), "telegram-webhook");
}

/** Webhook bot Thu Chi — Thu:/Chi: → THU_CHI; tin Báo cáo « TỔNG TIỀN… » → CONG_NO */
export async function handleTelegramThuChiWebhookPost(
  request: Request,
  env: Env,
): Promise<Response> {
  return handleTelegramWebhookPostScoped(request, env, "thuchi", "telegram-thu-chi-webhook");
}
