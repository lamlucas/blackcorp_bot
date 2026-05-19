import {
  getAccessTokenFromEnv,
  getDebtMap,
  getDebtRowsOrdered,
  getSheetTitles,
  type Env,
} from "./worker-lib";
import {
  getDealerChatMap,
  setDealerChatMap,
  resolveChatIdForCustomerNameColumnD,
} from "./dealer-map";
import { runDebtNotifyProducer, type DebtNotifyJob } from "./debt-queue";
import { getLatestDebtNotifyRun, recordDebtSentOk } from "./debt-notify-status";
import { fetchAllGroupChatsFromTelegram } from "./telegram-chats";
import { parseKetQuaDefaultsFromEnv, runKetQuaJob, type KetQuaRunInput } from "./ket-qua";

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (
      url.pathname === "/api/telegram-webhook" ||
      url.pathname === "/api/telegram-thu-chi-webhook"
    ) {
      const isThuChi = url.pathname === "/api/telegram-thu-chi-webhook";
      if (request.method === "GET") {
        return new Response(
          isThuChi ? "Telegram Thu Chi webhook (POST)" : "Telegram webhook (POST)",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
      if (request.method === "POST") {
        const route = await import("./telegram-webhook-route");
        return isThuChi
          ? route.handleTelegramThuChiWebhookPost(request, env)
          : route.handleTelegramWebhookPost(request, env);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    /** getUpdates mỗi 2 phút — chỉ khi TELEGRAM_POLL_ENABLED ≠ "0" (bật webhook thì đặt "0"). */
    if (event.cron === "*/2 * * * *") {
      const pollOff =
        env.TELEGRAM_POLL_ENABLED === "0" ||
        env.TELEGRAM_POLL_ENABLED === "false" ||
        env.TELEGRAM_POLL_ENABLED === "off";
      if (!pollOff) {
        const { pollTelegramUpdates } = await import("./telegram-poll");
        ctx.waitUntil(pollTelegramUpdates(env));
      }
      return;
    }

    if (event.cron === "0 15 * * *") {
      const off =
        env.DEBT_CRON_ENABLED === "0" ||
        env.DEBT_CRON_ENABLED === "false" ||
        env.DEBT_CRON_ENABLED === "off";
      if (!off) ctx.waitUntil(runDebtNotifyProducer(env));
    }
  },

  /** Consumer: mỗi lần tối đa `max_batch_size` tin (wrangler), retry khi Telegram lỗi tạm thời. */
  async queue(batch: MessageBatch<DebtNotifyJob>, env: Env): Promise<void> {
    const { deliverDebtNotifyJob } = await import("./debt-queue");
    const pauseBetweenTelegram = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 55));

    for (const msg of batch.messages) {
      try {
        await deliverDebtNotifyJob(env, msg.body);
        try {
          await recordDebtSentOk(env, msg.body.runId, msg.body.maDl);
        } catch {
          /* không chặn ack — tránh kẹt queue khi KV lỗi */
        }
        msg.ack();
      } catch {
        msg.retry();
      }
      await pauseBetweenTelegram();
    }
  },
};

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cookie",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === "/api/login" && request.method === "POST") {
      const body = (await request.json()) as { username?: string; password?: string };
      const expectedUser = (env.ADMIN_USERNAME ?? "Black7777").trim();
      const gotUser = String(body.username ?? "").trim();
      const gotPass = String(body.password ?? "");
      if (!env.PASSWORD) {
        return json(
          { ok: false, error: "Chưa cấu hình mật khẩu (đặt secret PASSWORD trên Cloudflare)" },
          503,
          request
        );
      }
      if (gotUser !== expectedUser || gotPass !== env.PASSWORD) {
        return json({ ok: false, error: "Sai tài khoản hoặc mật khẩu" }, 401, request);
      }
      const token = await createSession(env.SESSION_SECRET);
      return json(
        { ok: true },
        200,
        request,
        {
          "Set-Cookie": `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`,
        }
      );
    }

    if (path === "/api/logout" && request.method === "POST") {
      return json(
        { ok: true },
        200,
        request,
        {
          "Set-Cookie": `session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        }
      );
    }

    if (path === "/api/me" && request.method === "GET") {
      const ok = await verifySessionCookie(request, env.SESSION_SECRET);
      return json({ ok }, ok ? 200 : 401, request);
    }

    if (path === "/api/dealer-map" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const map = await getDealerChatMap(env.STORE);
      return json({ ok: true, map }, 200, request);
    }

    if (path === "/api/dealer-map" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      if (!env.STORE) {
        return json(
          {
            ok: false,
            error:
              "Worker chưa có KV binding STORE — không thể lưu. Vào Cloudflare → Worker → Settings → Variables/KV → Add binding → KV namespace tên STORE (hoặc cập nhật wrangler.toml và deploy).",
          },
          503,
          request
        );
      }
      const body = (await request.json()) as { map?: Record<string, string> };
      const raw = body.map ?? {};
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        const name = String(k ?? "").trim();
        const chat = String(v ?? "").trim();
        if (!name) continue;
        cleaned[name] = chat;
      }
      await setDealerChatMap(env.STORE, cleaned);
      return json({ ok: true, map: cleaned }, 200, request);
    }

    /**
     * Gom mọi group/supergroup xuất hiện trong getUpdates (đã thêm bot vào nhóm + có hoạt động).
     * Lưu ý: làm trống hàng đợi update; không dùng khi bot đang bật Webhook.
     */
    if (path === "/api/telegram-group-chats" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập — đăng nhập lại." }, 401, request);
      }
      const { thuChiBotToken } = await import("./thu-chi-hub");
      const { getKnownGroupChats } = await import("./telegram-group-cache");
      const tok = thuChiBotToken(env) || env.TELEGRAM_BOT_TOKEN?.trim();
      if (!tok) {
        return json(
          {
            ok: false,
            error:
              "Chưa có TELEGRAM_THU_CHI_BOT_TOKEN — thêm Secret bot Thu Chi trên Cloudflare.",
          },
          503,
          request
        );
      }
      try {
        const { fetchGroupChatsWithTemporaryWebhookOff } = await import("./telegram-chats");
        const { getWebhookInfo } = await import("./telegram");
        const { telegramWebhookSecret } = await import("./telegram-webhook-route");

        const byId = new Map<number, import("./telegram-chats").GroupChatRow>();
        for (const c of await getKnownGroupChats(env.STORE)) byId.set(c.id, c);

        let rounds = 0;
        let updatesConsumed = 0;
        let scanWarning: string | undefined;
        let usedWebhookBypass = false;

        let thuChiWebhookUrl = "";
        try {
          thuChiWebhookUrl = (await getWebhookInfo(tok)).url?.trim() ?? "";
        } catch {
          /* ignore */
        }

        const requestOrigin = new URL(request.url).origin;
        const restoreWebhookUrl =
          thuChiWebhookUrl ||
          `${requestOrigin}/api/telegram-thu-chi-webhook`;

        try {
          const scanned = await fetchAllGroupChatsFromTelegram(tok, {
            store: env.STORE,
            persistOffset: false,
          });
          rounds = scanned.rounds;
          updatesConsumed = scanned.updatesConsumed;
          scanWarning = scanned.warning;
          scanned.chats.forEach((c) => byId.set(c.id, c));
        } catch (scanErr) {
          const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
          if (/webhook/i.test(msg)) {
            try {
              const bypassed = await fetchGroupChatsWithTemporaryWebhookOff(tok, {
                store: env.STORE,
                restoreWebhookUrl,
                secretToken: telegramWebhookSecret(env),
              });
              usedWebhookBypass = bypassed.webhookWasCleared;
              rounds = bypassed.rounds;
              updatesConsumed = bypassed.updatesConsumed;
              scanWarning = bypassed.warning;
              bypassed.chats.forEach((c) => byId.set(c.id, c));
              if (bypassed.chats.length > 0) {
                scanWarning =
                  "Đã tạm gỡ webhook, quét getUpdates, rồi bật lại webhook." +
                  (scanWarning ? ` ${scanWarning}` : "");
              }
            } catch (bypassErr) {
              scanWarning = bypassErr instanceof Error ? bypassErr.message : String(bypassErr);
            }
          } else {
            scanWarning = msg;
          }
        }

        const chats = [...byId.values()].sort((a, b) =>
          (a.title || String(a.id)).localeCompare(b.title || String(b.id), "vi", {
            sensitivity: "base",
          })
        );
        const lines = chats.map((c) => {
          const name = c.title || c.username || "(không tên)";
          return `${name}\t${c.id}`;
        });

        const webhookHost = thuChiWebhookUrl ? new URL(thuChiWebhookUrl).host : "";
        const panelHost = new URL(request.url).host;
        const hostMismatch =
          Boolean(webhookHost && panelHost && webhookHost !== panelHost);

        let warning =
          scanWarning ||
          (chats.length === 0
            ? "Chưa thấy nhóm. Gửi tin trong nhóm (bot Thu Chi trong nhóm), bấm lại; hoặc nhập Chat ID tay ở tab Đại lý."
            : undefined);

        if (hostMismatch) {
          const hostNote = `Webhook đang trỏ ${webhookHost}, panel mở ${panelHost} — chạy setup-telegram-bots.ps1 với WORKER_URL=${requestOrigin}.`;
          warning = warning ? `${warning} ${hostNote}` : hostNote;
        }

        return json(
          {
            ok: true,
            chats,
            tsv: lines.join("\n"),
            rounds,
            updatesConsumed,
            usedWebhookBypass,
            thuChiWebhookUrl: thuChiWebhookUrl || undefined,
            hostMismatch,
            warning,
            note: usedWebhookBypass
              ? "Đã tạm gỡ webhook để quét — không xử lý lại Thu/Chi."
              : "Nhóm lưu từ webhook + quét. Bấm nút không chạy lại lệnh Thu/Chi.",
          },
          200,
          request
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status =
          /từ chối token|TELEGRAM_THU_CHI|secret trên Cloudflare/i.test(msg) ? 400 : 502;
        return json({ ok: false, error: msg }, status, request);
      }
    }

    if (path === "/api/telegram-bot-status" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const { fetchTelegramBotsStatus } = await import("./telegram-webhook-route");
        const status = await fetchTelegramBotsStatus(env);
        const thuChiOk = Boolean(
          status.thuChi?.webhookUrl.includes("telegram-thu-chi-webhook"),
        );
        const baocaoOk = !status.baocao.webhookUrl;
        return json(
          {
            ok: true,
            ...status,
            checks: {
              thuChiWebhookOk: thuChiOk,
              baocaoWebhookCleared: baocaoOk,
            },
            hint: !thuChiOk
              ? "Chạy scripts/setup-telegram-bots.ps1 — webhook chỉ trên bot Thu Chi."
              : !baocaoOk
                ? "Gỡ webhook bot Báo cáo (scripts/remove-telegram-webhook.ps1)."
                : null,
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Gửi chi phí: tab BAO_CAO_TK (DEBT_SPREADSHEET_ID), lọc theo NGÀY panel; LINK FILE = cột M. */
    if (path === "/api/send-sheet-payment" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      if (!env.STORE) {
        return json(
          {
            ok: false,
            error:
              "Thiếu KV STORE — không thể ghi trạng thái sau khi gửi. Thêm binding STORE trên Worker.",
          },
          503,
          request
        );
      }
      const body = (await request.json()) as {
        dates?: unknown[];
        filterDates?: unknown[];
        linkFiles?: unknown[];
      };
      const rawDates = Array.isArray(body.dates)
        ? body.dates
        : Array.isArray(body.filterDates)
          ? body.filterDates
          : Array.isArray(body.linkFiles)
            ? body.linkFiles
            : [];
      const { parseFilterDatesFromPanel, BAO_CAO_TK_TAB_NAME } = await import("./bao-cao-tk");
      const filterDates = parseFilterDatesFromPanel(rawDates);

      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
      const allTitles = await getSheetTitles(token, debtSpreadsheetId);
      if (filterDates.length === 0) {
        return json(
          {
            ok: false,
            error:
              "Điền ít nhất một ô NGÀY (khớp cột A tab BAO_CAO_TK, ví dụ 14/05/2026).",
          },
          400,
          request
        );
      }
      if (!allTitles.includes(BAO_CAO_TK_TAB_NAME)) {
        return json(
          {
            ok: false,
            error: `Bảng công nợ không có tab ${BAO_CAO_TK_TAB_NAME}. Tạo tab đúng tên trên Sheet.`,
          },
          400,
          request
        );
      }

      ctx.waitUntil(
        broadcastDealerTabs(env, {
          skipKvDedup: true,
          filterDates,
        })
      );
      return json(
        {
          ok: true,
          message: `Đang gửi chi phí: ${filterDates.length} ngày (${filterDates.join(", ")}) — tab BAO_CAO_TK…`,
          filterDates,
        },
        202,
        request
      );
    }

    /** Trạng thái lần gửi công nợ gần nhất (ghi KV khi cron chạy / consumer xử lý). */
    if (path === "/api/debt-notify-status" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      if (!env.STORE) {
        return json(
          { ok: false, error: "Thiếu KV STORE — không lưu được trạng thái gửi công nợ." },
          503,
          request
        );
      }
      const run = await getLatestDebtNotifyRun(env);
      return json({ ok: true, run }, 200, request);
    }

    /** Đọc A2:B tab CONG_NO trên DEBT_SPREADSHEET_ID (hoặc MAIN) — dùng panel « Công nợ ». */
    if (path === "/api/cong-no-preview" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const spreadsheetId = env.DEBT_SPREADSHEET_ID
        ? env.DEBT_SPREADSHEET_ID.trim()
        : env.MAIN_SPREADSHEET_ID.trim();
      const tabName = env.DEBT_TAB_NAME.trim();
      let rows: { maDl: string; noCu: string }[];
      try {
        const raw = await getDebtRowsOrdered(token, spreadsheetId, tabName);
        rows = raw.map((r) => ({ maDl: r.maDl, noCu: r.noCuDisplay }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
      return json(
        {
          ok: true,
          spreadsheetId,
          tabName,
          rows,
        },
        200,
        request
      );
    }

    /** JSON mặc định từ secret KET_QUA_DEFAULTS_JSON (API GET — tùy chọn, không gắn với form web). */
    if (path === "/api/ket-qua-defaults-json" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const defaults = parseKetQuaDefaultsFromEnv(env);
        return json({ ok: true, defaults, hasDefaults: defaults != null }, 200, request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Chạy tổng hợp KET_QUA (logic giống GoogleSheet_KET_QUA / main.py). */
    if (path === "/api/run-ket-qua" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as Partial<KetQuaRunInput>;
      const spreadsheetUrlOrId = String(body.spreadsheetUrlOrId ?? "").trim();
      if (!spreadsheetUrlOrId) {
        return json({ ok: false, error: "Nhập link hoặc Spreadsheet ID." }, 400, request);
      }
      const campaignCol = String(body.campaignCol ?? "").trim();
      const costCol = String(body.costCol ?? "").trim();
      const currencyCol = String(body.currencyCol ?? "").trim();
      if (!campaignCol || !costCol || !currencyCol) {
        return json(
          {
            ok: false,
            error: "Link Sheet, cột chiến dịch, cột chi phí và cột đơn vị tiền tệ không được bỏ trống.",
          },
          400,
          request
        );
      }
      const input: KetQuaRunInput = {
        spreadsheetUrlOrId,
        campaignCol,
        costCol,
        currencyCol,
        cap1Code: String(body.cap1Code ?? "").trim(),
        cap2Codes: String(body.cap2Codes ?? "").trim(),
        accountNameCol: String(body.accountNameCol ?? "").trim(),
        accountName: String(body.accountName ?? "").trim(),
      };
      try {
        const { message } = await runKetQuaJob(env, input);
        return json({ ok: true, message }, 200, request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    if (path === "/api/send-manual" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as {
        ngay?: string;
        mcc?: string;
        maCampPrefix?: string;
        rate?: string;
        rule?: string;
        selectedDealers?: string[];
      };
      const ngay = String(body.ngay ?? "").trim();
      const mcc = String(body.mcc ?? "").trim();
      const maCampPrefix = String(body.maCampPrefix ?? "").trim();
      const rate = String(body.rate ?? "").trim();
      const ruleRaw = String(body.rule ?? "");
      const ruleLines = ruleRaw.split(/\r?\n/).map((l) => l.trimEnd());
      const selectedDealers = Array.isArray(body.selectedDealers)
        ? body.selectedDealers.map((x) => String(x).trim()).filter(Boolean)
        : [];

      if (!ngay || !mcc || !maCampPrefix || !rate) {
        return json(
          { ok: false, error: "Thiếu NGÀY / MCC / tiền tố MÃ CAMP / RATE" },
          400,
          request
        );
      }
      if (selectedDealers.length === 0) {
        return json({ ok: false, error: "Chọn ít nhất một đại lý (nhóm cần gửi)." }, 400, request);
      }

      const dealerMap = await getDealerChatMap(env.STORE);
      for (const name of selectedDealers) {
        const chatId = resolveChatIdForCustomerNameColumnD(name, dealerMap);
        if (!chatId) {
          return json(
            {
              ok: false,
              error: `Đại lý không có trong « Đại lý & Chat ID » hoặc thiếu Chat ID: ${name}`,
            },
            400,
            request
          );
        }
      }

      ctx.waitUntil(
        sendManualToAllChats(env, { ngay, mcc, maCampPrefix, rate, ruleLines, selectedDealers })
      );
      return json(
        {
          ok: true,
          message: `Đang gửi tới ${selectedDealers.length} nhóm đã chọn…`,
        },
        202,
        request
      );
    }

    return json({ ok: false, error: "Not found" }, 404, request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: msg }, 500, request);
  }
}

function json(
  data: unknown,
  status: number,
  request: Request,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(request),
    ...extraHeaders,
  });
  return new Response(JSON.stringify(data), { status, headers });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createSession(secret: string): Promise<string> {
  const exp = Date.now() + 7 * 86400000;
  const payload = String(exp);
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySessionCookie(request: Request, secret: string): Promise<boolean> {
  const cookie = request.headers.get("Cookie") || "";
  const m = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
  if (!m) return false;
  const raw = decodeURIComponent(m[1]);
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return false;
  const expected = await hmacSha256Hex(secret, payload);
  if (sig !== expected) return false;
  if (Number(payload) < Date.now()) return false;
  return true;
}

async function sendManualToAllChats(
  env: Env,
  input: {
    ngay: string;
    mcc: string;
    maCampPrefix: string;
    rate: string;
    ruleLines: string[];
    selectedDealers: string[];
  }
): Promise<void> {
  const { formatManualMessage } = await import("./format");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");

  const dealerMap = await getDealerChatMap(env.STORE);
  const prefix = input.maCampPrefix.trim();

  for (const dealerName of input.selectedDealers) {
    const maCamp = `${prefix} - ${dealerName}`;
    const html = formatManualMessage({
      ngay: input.ngay,
      mcc: input.mcc,
      maCamp,
      rate: input.rate,
      ruleLines: input.ruleLines,
    });
    const chatId = resolveChatIdForCustomerNameColumnD(dealerName, dealerMap);
    if (!chatId) continue;
    try {
      const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
      await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
    } catch {
      /* một nhóm lỗi không chặn các nhóm khác */
    }
  }
}

/**
 * Gửi chi phí: tab BAO_CAO_TK (DEBT_SPREADSHEET_ID), lọc cột A theo NGÀY panel.
 * Mỗi dòng → nhóm map cột D. TỔNG THU = cột I; LINK FILE = cột M; CÔNG NỢ = CONG_NO B (A=D).
 * « TỔNG TIỀN CẦN THANH TOÁN » = Σ cột I (cùng D, cùng ngày đã chọn) + công nợ; rồi QR.
 */
async function broadcastDealerTabs(
  env: Env,
  opts: {
    skipKvDedup: boolean;
    filterDates: string[];
  }
): Promise<void> {
  if (!env.STORE) return;

  const {
    formatSheetPaymentRowMessage,
    formatTongTienCanThanhToanMessage,
    formatMoneyForThanhToanLine,
    getCongNoColumnBForCustomerD,
    congNoColumnBForDealerName,
    parseMoneyNumber,
    sumTongThuColumnIInRows,
  } = await import("./format");
  const {
    BAO_CAO_TK_TAB_NAME,
    BAO_CAO_COL,
    readBaoCaoTkSheetRows,
    filterBaoCaoSheetRowsByDates,
    hashBaoCaoTkRowSnapshot,
  } = await import("./bao-cao-tk");
  const { sendHtmlMessage, pinMessage, sendPhotoUrl } = await import("./telegram");

  let token: string;
  try {
    token = await getAccessTokenFromEnv(env);
  } catch {
    return;
  }

  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID
    ? env.DEBT_SPREADSHEET_ID.trim()
    : env.MAIN_SPREADSHEET_ID.trim();

  let debtMap: Map<string, string>;
  try {
    debtMap = await getDebtMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  } catch {
    debtMap = new Map();
  }

  const dealerMap = await getDealerChatMap(env.STORE);

  let allEntries: Awaited<ReturnType<typeof readBaoCaoTkSheetRows>>;
  try {
    allEntries = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
  } catch {
    return;
  }

  const dataRows = filterBaoCaoSheetRowsByDates(allEntries, opts.filterDates);
  if (dataRows.length === 0) return;

  const pauseBetweenTelegram = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 55));

  const footerOrder: string[] = [];
  const footerByKey = new Map<string, { chatId: string; customerD: string }>();

  for (const entry of dataRows) {
    const row = entry.cells;
    const sheetRow = entry.sheetRow1Based;
    const rowHash = hashBaoCaoTkRowSnapshot(row);
    const kvK = kvPayRowKey(debtSpreadsheetId, BAO_CAO_TK_TAB_NAME, sheetRow, rowHash);
    if (!opts.skipKvDedup) {
      const prev = await env.STORE.get(kvK);
      if (prev === "1") continue;
    }

    const customerD = String(row[BAO_CAO_COL.TEN_KHACH] ?? "").trim();
    const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
    if (!chatId) continue;
    const congNoCu = congNoColumnBForDealerName(debtMap, customerD);
    const tongThuDisplay = String(row[BAO_CAO_COL.TONG_THU] ?? "").trim() || "0";
    const linkFile = String(row[BAO_CAO_COL.LINK_FILE] ?? "").trim();

    const html = formatSheetPaymentRowMessage({
      ngay: entry.panelNgay,
      mcc: String(row[BAO_CAO_COL.MCC] ?? "").trim(),
      taiKhoan: String(row[BAO_CAO_COL.TAI_KHOAN] ?? "").trim(),
      maDlTenKhach: customerD,
      rate: String(row[BAO_CAO_COL.RATE] ?? "").trim(),
      tongTieu: String(row[BAO_CAO_COL.TONG_TIEU] ?? "").trim(),
      tienTe: String(row[BAO_CAO_COL.TIEN_TE] ?? "").trim(),
      quyDoiUsd: String(row[BAO_CAO_COL.QUY_DOI_USD] ?? "").trim(),
      congNoCu,
      tongThu: tongThuDisplay,
      linkFile,
    });

    try {
      const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
      await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
      const dNorm = customerD.trim().toLowerCase();
      if (dNorm) {
        const fk = `${chatId}\x1e${dNorm}`;
        if (!footerByKey.has(fk)) {
          footerOrder.push(fk);
          footerByKey.set(fk, { chatId, customerD });
        }
      }
      await env.STORE.put(kvK, "1");
    } catch {
      /* không ghi KV nếu gửi lỗi */
    }
    await pauseBetweenTelegram();
  }

  for (const fk of footerOrder) {
    const foot = footerByKey.get(fk);
    if (!foot) continue;
    const { chatId, customerD } = foot;
    const sumI = sumTongThuColumnIInRows(
      dataRows.map((e) => e.cells),
      customerD,
    );
    const bDebt = getCongNoColumnBForCustomerD(debtMap, customerD);
    const debtNum = bDebt != null ? parseMoneyNumber(bDebt) : 0;
    const total = sumI + debtNum;
    const htmlThanhToan = formatTongTienCanThanhToanMessage({
      sumI: formatMoneyForThanhToanLine(sumI),
      congNo: formatMoneyForThanhToanLine(debtNum),
      total: formatMoneyForThanhToanLine(total),
    });
    const totalDisplay = formatMoneyForThanhToanLine(total);
    try {
      await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, htmlThanhToan);
      await pauseBetweenTelegram();
      try {
        const { upsertCongNoDebt } = await import("./cong-no-sheet");
        await upsertCongNoDebt(
          token,
          debtSpreadsheetId,
          env.DEBT_TAB_NAME.trim(),
          customerD,
          totalDisplay
        );
      } catch {
        /* gửi tin đã xong; ghi CONG_NO lỗi không hoàn tác Telegram */
      }
      if (env.PAYMENT_IMAGE_URL_1?.trim()) {
        await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_1);
        await pauseBetweenTelegram();
      }
    } catch {
      /* tin tổng / QR lỗi không hoàn tác tin chi phí đã gửi */
    }
  }
}

function kvPayRowKey(
  spreadsheetId: string,
  sheetTitle: string,
  sheetRow1Based: number,
  rowHash: string
): string {
  return `payrow:${spreadsheetId}:${sheetTitle}:r${sheetRow1Based}:${rowHash}`;
}
