import type { Env } from "./worker-lib";
import { processTelegramUpdateBatch } from "./telegram-poll";

/** Secret khớp header `X-Telegram-Bot-Api-Secret-Token` (ưu tiên TELEGRAM_WEBHOOK_SECRET, hoặc TELEGRAM_SECRET trên Dashboard). */
export function telegramWebhookSecret(env: Env): string {
  const e = env as { TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_SECRET?: string };
  return (e.TELEGRAM_WEBHOOK_SECRET ?? e.TELEGRAM_SECRET ?? "").trim();
}

/** Webhook tức thì — đăng ký setWebhook trỏ POST /api/telegram-webhook. */
export async function handleTelegramWebhookPost(
  request: Request,
  env: Env
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
    await processTelegramUpdateBatch(env, [update]);
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("telegram-webhook", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
