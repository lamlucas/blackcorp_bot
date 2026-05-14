import {
  getAccessTokenFromEnv,
  getDebtMap,
  getDebtRowsOrdered,
  getSheetTitles,
  readTabRows,
  writeSheetCell,
  TINH_TIEN_TAB_NAMES,
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

    /** Gửi chi phí: tab TINH_TIEN1…6 trên MAIN_SPREADSHEET_ID, mỗi dòng một tin (+ QR + ghi J). */
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
      };
      const rawLinks = Array.isArray(body.linkFiles)
        ? body.linkFiles.map((x) => String(x ?? "").trim())
        : [];
      const linkFileLegacy = String(body.linkFile ?? "").trim();
      const merged = rawLinks.length > 0 ? rawLinks : linkFileLegacy ? [linkFileLegacy] : [];
      const linkFiles: string[] = [];
      for (let i = 0; i < TINH_TIEN_TAB_NAMES.length; i++) {
        linkFiles.push(String(merged[i] ?? "").trim());
      }

      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const allTitles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
      if (!linkFiles.some((x) => x.trim())) {
        return json(
          {
            ok: false,
            error:
              "Điền ít nhất một ô LINK FILE — bot chỉ đọc tab TINH_TIEN tương ứng có link (trên Sheet chi phí).",
          },
          400,
          request
        );
      }
      const hasAnyTab = TINH_TIEN_TAB_NAMES.some((t) => allTitles.includes(t));
      if (!hasAnyTab) {
        return json(
          {
            ok: false,
            error:
              "Sheet chi phí không có tab TINH_TIEN1…TINH_TIEN6. Tạo tab đúng tên trên file.",
          },
          400,
          request
        );
      }

      ctx.waitUntil(
        broadcastDealerTabs(env, {
          skipKvDedup: true,
          linkFiles,
        })
      );
      return json(
        {
          ok: true,
          message:
            "Đang gửi chi phí: tab có LINK FILE; mỗi dòng gửi nhóm theo tên cột D trùng form Đại lý & Chat ID…",
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
 * Gửi chi phí: chỉ đọc tab TINH_TIEN có LINK FILE; dữ liệu từ dòng 2 (dòng 1 tiêu đề).
 * Mỗi dòng: Chat ID = map « Đại lý » khớp cột D. CÔNG NỢ = cột B CONG_NO khi A = D.
 * TỔNG THU = parse(B đó) + Σ cột I mọi tab TINH_TIEN có LINK FILE (dòng có D trùng), chỉ khi A CONG_NO khớp D và B có giá trị; ghi J = TỔNG THU.
 * Sau ảnh QR (nếu có) gửi thành công: tin « TỔNG TIỀN CẦN THANH TOÁN » = Σ cột I mọi dòng cùng D (một hoặc nhiều tab) + công nợ B (CONG_NO, A=D; không có dòng/không B thì +0); mỗi tên D tối đa một tin phụ mỗi lần chạy.
 */
async function broadcastDealerTabs(
  env: Env,
  opts: {
    skipKvDedup: boolean;
    linkFiles: string[];
  }
): Promise<void> {
  if (!env.STORE) return;

  const {
    formatSheetPaymentRowMessage,
    formatTongTienCanThanhToanMessage,
    formatMoneyForThanhToanLine,
    getCongNoColumnBForCustomerD,
    hashPaymentRowSnapshot,
    congNoColumnBForDealerName,
    computeTongThuForPaymentRow,
    parseMoneyNumber,
    sumThucThuColumnIForCustomerD,
  } = await import("./format");
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
  let titles: string[];
  try {
    titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  } catch {
    return;
  }
  const titleSet = new Set(titles);

  const linkByTabIndex: string[] = [];
  for (let i = 0; i < TINH_TIEN_TAB_NAMES.length; i++) {
    linkByTabIndex.push(String(opts.linkFiles[i] ?? "").trim());
  }

  type TabSnap = { dataRows: string[][] };
  const tabSnap: Record<string, TabSnap> = {};

  for (let ti = 0; ti < TINH_TIEN_TAB_NAMES.length; ti++) {
    const tabName = TINH_TIEN_TAB_NAMES[ti];
    if (!titleSet.has(tabName)) continue;
    if (!linkByTabIndex[ti]) {
      tabSnap[tabName] = { dataRows: [] };
      continue;
    }
    try {
      const r = await readTabRows(token, env.MAIN_SPREADSHEET_ID, tabName);
      tabSnap[tabName] = { dataRows: r.dataRows };
    } catch {
      tabSnap[tabName] = { dataRows: [] };
    }
  }

  const allTabDataRows: Record<string, string[][]> = {};
  for (const tabName of TINH_TIEN_TAB_NAMES) {
    allTabDataRows[tabName] = tabSnap[tabName]?.dataRows ?? [];
  }

  const sentTongTienCanThanhToan = new Set<string>();

  const pauseBetweenTelegram = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 55));

  for (let ti = 0; ti < TINH_TIEN_TAB_NAMES.length; ti++) {
    const sheetTitle = TINH_TIEN_TAB_NAMES[ti];
    if (!titleSet.has(sheetTitle)) continue;
    if (!linkByTabIndex[ti]) continue;

    const snap = tabSnap[sheetTitle];
    if (!snap) continue;
    const { dataRows } = snap;

    const linkFile = linkByTabIndex[ti] ?? "";

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const sheetRow = i + 2;
      const rowHash = hashPaymentRowSnapshot(row);
      const kvK = kvPayRowKey(env.MAIN_SPREADSHEET_ID, sheetTitle, sheetRow, rowHash);
      if (!opts.skipKvDedup) {
        const prev = await env.STORE.get(kvK);
        if (prev === "1") continue;
      }

      const customerD = String(row[3] ?? "").trim();
      const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
      if (!chatId) continue;
      const congNoCu = congNoColumnBForDealerName(debtMap, customerD);
      const { tongThuDisplay } = computeTongThuForPaymentRow({
        debtMap,
        customerColD: customerD,
        allTabDataRows,
      });

      const html = formatSheetPaymentRowMessage({
        ngay: String(row[0] ?? "").trim(),
        mcc: String(row[1] ?? "").trim(),
        taiKhoan: String(row[2] ?? "").trim(),
        maDlTenKhach: customerD,
        rate: String(row[4] ?? "").trim(),
        tongTieu: String(row[5] ?? "").trim(),
        tienTe: String(row[6] ?? "").trim(),
        quyDoiUsd: String(row[7] ?? "").trim(),
        thucThuColI: String(row[8] ?? "").trim(),
        congNoCu,
        tongThu: tongThuDisplay,
        linkFile,
      });

      try {
        const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
        await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
        let qrSentOk = !env.PAYMENT_IMAGE_URL_1?.trim();
        if (env.PAYMENT_IMAGE_URL_1?.trim()) {
          try {
            await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_1);
            qrSentOk = true;
          } catch {
            qrSentOk = false;
          }
        }
        if (qrSentOk) {
          const dNorm = customerD.trim().toLowerCase();
          if (dNorm && !sentTongTienCanThanhToan.has(dNorm)) {
            const sumI = sumThucThuColumnIForCustomerD(allTabDataRows, customerD);
            const bDebt = getCongNoColumnBForCustomerD(debtMap, customerD);
            const debtNum = bDebt != null ? parseMoneyNumber(bDebt) : 0;
            const total = sumI + debtNum;
            const htmlThanhToan = formatTongTienCanThanhToanMessage({
              sumI: formatMoneyForThanhToanLine(sumI),
              congNo: formatMoneyForThanhToanLine(debtNum),
              total: formatMoneyForThanhToanLine(total),
            });
            try {
              await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, htmlThanhToan);
              sentTongTienCanThanhToan.add(dNorm);
              await pauseBetweenTelegram();
            } catch {
              /* tin tổng thanh toán lỗi không hoàn tác tin chính / QR */
            }
          }
        }
        try {
          await writeSheetCell(token, env.MAIN_SPREADSHEET_ID, sheetTitle, "J", sheetRow, tongThuDisplay);
        } catch {
          /* gửi tin đã xong */
        }
        await env.STORE.put(kvK, "1");
      } catch {
        /* không ghi KV / không ghi J nếu gửi lỗi */
      }
      await pauseBetweenTelegram();
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
