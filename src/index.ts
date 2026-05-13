import {
  getAccessTokenFromEnv,
  getDebtMap,
  getSheetTitles,
  readTabRows,
  writeCellH2,
  type Env,
} from "./worker-lib";
import { getDealerChatMap, resolveChatId, setDealerChatMap } from "./dealer-map";
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

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  /** 22:00 mỗi ngày theo giờ Việt Nam (ICT, UTC+7) = 15:00 UTC — enqueue / gửi công nợ (không gửi tay qua web). */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const off =
      env.DEBT_CRON_ENABLED === "0" ||
      env.DEBT_CRON_ENABLED === "false" ||
      env.DEBT_CRON_ENABLED === "off";
    if (off) return;
    ctx.waitUntil(runDebtNotifyProducer(env));
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
      const tok = env.TELEGRAM_BOT_TOKEN?.trim();
      if (!tok) {
        return json(
          {
            ok: false,
            error:
              "Chưa có TELEGRAM_BOT_TOKEN — thêm Secret trên Cloudflare Worker rồi deploy lại.",
          },
          503,
          request
        );
      }
      try {
        const { chats, rounds, updatesConsumed, warning } =
          await fetchAllGroupChatsFromTelegram(tok);
        const lines = chats.map((c) => {
          const name = c.title || c.username || "(không tên)";
          return `${name}\t${c.id}`;
        });
        return json(
          {
            ok: true,
            chats,
            tsv: lines.join("\n"),
            rounds,
            updatesConsumed,
            warning,
            note:
              "Chỉ hiện nhóm đã có ít nhất một update trong hàng đợi. Nếu thiếu nhóm — gửi tin trong nhóm đó rồi bấm lại.",
          },
          200,
          request
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status =
          /từ chối token|Chưa có TELEGRAM_BOT_TOKEN|secret trên Cloudflare/i.test(msg) ? 400 : 502;
        return json({ ok: false, error: msg }, status, request);
      }
    }

    /** Gửi chi phí: chỉ tab được tick → báo cáo đầy đủ (+ QR + H). Tin chỉ công nợ chỉ qua cron 22h VN. */
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
        linkFile?: string;
        linkFiles?: unknown[];
        selectedTabs?: string[];
      };
      const rawLinks = Array.isArray(body.linkFiles)
        ? body.linkFiles.map((x) => String(x ?? "").trim())
        : [];
      const linkFileLegacy = String(body.linkFile ?? "").trim();
      const linkFiles = rawLinks.length > 0 ? rawLinks : linkFileLegacy ? [linkFileLegacy] : [];
      const selectedTabs = Array.isArray(body.selectedTabs)
        ? body.selectedTabs.map((x) => String(x).trim()).filter(Boolean)
        : [];
      if (selectedTabs.length === 0) {
        return json({ ok: false, error: "Chọn ít nhất một tab đại lý (nhóm cần gửi)." }, 400, request);
      }

      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const allTitles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
      const allowed = new Set(allTitles.filter((t) => t !== env.DEBT_TAB_NAME));
      for (const tabName of selectedTabs) {
        const matched = [...allowed].find((t) => t.trim() === tabName);
        if (!matched) {
          return json(
            { ok: false, error: `Tab không tồn tại trong Sheet hoặc không được phép: ${tabName}` },
            400,
            request
          );
        }
      }

      ctx.waitUntil(
        broadcastDealerTabs(env, {
          skipKvDedup: true,
          linkFiles,
          selectedTabs,
          includeUnselectedDebtNotifies: false,
        })
      );
      return json(
        {
          ok: true,
          message: `Đang gửi báo cáo chi phí đầy đủ cho ${selectedTabs.length} đại lý đã chọn…`,
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

    /** Danh sách tên tab đại lý trên Sheet (trừ CONG_NO) — để tích chọn broadcast */
    if (path === "/api/sheet-tabs" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const token = await getAccessTokenFromEnv(env);
        const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
        const tabs = titles.filter((t) => t !== env.DEBT_TAB_NAME && t.trim() !== "");
        return json({ ok: true, tabs }, 200, request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /**
     * Số dòng dữ liệu (A2 trở đi, dừng khi A–G trống) trên từng tab đã chọn — để web dựng đúng số ô LINK FILE.
     * Query: lặp tham số `tabs` (mỗi tab một giá trị).
     */
    if (path === "/api/sheet-pay-row-counts" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const tabParams = url.searchParams.getAll("tabs");
      const selectedTabs = tabParams.map((x) => String(x).trim()).filter(Boolean);
      if (selectedTabs.length === 0) {
        return json({ ok: true, maxRows: 0, byTab: {} as Record<string, number> }, 200, request);
      }
      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const allTitles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
      const allowed = new Set(allTitles.filter((t) => t !== env.DEBT_TAB_NAME));
      const byTab: Record<string, number> = {};
      let maxRows = 0;
      for (const tabName of selectedTabs) {
        const matched = [...allowed].find((t) => t.trim() === tabName);
        if (!matched) {
          return json(
            { ok: false, error: `Tab không tồn tại trong Sheet hoặc không được phép: ${tabName}` },
            400,
            request
          );
        }
        const tabData = await readTabRows(token, env.MAIN_SPREADSHEET_ID, matched);
        const n = tabData.dataRows.length;
        byTab[matched] = n;
        if (n > maxRows) maxRows = n;
      }
      return json({ ok: true, maxRows, byTab }, 200, request);
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
        selectedTabs?: string[];
      };
      const ngay = String(body.ngay ?? "").trim();
      const mcc = String(body.mcc ?? "").trim();
      const maCampPrefix = String(body.maCampPrefix ?? "").trim();
      const rate = String(body.rate ?? "").trim();
      const ruleRaw = String(body.rule ?? "");
      const ruleLines = ruleRaw.split(/\r?\n/).map((l) => l.trimEnd());
      const selectedTabs = Array.isArray(body.selectedTabs)
        ? body.selectedTabs.map((x) => String(x).trim()).filter(Boolean)
        : [];

      if (!ngay || !mcc || !maCampPrefix || !rate) {
        return json(
          { ok: false, error: "Thiếu NGÀY / MCC / tiền tố MÃ CAMP / RATE" },
          400,
          request
        );
      }
      if (selectedTabs.length === 0) {
        return json({ ok: false, error: "Chọn ít nhất một tab đại lý (nhóm cần gửi)." }, 400, request);
      }

      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const allTitles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
      const allowed = new Set(allTitles.filter((t) => t !== env.DEBT_TAB_NAME));
      for (const tabName of selectedTabs) {
        if (!allowed.has(tabName)) {
          return json(
            { ok: false, error: `Tab không tồn tại trong Sheet hoặc không được phép: ${tabName}` },
            400,
            request
          );
        }
      }

      ctx.waitUntil(
        sendManualToAllChats(env, { ngay, mcc, maCampPrefix, rate, ruleLines, selectedTabs })
      );
      return json(
        {
          ok: true,
          message: `Đang gửi tới ${selectedTabs.length} nhóm đã chọn…`,
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
    selectedTabs: string[];
  }
): Promise<void> {
  const { formatManualMessage } = await import("./format");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");

  const token = await getAccessTokenFromEnv(env);
  const dealerMap = await getDealerChatMap(env.STORE);
  const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  const skip = new Set([env.DEBT_TAB_NAME]);
  const selected = new Set(input.selectedTabs);
  const prefix = input.maCampPrefix.trim();

  for (const title of titles) {
    if (skip.has(title)) continue;
    if (!selected.has(title)) continue;
    const maCamp = `${prefix} - ${title}`;
    const html = formatManualMessage({
      ngay: input.ngay,
      mcc: input.mcc,
      maCamp,
      rate: input.rate,
      ruleLines: input.ruleLines,
    });
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

/** Khớp tên tab Sheet với dòng CONG_NO; trả về đúng chuỗi cột A và giá trị cột B. */
function debtRowForDealerTab(
  debtMap: Map<string, string>,
  sheetTitle: string
): { colA: string; colBRaw: string } | null {
  const t = sheetTitle.trim();
  if (debtMap.has(t)) {
    return { colA: t, colBRaw: String(debtMap.get(t) ?? "") };
  }
  for (const [name, debt] of debtMap) {
    if (name.trim() === t) {
      return { colA: name, colBRaw: String(debt ?? "") };
    }
  }
  return null;
}

/**
 * Gửi chi phí:
 * - Tab được tick: báo cáo đầy đủ (hàng 2 + công nợ) + QR + ghi H khi gửi thành công.
 * - includeUnselectedDebtNotifies: tab không tick nhưng có nợ (CONG_NO): tin MÃ ĐL + NỢ + QR + ghim (không ghi H).
 *   Mặc định false — dùng panel « Gửi công nợ » để gửi riêng, giảm tải Worker/Telegram.
 * skipKvDedup=true: không dedupe KV trước khi gửi (chỉ áp dụng nhánh báo cáo đầy đủ).
 */
async function broadcastDealerTabs(
  env: Env,
  opts: {
    skipKvDedup: boolean;
    linkFiles: string[];
    selectedTabs?: string[];
    includeUnselectedDebtNotifies?: boolean;
  }
): Promise<void> {
  if (!env.STORE) return;

  const {
    formatSheetRowMessage,
    formatDebtOnlyNotify,
    hashPaymentDataRows,
    aggregateDealerPaymentForTelegram,
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
    debtMap = await getDebtMap(
      token,
      env.DEBT_SPREADSHEET_ID ? env.DEBT_SPREADSHEET_ID : env.MAIN_SPREADSHEET_ID,
      env.DEBT_TAB_NAME
    );
  } catch {
    debtMap = new Map();
  }

  const dealerMap = await getDealerChatMap(env.STORE);
  const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  const skip = new Set([env.DEBT_TAB_NAME]);
  const selected = new Set((opts.selectedTabs ?? []).map((x) => String(x).trim()).filter(Boolean));
  const includeUnselectedDebt = opts.includeUnselectedDebtNotifies === true;

  /** Ưu tiên tab được tick trước — tránh Worker hết thời gian/subrequest trước khi tới nhóm đã chọn. */
  const titlesOrdered = [...titles].sort((a, b) => {
    const pa = selected.has(a.trim()) ? 0 : 1;
    const pb = selected.has(b.trim()) ? 0 : 1;
    return pa - pb;
  });

  const pauseBetweenTelegram = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 55));

  for (const sheetTitle of titlesOrdered) {
    if (skip.has(sheetTitle)) continue;

    const rows = await readTabRows(token, env.MAIN_SPREADSHEET_ID, sheetTitle);
    const chatId = resolveChatId(sheetTitle, rows.chatId, dealerMap);
    const dataRows = rows.dataRows;

    if (!chatId) continue;

    const debtRow = debtRowForDealerTab(debtMap, sheetTitle);
    const debtRaw = debtRow ? debtRow.colBRaw : "";
    const debtDisplay = debtRaw.trim();
    const maDlColA = debtRow ? debtRow.colA : sheetTitle.trim();
    /** Tick chọn dùng .trim(); tên tab từ Google đôi khi có khoảng trắng → phải trim khi so khớp. */
    const isSelected = selected.has(sheetTitle.trim());

    if (!isSelected) {
      if (!includeUnselectedDebt || !debtDisplay) continue;
      const htmlDebt = formatDebtOnlyNotify({
        maDl: maDlColA,
        noCu: debtDisplay,
      });
      try {
        const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, htmlDebt);
        await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
        if (env.PAYMENT_IMAGE_URL_1) {
          await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_1);
        }
        if (env.PAYMENT_IMAGE_URL_2) {
          await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_2);
        }
      } catch {
        /* nhóm lỗi không chặn các nhóm khác */
      }
      await pauseBetweenTelegram();
      continue;
    }

    if (!debtDisplay && dataRows.length === 0) {
      await env.STORE.delete(kvKey(env.MAIN_SPREADSHEET_ID, sheetTitle));
      continue;
    }

    const h = hashPaymentDataRows(dataRows);
    const key = kvKey(env.MAIN_SPREADSHEET_ID, sheetTitle);
    const prev = await env.STORE.get(key);
    if (!opts.skipKvDedup && prev === h) continue;

    const agg = aggregateDealerPaymentForTelegram(dataRows, {
      maDl: maDlColA,
      debtRaw,
      linkFiles: opts.linkFiles,
    });

    const html = formatSheetRowMessage({
      ngay: agg.ngay,
      maDl: agg.maDl,
      mcc: agg.mcc,
      tongTieu: agg.tongTieu,
      tienTe: agg.tienTe,
      quyDoiUsd: agg.quyDoiUsd,
      rate: agg.rate,
      thucThuFromG: agg.thucThuFromG,
      congNoCu: agg.congNoCu,
      tongThu: agg.tongThu,
      linkFile: agg.linkFile,
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
        await writeCellH2(token, env.MAIN_SPREADSHEET_ID, sheetTitle, agg.tongThu);
      } catch {
        /* gửi tin đã xong; ghi Sheet H lỗi — không chặn KV */
      }
      await env.STORE.put(key, h);
    } catch {
      /* không ghi KV nếu gửi lỗi */
    }
    await pauseBetweenTelegram();
  }
}

function kvKey(spreadsheetId: string, sheetTitle: string): string {
  return `row2:${spreadsheetId}:${sheetTitle}`;
}
