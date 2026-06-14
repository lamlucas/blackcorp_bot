import type { Env } from "./worker-lib";
import { getTelegramBotIdentity } from "./telegram";
import { hasSeparateThuChiBot, thuChiBotToken } from "./thu-chi-hub";
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

/** Webhook bot Báo cáo — bỏ qua khi đã tách bot (chỉ gửi tin). /mail qua bot Thu Chi. */
export async function handleTelegramWebhookPost(
  request: Request,
  env: Env,
): Promise<Response> {
  if (hasSeparateThuChiBot(env)) {
    const secret = telegramWebhookSecret(env);
    if (secret) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (got !== secret) {
        return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
      }
    }
    return Response.json({
      ok: true,
      skipped: true,
      hint: "Webhook bot Bao cao khong nhan tin. /mail va Thu/Chi qua bot Thu Chi (telegram-thu-chi-webhook).",
    });
  }
  return handleTelegramWebhookPostScoped(request, env, mainWebhookScope(env), "telegram-webhook");
}

/** Webhook bot Thu Chi — Thu:/Chi: → THU_CHI; tin bot Báo cáo « TỔNG TIỀN… » → CONG_NO */
export async function handleTelegramThuChiWebhookPost(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!thuChiBotToken(env)) {
    return Response.json(
      {
        ok: false,
        error:
          "Thiếu TELEGRAM_THU_CHI_BOT_TOKEN trên Cloudflare. Thêm secret token bot Black Corp - Thu Chi.",
      },
      { status: 503 },
    );
  }
  return handleTelegramWebhookPostScoped(request, env, "thuchi", "telegram-thu-chi-webhook");
}

/** Kiểm tra getMe + getWebhookInfo (panel admin). */
export async function fetchTelegramBotsStatus(env: Env): Promise<{
  baocao: { identity: Awaited<ReturnType<typeof getTelegramBotIdentity>>; webhookUrl: string };
  thuChi: {
    identity: Awaited<ReturnType<typeof getTelegramBotIdentity>>;
    webhookUrl: string;
  } | null;
  expectedThuChiWebhookPath: string;
}> {
  async function webhookUrl(token: string): Promise<string> {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = (await res.json()) as { result?: { url?: string } };
    return String(data.result?.url ?? "");
  }

  const baocaoTok = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const thuChiTok = thuChiBotToken(env);
  if (!baocaoTok) throw new Error("Thiếu TELEGRAM_BOT_TOKEN");

  const baocao = {
    identity: await getTelegramBotIdentity(baocaoTok),
    webhookUrl: await webhookUrl(baocaoTok),
  };
  const thuChi = thuChiTok
    ? {
        identity: await getTelegramBotIdentity(thuChiTok),
        webhookUrl: await webhookUrl(thuChiTok),
      }
    : null;

  return {
    baocao,
    thuChi,
    expectedThuChiWebhookPath: "/api/telegram-thu-chi-webhook",
  };
}
