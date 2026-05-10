import {
  getAccessTokenFromEnv,
  getDebtMap,
  getSheetTitles,
  readTabRows,
  writeCellH2,
  type Env,
} from "./worker-lib";
import { getDealerChatMap, resolveChatId, setDealerChatMap } from "./dealer-map";

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
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

    /** Đọc hàng 2 mọi tab đại lý → gửi Telegram + QR + ghi H (chỉ khi ấn nút trên web, không còn cron). */
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
      const body = (await request.json()) as { linkFile?: string };
      const linkFile = String(body.linkFile ?? "").trim();
      ctx.waitUntil(broadcastDealerTabs(env, { skipKvDedup: true, linkFile }));
      return json({ ok: true, message: "Đang gửi thanh toán theo dữ liệu Sheet…" }, 202, request);
    }

    if (path === "/api/send-manual" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as {
        ngay?: string;
        mcc?: string;
        maCamp?: string;
        rate?: string;
        rule?: string;
      };
      const ngay = String(body.ngay ?? "").trim();
      const mcc = String(body.mcc ?? "").trim();
      const maCamp = String(body.maCamp ?? "").trim();
      const rate = String(body.rate ?? "").trim();
      const ruleRaw = String(body.rule ?? "");
      const ruleLines = ruleRaw.split(/\r?\n/).map((l) => l.trimEnd());

      if (!ngay || !mcc || !maCamp || !rate) {
        return json({ ok: false, error: "Thiếu trường bắt buộc" }, 400, request);
      }

      ctx.waitUntil(sendManualToAllChats(env, { ngay, mcc, maCamp, rate, ruleLines }));
      return json({ ok: true, message: "Đang gửi tới các nhóm…" }, 202, request);
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
  input: { ngay: string; mcc: string; maCamp: string; rate: string; ruleLines: string[] }
): Promise<void> {
  const { formatManualMessage } = await import("./format");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");

  const token = await getAccessTokenFromEnv(env);
  const dealerMap = await getDealerChatMap(env.STORE);
  const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  const skip = new Set(["CONG_NO"]);
  const html = formatManualMessage(input);

  for (const title of titles) {
    if (skip.has(title)) continue;
    const rows = await readTabRows(token, env.MAIN_SPREADSHEET_ID, title);
    const chatId = resolveChatId(title, rows.chatId, dealerMap);
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
 * Gửi tin theo hàng 2 từng tab đại lý.
 * skipKvDedup=true (Send Thanh Toán): luôn gửi khi hàng 2 có dữ liệu.
 */
async function broadcastDealerTabs(
  env: Env,
  opts: { skipKvDedup: boolean; linkFile: string }
): Promise<void> {
  if (!env.STORE) return;

  const {
    formatSheetRowMessage,
    hashRowDataColumns,
    isRowEmpty,
    parseMoneyNumber,
    formatNumberForCell,
  } = await import("./format");
  const { sendHtmlMessage, pinMessage, sendPhotoUrl } = await import("./telegram");

  let token: string;
  try {
    token = await getAccessTokenFromEnv(env);
  } catch {
    return;
  }

  let debtMap: Map<string, string>;
  try {
    debtMap = await getDebtMap(token, env.MAIN_SPREADSHEET_ID, env.DEBT_TAB_NAME);
  } catch {
    debtMap = new Map();
  }

  const dealerMap = await getDealerChatMap(env.STORE);
  const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  const skip = new Set(["CONG_NO"]);

  for (const sheetTitle of titles) {
    if (skip.has(sheetTitle)) continue;

    const rows = await readTabRows(token, env.MAIN_SPREADSHEET_ID, sheetTitle);
    const chatId = resolveChatId(sheetTitle, rows.chatId, dealerMap);
    const r2 = rows.row2;

    if (!chatId) continue;

    if (isRowEmpty(r2)) {
      await env.STORE.delete(kvKey(env.MAIN_SPREADSHEET_ID, sheetTitle));
      continue;
    }

    const h = hashRowDataColumns(r2);
    const key = kvKey(env.MAIN_SPREADSHEET_ID, sheetTitle);
    const prev = await env.STORE.get(key);
    if (!opts.skipKvDedup && prev === h) continue;

    const [a, b, c, d, e, f, g] = r2;
    const ngay = String(a ?? "").trim();
    const mcc = String(b ?? "").trim();
    const tongTieu = String(c ?? "").trim();
    const tienTe = String(d ?? "").trim();
    const quyDoiUsd = String(e ?? "").trim();
    const rate = String(f ?? "").trim();
    const gStr = String(g ?? "").trim();

    const debtRaw = debtMap.get(sheetTitle.trim()) ?? "";
    const debtDisplay = debtRaw.trim();
    const gNum = parseMoneyNumber(gStr);
    const debtNum = parseMoneyNumber(debtRaw);
    const tongThuNum = gNum + debtNum;
    const tongThuStr = formatNumberForCell(tongThuNum);

    const html = formatSheetRowMessage({
      ngay,
      maDl: sheetTitle,
      mcc,
      tongTieu,
      tienTe,
      quyDoiUsd,
      rate,
      thucThuFromG: gStr || "",
      congNoCu: debtDisplay || "0",
      tongThu: tongThuStr,
      linkFile: opts.linkFile,
    });

    try {
      const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
      await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
      if (env.PAYMENT_IMAGE_URL_1) {
        await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_1);
      }
      if (env.PAYMENT_IMAGE_URL_2) {
        await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_2);
      }
      try {
        await writeCellH2(token, env.MAIN_SPREADSHEET_ID, sheetTitle, tongThuStr);
      } catch {
        /* gửi tin đã xong; ghi Sheet H lỗi — không chặn KV */
      }
      await env.STORE.put(key, h);
    } catch {
      /* không ghi KV nếu gửi lỗi */
    }
  }
}

function kvKey(spreadsheetId: string, sheetTitle: string): string {
  return `row2:${spreadsheetId}:${sheetTitle}`;
}
