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
import {
  appendSheetPayRunError,
  appendSheetPayRunWarning,
  finishSheetPayRun,
  getLatestSheetPayRun,
  getSheetPayRun,
  newSheetPayRunId,
  persistSheetPayRunStart,
  recordSheetPayFooterSent,
} from "./sheet-pay-status";
import { fetchAllGroupChatsFromTelegram } from "./telegram-chats";
import { parseKetQuaDefaultsFromEnv, runKetQuaJob, type KetQuaRunInput } from "./ket-qua";
import type { AccountBackFilterInput, TkBackInput } from "./ket-qua-files";

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
      return;
    }

    /** 00:00 giờ Việt Nam — snapshot nợ đầu ngày: cột C = cột B tab CONG_NO. */
    if (event.cron === "0 17 * * *") {
      ctx.waitUntil(runCongNoColumnCRollover(env));
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
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
      const { baocaoBotToken, hasSeparateThuChiBot, thuChiBotToken } = await import("./thu-chi-hub");
      const { getKnownGroupChats } = await import("./telegram-group-cache");
      const baocaoTok = baocaoBotToken(env);
      const thuChiTok = thuChiBotToken(env);
      /** Hai bot: quét getUpdates bằng Báo cáo (không webhook). Một bot: dùng token duy nhất. */
      const scanTok =
        hasSeparateThuChiBot(env) && baocaoTok ? baocaoTok : thuChiTok || baocaoTok;
      if (!scanTok) {
        return json(
          {
            ok: false,
            error: "Chưa có TELEGRAM_BOT_TOKEN / TELEGRAM_THU_CHI_BOT_TOKEN trên Cloudflare.",
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
        const scanViaBaocao = hasSeparateThuChiBot(env) && scanTok === baocaoTok;

        let thuChiWebhookUrl = "";
        if (thuChiTok) {
          try {
            thuChiWebhookUrl = (await getWebhookInfo(thuChiTok)).url?.trim() ?? "";
          } catch {
            /* ignore */
          }
        }

        const requestOrigin = new URL(request.url).origin;
        const restoreWebhookUrl =
          thuChiWebhookUrl ||
          `${requestOrigin}/api/telegram-thu-chi-webhook`;

        try {
          const scanned = await fetchAllGroupChatsFromTelegram(scanTok, {
            store: env.STORE,
            persistOffset: true,
          });
          rounds = scanned.rounds;
          updatesConsumed = scanned.updatesConsumed;
          scanWarning = scanned.warning;
          scanned.chats.forEach((c) => byId.set(c.id, c));
          if (scanViaBaocao) {
            scanWarning =
              (scanWarning ? `${scanWarning} ` : "") +
              "Quét bằng bot Báo cáo (không webhook). Bot Thu Chi vẫn bật webhook nhận Thu/Chi.";
          }
        } catch (scanErr) {
          const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
          if (!scanViaBaocao && /webhook/i.test(msg) && thuChiTok) {
            try {
              const bypassed = await fetchGroupChatsWithTemporaryWebhookOff(thuChiTok, {
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
                  "Đã tạm gỡ webhook Thu Chi, quét, rồi bật lại." +
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
            ? "Chưa thấy nhóm. Thêm bot Báo cáo + Thu Chi vào nhóm, gửi một tin bất kỳ trong nhóm, bấm lại; hoặc nhập Chat ID tay."
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
            scanViaBaocao,
            thuChiWebhookUrl: thuChiWebhookUrl || undefined,
            hostMismatch,
            warning,
            note: scanViaBaocao
              ? "Chỉ bot Thu Chi bật webhook. Quét Chat ID dùng bot Báo cáo (getUpdates)."
              : usedWebhookBypass
                ? "Đã tạm gỡ webhook Thu Chi để quét — Thu/Chi vài giây có thể trễ."
                : "Nhóm từ bộ nhớ webhook Thu Chi + quét getUpdates.",
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
        mccs?: unknown[];
        excludeMccs?: unknown;
        filterDates?: unknown[];
        linkFiles?: unknown[];
        forceResend?: boolean;
        force?: boolean;
      };
      const rawDates = Array.isArray(body.dates)
        ? body.dates
        : Array.isArray(body.filterDates)
          ? body.filterDates
          : Array.isArray(body.linkFiles)
            ? body.linkFiles
            : [];
      const rawMccs = Array.isArray(body.mccs) ? body.mccs : [];
      const { parseFilterSlotsFromPanel, parseExcludeMccs, BAO_CAO_TK_TAB_NAME } =
        await import("./bao-cao-tk");
      const filterSlots = parseFilterSlotsFromPanel(rawDates, rawMccs);
      const excludeMccs = parseExcludeMccs(body.excludeMccs);
      const filterDates = filterSlots.map((s) => s.panelNgay);

      let token: string;
      try {
        token = await getAccessTokenFromEnv(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 503, request);
      }
      const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
      const allTitles = await getSheetTitles(token, debtSpreadsheetId);
      if (filterSlots.length === 0) {
        return json(
          {
            ok: false,
            error:
              "Điền ít nhất một ô NGÀY (khớp cột A tab BAO_CAO_TK, ví dụ 14/05/2026). MCC (cột B) tùy chọn.",
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

      const forceResend = body.forceResend === true || body.force === true;

        const {
        readBaoCaoTkSheetRows,
        filterBaoCaoSheetRowsBySlots,
        listDoneFilterRows,
        isRowExcludedByMcc,
        isBaoCaoRowNoteDone,
        BAO_CAO_COL,
      } = await import("./bao-cao-tk");

      if (!forceResend) {
        const allEntries = await readBaoCaoTkSheetRows(
          token,
          debtSpreadsheetId,
          BAO_CAO_TK_TAB_NAME,
        );
        const filterRows = filterBaoCaoSheetRowsBySlots(allEntries, filterSlots);
        const eligible = filterRows.filter((e) => {
          const rowNgay = String(e.cells[BAO_CAO_COL.NGAY] ?? "");
          const rowMcc = String(e.cells[BAO_CAO_COL.MCC] ?? "");
          return !isRowExcludedByMcc(rowNgay, rowMcc, e.panelNgay, excludeMccs);
        });
        const doneRows = listDoneFilterRows(eligible);
        const pendingRows = eligible.filter((e) => !isBaoCaoRowNoteDone(e.cells));
        /* Chỉ hỏi xác nhận khi mọi dòng lọc đã Done — còn dòng chưa gửi thì gửi bình thường (bỏ qua Done). */
        if (doneRows.length > 0 && pendingRows.length === 0) {
          return json(
            {
              ok: true,
              needsConfirm: true,
              doneRows,
              message: "Một số dòng đã gửi chi phí (Done). Xác nhận nếu muốn gửi lại.",
            },
            200,
            request,
          );
        }
      }

      const runId = newSheetPayRunId();
      await persistSheetPayRunStart(env, {
        runId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        complete: false,
        errors: [],
        warnings: [],
        footersSent: [],
      });

      ctx.waitUntil(
        broadcastDealerTabs(env, {
          skipKvDedup: false,
          forceResend,
          filterSlots,
          excludeMccs,
          runId,
        })
      );
      const mccHint = filterSlots.some((s) => s.panelMcc)
        ? ` + MCC (${filterSlots.filter((s) => s.panelMcc).map((s) => s.panelMcc).join("; ")})`
        : "";
      const exHint =
        excludeMccs.length > 0 ? `; loại trừ MCC: ${excludeMccs.join(", ")}` : "";
      return json(
        {
          ok: true,
          runId,
          message: `Đang gửi chi phí: ${filterSlots.length} bộ lọc (${filterDates.join(", ")}${mccHint}${exHint}) — tab BAO_CAO_TK…`,
          filterDates,
          filterSlots,
          excludeMccs,
        },
        202,
        request
      );
    }

    /** Đọc tab COC (panel Tiền cọc). */
    if (path === "/api/coc" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const token = await getAccessTokenFromEnv(env);
        const { readCocSheetRows, COC_TAB_NAME } = await import("./coc-sheet");
        const { thuChiSpreadsheetId } = await import("./thu-chi-hub");
        const rows = await readCocSheetRows(token, thuChiSpreadsheetId(env), COC_TAB_NAME);
        return json(
          {
            ok: true,
            spreadsheetId: thuChiSpreadsheetId(env),
            tabName: COC_TAB_NAME,
            rows: rows.map((r) => ({
              sheetRow: r.sheetRow1Based,
              ngay: r.ngay,
              thu: r.thu,
              chi: r.chi,
              ten: r.ten,
              note: r.note,
            })),
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Ghi tab COC từ panel — chỉ sửa/thêm/xóa dòng được chọn. */
    if (path === "/api/coc" && request.method === "PUT") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as {
        rows?: import("./coc-sheet").CocRowPatch[];
        appends?: import("./coc-sheet").CocRowPayload[];
        deletedRows?: number[];
      };
      const { applyCocPanelChanges, COC_TAB_NAME } = await import("./coc-sheet");
      const rawPatches = Array.isArray(body.rows) ? body.rows : [];
      const patches = rawPatches.filter(
        (r) => Number.isFinite(Number(r.sheetRow)) && Number(r.sheetRow) >= 2,
      );
      const appends = Array.isArray(body.appends) ? body.appends : [];
      const deletedRows = Array.isArray(body.deletedRows) ? body.deletedRows : [];
      if (
        rawPatches.length > 0 &&
        patches.length === 0 &&
        appends.length === 0 &&
        deletedRows.length === 0
      ) {
        return json(
          {
            ok: false,
            error:
              "Dữ liệu lưu thiếu số dòng Sheet — bấm « Làm mới » rồi sửa lại (panel cũ có thể ghi đè hết tab).",
          },
          400,
          request,
        );
      }
      if (patches.length === 0 && appends.length === 0 && deletedRows.length === 0) {
        return json({ ok: false, error: "Không có thay đổi nào cần lưu." }, 400, request);
      }
      try {
        const token = await getAccessTokenFromEnv(env);
        const { thuChiSpreadsheetId } = await import("./thu-chi-hub");
        const { patched, appended, cleared } = await applyCocPanelChanges(
          token,
          thuChiSpreadsheetId(env),
          COC_TAB_NAME,
          { patches, appends, deletedRows },
        );
        return json(
          {
            ok: true,
            message: `Đã lưu COC: ${patched} dòng sửa, ${appended} dòng thêm mới, ${cleared} dòng xóa (các dòng khác giữ nguyên).`,
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Chấm công — danh sách nhân viên + dữ liệu tab. */
    if (path === "/api/cham-cong" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const { getChamCongEmployeeMap, reconcileChamCongEmployeeMapTabs } = await import("./cham-cong-map");
        const {
          readChamCongRows,
          ensureTodayDateRow,
          resolveChamCongTabTitle,
        } = await import("./cham-cong-sheet");
        const { chamCongSpreadsheetId } = await import("./cham-cong-hub");
        const token = await getAccessTokenFromEnv(env);
        const spreadsheetId = chamCongSpreadsheetId(env);
        const map = await reconcileChamCongEmployeeMapTabs(
          token,
          spreadsheetId,
          await getChamCongEmployeeMap(env.STORE),
          env.STORE,
        );
        const employees = Object.entries(map).map(([telegramName, tabName]) => ({
          telegramName,
          tabName,
        }));
        const tabParam = url.searchParams.get("tab")?.trim() ?? "";
        const tabName =
          tabParam ||
          employees[0]?.tabName ||
          "";
        let rows: import("./cham-cong-sheet").ChamCongRow[] = [];
        let resolvedTab = tabName;
        if (tabName) {
          resolvedTab = await resolveChamCongTabTitle(token, spreadsheetId, tabName);
          await ensureTodayDateRow(token, spreadsheetId, resolvedTab);
          rows = await readChamCongRows(token, spreadsheetId, resolvedTab);
        }
        return json(
          {
            ok: true,
            spreadsheetId,
            employees,
            tabName: resolvedTab,
            rows: rows.map((r) => ({
              sheetRow: r.sheetRow1Based,
              ngay: r.ngay,
              chamCong: r.chamCong,
              tienUng: r.tienUng,
              thuong: r.thuong,
            })),
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Chấm công — lưu tiền thưởng (cột E) theo ngày. */
    if (path === "/api/cham-cong" && request.method === "PUT") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as {
        tabName?: string;
        ngay?: string;
        thuong?: string | number;
      };
      const tabName = String(body.tabName ?? "").trim();
      const ngay = String(body.ngay ?? "").trim();
      if (!tabName) {
        return json({ ok: false, error: "Thiếu tên tab." }, 400, request);
      }
      if (!ngay) {
        return json({ ok: false, error: "Thiếu ngày thưởng." }, 400, request);
      }
      try {
        const { writeChamCongAmountByNgay } = await import("./cham-cong-sheet");
        const { chamCongSpreadsheetId } = await import("./cham-cong-hub");
        const token = await getAccessTokenFromEnv(env);
        const { ngay: matchedNgay } = await writeChamCongAmountByNgay(
          token,
          chamCongSpreadsheetId(env),
          tabName,
          ngay,
          "E",
          body.thuong ?? "",
        );
        return json(
          { ok: true, message: `Đã lưu tiền thưởng (E) tab ${tabName} — ngày ${matchedNgay}.` },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Chấm công — thêm nhân viên (tạo tab Sheet mới). */
    if (path === "/api/cham-cong/employees" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as { telegramName?: string; tabName?: string };
      const telegramName = String(body.telegramName ?? "").trim();
      let tabName = String(body.tabName ?? "").trim();
      if (!telegramName) {
        return json({ ok: false, error: "Thiếu tên Telegram nhân viên." }, 400, request);
      }
      const { suggestTabName, addChamCongEmployee, getChamCongEmployeeMap } = await import(
        "./cham-cong-map"
      );
      if (!tabName) tabName = suggestTabName(telegramName);
      try {
        const token = await getAccessTokenFromEnv(env);
        const { createChamCongEmployeeTab } = await import("./cham-cong-sheet");
        const { chamCongSpreadsheetId } = await import("./cham-cong-hub");
        await createChamCongEmployeeTab(token, chamCongSpreadsheetId(env), tabName);
        const map = await addChamCongEmployee(env.STORE, telegramName, tabName);
        return json(
          {
            ok: true,
            message: `Đã tạo tab « ${tabName} » và gán nhân viên « ${telegramName} ».`,
            map,
            tabName,
            telegramName,
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Chấm công — xóa nhân viên (xóa tab Sheet + gỡ map KV). */
    if (path === "/api/cham-cong/employees" && request.method === "DELETE") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as { tabName?: string };
      const tabName = String(body.tabName ?? "").trim();
      if (!tabName) {
        return json({ ok: false, error: "Thiếu tên tab cần xóa." }, 400, request);
      }
      try {
        const { removeChamCongEmployeeByTab } = await import("./cham-cong-map");
        const { deleteChamCongEmployeeTab } = await import("./cham-cong-sheet");
        const { chamCongSpreadsheetId } = await import("./cham-cong-hub");
        const token = await getAccessTokenFromEnv(env);
        await deleteChamCongEmployeeTab(token, chamCongSpreadsheetId(env), tabName);
        const { map, telegramName } = await removeChamCongEmployeeByTab(env.STORE, tabName);
        const who = telegramName ? ` « ${telegramName} »` : "";
        return json(
          {
            ok: true,
            message: `Đã xóa tab « ${tabName} »${who} và gỡ khỏi danh sách nhân viên.`,
            map,
            tabName,
            telegramName,
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    /** Email — đọc 3 nhóm mail từ KV (mỗi dòng một email). */
    if (path === "/api/mail-list" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const { getMailListGroups, groupsToTextFields } = await import("./mail-list-kv");
      const groups = await getMailListGroups(env.STORE);
      const fields = groupsToTextFields(groups);
      return json({ ok: true, groups, ...fields }, 200, request);
    }

    /** Email — lưu 3 nhóm mail lên KV. */
    if (path === "/api/mail-list" && request.method === "PUT") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as {
        admin?: string;
        chuan?: string;
        readonly?: string;
      };
      try {
        const { setMailListGroups, groupsToTextFields } = await import("./mail-list-kv");
        const groups = await setMailListGroups(env.STORE, {
          admin: String(body.admin ?? ""),
          chuan: String(body.chuan ?? ""),
          readonly: String(body.readonly ?? ""),
        });
        const total =
          groups.admin.length + groups.chuan.length + groups.readonly.length;
        const fields = groupsToTextFields(groups);
        return json(
          {
            ok: true,
            message: `Đã lưu ${total} email (${groups.admin.length} Admin, ${groups.chuan.length} Chuẩn, ${groups.readonly.length} chỉ đọc).`,
            groups,
            ...fields,
          },
          200,
          request,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, msg.includes("KV") ? 503 : 502, request);
      }
    }

    /** Email — xóa toàn bộ danh sách trên KV. */
    if (path === "/api/mail-list" && request.method === "DELETE") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      try {
        const { clearMailList } = await import("./mail-list-kv");
        await clearMailList(env.STORE);
        return json({ ok: true, message: "Đã xóa danh sách email." }, 200, request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, msg.includes("KV") ? 503 : 502, request);
      }
    }

    /** Trạng thái lần gửi chi phí / TỔNG TIỀN gần nhất (panel Gửi chi phí). */
    if (path === "/api/sheet-pay-status" && request.method === "GET") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      if (!env.STORE) {
        return json(
          { ok: false, error: "Thiếu KV STORE — không lưu được trạng thái gửi chi phí." },
          503,
          request,
        );
      }
      const runIdParam = url.searchParams.get("runId")?.trim();
      const run = runIdParam
        ? await getSheetPayRun(env, runIdParam)
        : await getLatestSheetPayRun(env);
      return json({ ok: true, run }, 200, request);
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

    if (path === "/api/run-tk-back" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as Partial<TkBackInput>;
      const spreadsheetLinks = String(body.spreadsheetLinks ?? "").trim();
      if (!spreadsheetLinks) {
        return json(
          { ok: false, error: "Nhập link file (mỗi dòng một link Google Sheet)." },
          400,
          request,
        );
      }
      const campaignCol = String(body.campaignCol ?? "").trim();
      const costCol = String(body.costCol ?? "").trim();
      const currencyCol = String(body.currencyCol ?? "").trim();
      const accountNameCol = String(body.accountNameCol ?? "").trim();
      if (!campaignCol || !costCol || !currencyCol) {
        return json(
          {
            ok: false,
            error: "Nhập đủ cột chiến dịch, chi phí và đơn vị tiền tệ.",
          },
          400,
          request,
        );
      }
      if (!accountNameCol) {
        return json(
          { ok: false, error: "Nhập cột tên tài khoản (bắt buộc)." },
          400,
          request,
        );
      }
      const input: TkBackInput = {
        spreadsheetLinks,
        outputSpreadsheetUrlOrId: String(body.outputSpreadsheetUrlOrId ?? "").trim(),
        campaignCol,
        costCol,
        currencyCol,
        cap1Code: String(body.cap1Code ?? "").trim(),
        cap2Codes: String(body.cap2Codes ?? "").trim(),
        accountNameCol,
      };
      try {
        const { runTkBackJob } = await import("./ket-qua-files");
        const { message } = await runTkBackJob(env, input);
        return json({ ok: true, message }, 200, request);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502, request);
      }
    }

    if (path === "/api/run-account-back-filter" && request.method === "POST") {
      if (!(await verifySessionCookie(request, env.SESSION_SECRET))) {
        return json({ ok: false, error: "Chưa đăng nhập" }, 401, request);
      }
      const body = (await request.json()) as Partial<AccountBackFilterInput>;
      const spreadsheetUrlOrId = String(body.spreadsheetUrlOrId ?? "").trim();
      if (!spreadsheetUrlOrId) {
        return json({ ok: false, error: "Nhập link hoặc Spreadsheet ID." }, 400, request);
      }
      const campaignCol = String(body.campaignCol ?? "").trim();
      const costCol = String(body.costCol ?? "").trim();
      const currencyCol = String(body.currencyCol ?? "").trim();
      const accountNameCol = String(body.accountNameCol ?? "").trim();
      if (!campaignCol || !costCol || !currencyCol) {
        return json(
          {
            ok: false,
            error: "Nhập đủ cột chiến dịch, chi phí và đơn vị tiền tệ.",
          },
          400,
          request,
        );
      }
      if (!accountNameCol) {
        return json(
          { ok: false, error: "Nhập cột tên tài khoản (bắt buộc để so sánh giữa các tab)." },
          400,
          request,
        );
      }
      const input: AccountBackFilterInput = {
        spreadsheetUrlOrId,
        campaignCol,
        costCol,
        currencyCol,
        cap1Code: String(body.cap1Code ?? "").trim(),
        cap2Codes: String(body.cap2Codes ?? "").trim(),
        accountNameCol,
      };
      try {
        const { runAccountBackFilterJob } = await import("./ket-qua-files");
        const { message } = await runAccountBackFilterJob(env, input);
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
      const { formatNgayVietnamNow } = await import("./format");
      const ngay = String(body.ngay ?? "").trim() || formatNgayVietnamNow();
      const mcc = String(body.mcc ?? "").trim();
      const maCampPrefix = String(body.maCampPrefix ?? "").trim();
      const rate = String(body.rate ?? "").trim();
      const ruleRaw = String(body.rule ?? "");
      const ruleLines = ruleRaw.split(/\r?\n/).map((l) => l.trimEnd());
      const selectedDealers = Array.isArray(body.selectedDealers)
        ? body.selectedDealers.map((x) => String(x).trim()).filter(Boolean)
        : [];

      if (!mcc || !maCampPrefix || !rate) {
        return json(
          { ok: false, error: "Thiếu MCC / tiền tố MÃ CAMP / RATE" },
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

/** URL ảnh QR sau tin « TỔNG TIỀN CẦN THANH TOÁN » (secret / vars hoặc mặc định GitHub). */
function resolvePaymentImageUrl(env: Env): string {
  const fromEnv = env.PAYMENT_IMAGE_URL_1?.trim();
  if (fromEnv) return fromEnv;
  return "https://cdn.jsdelivr.net/gh/lamlucas/blackcorp_bot@main/qr1.jpg";
}

async function sendPaymentQrPhoto(
  env: Env,
  chatId: string,
  pauseBetweenTelegram: () => Promise<void>,
): Promise<void> {
  const qrUrl = resolvePaymentImageUrl(env);
  if (!qrUrl) return;
  const { sendPhotoUrl, pinMessage } = await import("./telegram");
  try {
    const photo = await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, qrUrl);
    await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, photo.message_id);
  } catch {
    /* QR lỗi — tin chi phí / tổng đã gửi */
  }
  await pauseBetweenTelegram();
}

/** Số nhóm Telegram gửi liên tiếp trước khi nghỉ (tránh Telegram rate limit). */
const SHEET_PAY_GROUP_BATCH_SIZE = 3;

/**
 * Gửi chi phí: tab BAO_CAO_TK (DEBT_SPREADSHEET_ID), lọc NGÀY + MCC từ panel.
 * Mỗi dòng → tin chi phí → ghi J = Done, cộng I vào CONG_NO cột B.
 * TỔNG TIỀN + QR: nợ cũ cột B + Σ cột I (cùng tên cột D) — khớp cột B CONG_NO mới gửi.
 */
async function broadcastDealerTabs(
  env: Env,
  opts: {
    skipKvDedup: boolean;
    forceResend?: boolean;
    filterSlots: import("./bao-cao-tk").BaoCaoFilterSlot[];
    excludeMccs?: string[];
    runId: string;
  },
): Promise<void> {
  if (!env.STORE) return;
  const runId = opts.runId;
  let runFinished = false;
  const finishRun = async (timedOut?: boolean) => {
    if (runFinished) return;
    runFinished = true;
    await finishSheetPayRun(env, runId, timedOut ? { timedOut: true } : undefined);
  };

  try {
  const store = env.STORE;

  const {
    formatSheetPaymentRowMessage,
    formatTongTienCanThanhToanMessage,
    formatMoneyForThanhToanLine,
    formatDebtDisplayForTelegram,
    congNoColumnBForDealerName,
    getCongNoColumnBForCustomerD,
    parseMoneyNumber,
    congNoDebtMatchesTongTien,
  } = await import("./format");
  const {
    BAO_CAO_TK_TAB_NAME,
    BAO_CAO_COL,
    readBaoCaoTkSheetRows,
    filterBaoCaoSheetRowsBySlots,
    isRowExcludedByMcc,
    getBaoCaoRowPaymentMissingLabels,
    readBaoCaoTongThuCell,
    filterSlotsSignature,
    buildTongTienBreakdownForCustomer,
    isBaoCaoRowNoteDone,
    sumPayableColumnIUpToRow,
    sumTongThuColumnIForCustomerFilterRows,
  } = await import("./bao-cao-tk");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");
  const { writeSheetCell } = await import("./worker-lib");

  const excludeMccs = opts.excludeMccs ?? [];
  const forceResend = opts.forceResend === true;

  let token: string;
  try {
    token = await getAccessTokenFromEnv(env);
  } catch {
    await appendSheetPayRunError(env, runId, "Không lấy được token Google Sheets.");
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

  const dealerMap = await getDealerChatMap(store);

  let allEntries: Awaited<ReturnType<typeof readBaoCaoTkSheetRows>>;
  try {
    allEntries = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
  } catch {
    await appendSheetPayRunError(env, runId, "Không đọc được tab BAO_CAO_TK.");
    return;
  }

  const dataRows = filterBaoCaoSheetRowsBySlots(allEntries, opts.filterSlots);
  if (dataRows.length === 0) return;

  const filterSig = filterSlotsSignature(opts.filterSlots);

  const reloadFilterRowsFromSheet = async () => {
    const fresh = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
    return filterBaoCaoSheetRowsBySlots(fresh, opts.filterSlots);
  };

  let filterRows = dataRows;

  const customerTargets = new Map<string, { chatId: string; customerD: string }>();
  for (const entry of filterRows) {
    const customerD = String(entry.cells[BAO_CAO_COL.TEN_KHACH] ?? "").trim();
    if (!customerD) continue;
    const key = customerD.toLowerCase();
    if (customerTargets.has(key)) continue;
    const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
    if (chatId) customerTargets.set(key, { chatId, customerD });
  }

  /** Nợ cột B CONG_NO trước khi cộng dồn trong lượt này. */
  const bOldSnapshot = new Map<string, number>();
  for (const target of customerTargets.values()) {
    const key = target.customerD.trim().toLowerCase();
    const bStr = getCongNoColumnBForCustomerD(debtMap, target.customerD);
    bOldSnapshot.set(key, bStr != null ? parseMoneyNumber(bStr) : 0);
  }

  const pauseMs = parseInt(env.DEBT_CRON_BATCH_PAUSE_MS ?? "4000", 10);
  const pauseBetweenGroupBatches =
    Number.isFinite(pauseMs) && pauseMs >= 0 ? Math.min(pauseMs, 120_000) : 4000;

  const pauseBetweenTelegram = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 55));

  const writeRowNote = async (sheetRow: number, status: string) => {
    const note = String(status ?? "").trim().slice(0, 120) || "Error";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeSheetCell(
          token,
          debtSpreadsheetId,
          BAO_CAO_TK_TAB_NAME,
          BAO_CAO_COL.NOTE_COL_LETTER,
          sheetRow,
          note,
        );
        return;
      } catch {
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 400));
        }
      }
    }
  };

  type PaymentGroupWork = {
    chatId: string;
    customerD: string;
    entries: typeof filterRows;
  };

  const paymentGroups: PaymentGroupWork[] = [];
  const paymentGroupByKey = new Map<string, PaymentGroupWork>();

  for (const entry of filterRows) {
    const row = entry.cells;
    const sheetRow = entry.sheetRow1Based;

    if (!forceResend && isBaoCaoRowNoteDone(row)) continue;

    const rowNgay = String(row[BAO_CAO_COL.NGAY] ?? "");
    const rowMcc = String(row[BAO_CAO_COL.MCC] ?? "");
    if (isRowExcludedByMcc(rowNgay, rowMcc, entry.panelNgay, excludeMccs)) continue;

    const customerD = String(row[BAO_CAO_COL.TEN_KHACH] ?? "").trim();
    const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
    const missingLabels = getBaoCaoRowPaymentMissingLabels(row);

    if (!chatId) {
      await writeRowNote(sheetRow, `Error: thiếu Chat ID (${customerD || "?"})`);
      continue;
    }
    if (missingLabels.length > 0) {
      await writeRowNote(sheetRow, `Error: thiếu ${missingLabels.join(", ")}`);
      continue;
    }

    const gKey = `${chatId}\x1e${customerD.trim().toLowerCase()}`;
    let group = paymentGroupByKey.get(gKey);
    if (!group) {
      group = { chatId, customerD, entries: [] };
      paymentGroupByKey.set(gKey, group);
      paymentGroups.push(group);
    }
    group.entries.push(entry);
  }

  const footerSentThisRun = new Set<string>();

  const mergeFilterRowsFromSheet = async () => {
    const memoryByRow = new Map(filterRows.map((e) => [e.sheetRow1Based, e]));
    try {
      const fresh = await reloadFilterRowsFromSheet();
      for (const e of fresh) {
        const mem = memoryByRow.get(e.sheetRow1Based);
        if (mem && isBaoCaoRowNoteDone(mem.cells)) {
          e.cells[BAO_CAO_COL.NOTE] = mem.cells[BAO_CAO_COL.NOTE];
        }
      }
      filterRows = fresh;
    } catch {
      /* giữ bản trong bộ nhớ */
    }
  };

  const reloadDebtMap = async () => {
    try {
      debtMap = await getDebtMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
    } catch {
      /* giữ bản cũ */
    }
  };

  const sendTongTienFooter = async (chatId: string, customerD: string) => {
    const footerRunKey = `${chatId}\x1e${customerD.trim().toLowerCase()}\x1e${filterSig}`;
    if (footerSentThisRun.has(footerRunKey)) return;

    await mergeFilterRowsFromSheet();
    await reloadDebtMap();

    const custKey = customerD.trim().toLowerCase();
    const bOldStart = bOldSnapshot.get(custKey) ?? 0;
    const sumI = sumTongThuColumnIForCustomerFilterRows(filterRows, customerD);
    const bStr = getCongNoColumnBForCustomerD(debtMap, customerD);
    const bCurrent = bStr != null ? parseMoneyNumber(bStr) : 0;

    let bOldDisplay: number;
    let total: number;

    if (forceResend) {
      total = bCurrent;
      bOldDisplay = Math.max(0, Math.round((bCurrent - sumI) * 100) / 100);
    } else {
      bOldDisplay = bOldStart;
      total = Math.round((bOldStart + sumI) * 100) / 100;
      if (!congNoDebtMatchesTongTien(bOldStart, sumI, bCurrent)) {
        await appendSheetPayRunError(env, runId, `Tên khách: ${customerD} lệch chi tiêu`);
        footerSentThisRun.add(footerRunKey);
        return;
      }
    }

    if (total <= 0) {
      footerSentThisRun.add(footerRunKey);
      return;
    }

    const breakdown = buildTongTienBreakdownForCustomer(filterRows, customerD, bOldDisplay);
    const htmlThanhToan = formatTongTienCanThanhToanMessage({
      bOld: formatMoneyForThanhToanLine(bOldDisplay),
      mccLines: breakdown.mccLines.map((line) => ({
        mcc: line.mcc,
        amount: line.amountDisplay,
      })),
      total: formatMoneyForThanhToanLine(total),
    });
    try {
      await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, htmlThanhToan);
    } catch {
      await appendSheetPayRunError(env, runId, `Tên khách: ${customerD} — gửi TỔNG TIỀN Telegram lỗi`);
      return;
    }
    await pauseBetweenTelegram();
    try {
      await sendPaymentQrPhoto(env, chatId, pauseBetweenTelegram);
    } catch {
      await appendSheetPayRunWarning(env, runId, `Tên khách: ${customerD} — gửi QR lỗi (tin tổng đã gửi).`);
    }
    await recordSheetPayFooterSent(env, runId, customerD);
    footerSentThisRun.add(footerRunKey);
  };

  for (let batchStart = 0; batchStart < paymentGroups.length; batchStart += SHEET_PAY_GROUP_BATCH_SIZE) {
    const batch = paymentGroups.slice(batchStart, batchStart + SHEET_PAY_GROUP_BATCH_SIZE);

    for (const group of batch) {
      const { chatId, customerD, entries } = group;
      const sortedEntries = [...entries].sort((a, b) => a.sheetRow1Based - b.sheetRow1Based);
      const bOldForGroup = bOldSnapshot.get(customerD.trim().toLowerCase()) ?? 0;

      for (const entry of sortedEntries) {
        const row = entry.cells;
        const sheetRow = entry.sheetRow1Based;
        const rowMcc = String(row[BAO_CAO_COL.MCC] ?? "");
        const tongThuDisplay = readBaoCaoTongThuCell(row) || "0";
        const tongThuNum = parseMoneyNumber(tongThuDisplay);
        const bStr = getCongNoColumnBForCustomerD(debtMap, customerD);
        const bNum = bStr != null ? parseMoneyNumber(bStr) : 0;
        let congNoSauMcc: string;
        if (forceResend && tongThuNum > 0) {
          const sumUpTo = sumPayableColumnIUpToRow(filterRows, customerD, sheetRow);
          congNoSauMcc = formatDebtDisplayForTelegram(
            formatMoneyForThanhToanLine(Math.round((bOldForGroup + sumUpTo) * 100) / 100),
          );
        } else if (bStr != null && tongThuNum > 0) {
          congNoSauMcc = formatDebtDisplayForTelegram(
            formatMoneyForThanhToanLine(Math.round((bNum + tongThuNum) * 100) / 100),
          );
        } else {
          congNoSauMcc = congNoColumnBForDealerName(debtMap, customerD);
        }
        const linkFile = String(row[BAO_CAO_COL.LINK_FILE] ?? "").trim();

        const html = formatSheetPaymentRowMessage({
          ngay: entry.panelNgay,
          mcc: rowMcc.trim(),
          taiKhoan: String(row[BAO_CAO_COL.TAI_KHOAN] ?? "").trim(),
          maDlTenKhach: customerD,
          rate: String(row[BAO_CAO_COL.RATE] ?? "").trim(),
          tongTieu: String(row[BAO_CAO_COL.TONG_TIEU] ?? "").trim(),
          tienTe: String(row[BAO_CAO_COL.TIEN_TE] ?? "").trim(),
          quyDoiUsd: String(row[BAO_CAO_COL.QUY_DOI_USD] ?? "").trim(),
          congNoCu: congNoSauMcc,
          tongThu: tongThuDisplay,
          linkFile,
        });

        try {
          const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
          await writeRowNote(sheetRow, "Done");
          row[BAO_CAO_COL.NOTE] = "Done";

          try {
            await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
          } catch {
            /* ghim lỗi — tin đã gửi, vẫn ghi Done */
          }

          if (tongThuNum > 0 && !forceResend) {
            try {
              const { accumulateCongNoDebtFromExpense } = await import("./cong-no-sheet");
              const acc = await accumulateCongNoDebtFromExpense(
                token,
                debtSpreadsheetId,
                env.DEBT_TAB_NAME.trim(),
                customerD,
                tongThuNum,
              );
              if (acc.updated && acc.maDlKey && acc.newDebtDisplay) {
                debtMap.set(acc.maDlKey, acc.newDebtDisplay);
              }
            } catch {
              /* ghi CONG_NO lỗi — tin đã gửi */
            }
          }
        } catch {
          await writeRowNote(sheetRow, "Error: Telegram");
        }
        await pauseBetweenTelegram();
      }

      await sendTongTienFooter(chatId, customerD);
    }

    const hasMoreBatches = batchStart + SHEET_PAY_GROUP_BATCH_SIZE < paymentGroups.length;
    if (hasMoreBatches && pauseBetweenGroupBatches > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pauseBetweenGroupBatches));
    }
  }

  for (const target of customerTargets.values()) {
    await sendTongTienFooter(target.chatId, target.customerD);
  }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const low = msg.toLowerCase();
    const isTimeout =
      low.includes("timeout") ||
      low.includes("exceeded") ||
      low.includes("limit") ||
      low.includes("cpu time");
    if (isTimeout) {
      await finishRun(true);
    } else {
      await appendSheetPayRunError(env, runId, msg.slice(0, 500));
    }
  } finally {
    await finishRun();
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

function kvPayTongKey(spreadsheetId: string, customerColD: string, filterSig: string): string {
  const cust = customerColD.trim().toLowerCase().replace(/\s+/g, " ");
  return `paytong:${spreadsheetId}:${cust}:${filterSig}`;
}

/** Cron 00:00 VN — ghi cột C = cột B (nợ đầu ngày) cho tab CONG_NO. */
async function runCongNoColumnCRollover(env: Env): Promise<void> {
  if (!env.STORE) return;
  try {
    const token = await getAccessTokenFromEnv(env);
    const spreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
    const tabName = env.DEBT_TAB_NAME.trim();
    const { rolloverCongNoColumnCForNewVietnamDay } = await import("./cong-no-sheet");
    await rolloverCongNoColumnCForNewVietnamDay(token, spreadsheetId, tabName, env.STORE);
  } catch {
    /* cron không chặn worker */
  }
}
