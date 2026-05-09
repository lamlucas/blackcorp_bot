import defaultChatGroups from "./chat-groups.json";
import indexHtml from "./index.html";

const SHEET_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const ADMIN_USERNAME = "Black777777";
const SESSION_COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
const CHAT_GROUPS_KV_KEY = "chat-groups:v1";
const CONG_NO_TAB_CANDIDATES = ["CONG_NO", "Cong_No", "cong_no", "CONG NO"];

/**
 * Layout revenue (A–H): A NGÀY, B MCC, C TỔNG TIÊU, D TIỀN TỆ, E QUY ĐỔI USD, F RATE, G THỰC THU, H TỔNG THU (= G + CONG_NO!B neu co).
 * H hash rieng qua tongThuSheetColIdx (mac dinh cot H). THỰC THU hien thi: MAIN_THUC_THU_COLUMN (mac dinh G).
 */
const SHEET_COLUMN_LAYOUTS = {
  legacy: { ngay: 0, mcc: 1, tongTieu: 2, tienTe: 3, quyDoiUsd: 4, rate: 5, thucThu: 6 },
  revenue: { ngay: 0, mcc: 1, tongTieu: 2, tienTe: 3, quyDoiUsd: 4, rate: 5, thucThu: 6 }
};

function resolveSheetColumnLayout(env) {
  const raw = String(env.SHEET_COLUMN_LAYOUT || env.GOOGLE_SHEET_LAYOUT || "legacy")
    .trim()
    .toLowerCase();
  if (raw === "revenue" || raw === "bao_cao" || raw === "report" || raw === "doanh_thu") {
    return { name: "revenue", cols: SHEET_COLUMN_LAYOUTS.revenue };
  }
  return { name: "legacy", cols: SHEET_COLUMN_LAYOUTS.legacy };
}

function colByLayout(row, cols, field) {
  const idx = cols[field];
  return String(row[idx] ?? "").trim();
}

function layoutColumnIndicesForHash(cols, thucThuColIdx, tongThuSheetColIdx) {
  const set = new Set(
    Object.values(cols).filter((n) => typeof n === "number" && Number.isFinite(n))
  );
  if (typeof thucThuColIdx === "number" && Number.isFinite(thucThuColIdx)) {
    set.add(thucThuColIdx);
  }
  if (typeof tongThuSheetColIdx === "number" && Number.isFinite(tongThuSheetColIdx)) {
    set.add(tongThuSheetColIdx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** A -> 0, G -> 6, AA -> 26 */
function excelColumnLettersToZeroBasedIndex(letters) {
  const s = String(letters || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!s.length) return null;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 65 || code > 90) return null;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** THỰC THU hien thi + cong thuc TỔNG THU: mac dinh cot G (index 6) sheet chinh */
function resolveMainThucThuColumnIndex(env) {
  const rawIdx = String(env.MAIN_THUC_THU_COL_INDEX ?? "").trim();
  if (rawIdx && /^\d+$/.test(rawIdx)) {
    const n = Number(rawIdx);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const letter = String(env.MAIN_THUC_THU_COLUMN ?? env.THUC_THU_COLUMN ?? "G").trim();
  const fromLetter = excelColumnLettersToZeroBasedIndex(letter);
  if (fromLetter !== null && fromLetter >= 0) return fromLetter;
  return 6;
}

/** Cot TỔNG THU tren tung tab DL (cong thuc sheet = G + CONG_NO); mac dinh H */
function resolveSheetTongThuColumnIndex(env) {
  const rawIdx = String(env.SHEET_TONG_THU_COL_INDEX ?? "").trim();
  if (rawIdx && /^\d+$/.test(rawIdx)) {
    const n = Number(rawIdx);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const letter = String(env.SHEET_TONG_THU_COLUMN ?? "H").trim();
  const fromLetter = excelColumnLettersToZeroBasedIndex(letter);
  if (fromLetter !== null && fromLetter >= 0) return fromLetter;
  return 7;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAuthenticated = await verifyAdminSession(request, env);

    if (request.method === "GET" && url.pathname === "/login") {
      if (isAuthenticated) return redirectResponse("/");
      return new Response(indexHtml, htmlHeaders());
    }
    if (request.method === "POST" && url.pathname === "/api/login") return handleLogin(request, env);
    if (request.method === "POST" && url.pathname === "/api/logout") return handleLogout();

    if (request.method === "GET" && url.pathname === "/") {
      if (!isAuthenticated) return redirectResponse("/login");
      return new Response(indexHtml, htmlHeaders());
    }

    if (request.method === "GET" && url.pathname === "/api/chat-groups") {
      if (!isAuthenticated) return unauthorized();
      return jsonResponse({ ok: true, groups: await getChatGroups(env) });
    }

    if (request.method === "POST" && url.pathname === "/api/chat-groups") {
      if (!isAuthenticated) return unauthorized();
      return upsertChatGroup(request, env);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/chat-groups/")) {
      if (!isAuthenticated) return unauthorized();
      const chatId = decodeURIComponent(url.pathname.replace("/api/chat-groups/", ""));
      return deleteChatGroup(chatId, env);
    }

    if (request.method === "POST" && url.pathname === "/api/broadcast") {
      if (!isAuthenticated) return unauthorized();
      return handleBroadcast(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      const apiKey = request.headers.get("x-sync-api-key") || "";
      const keyValid = env.SYNC_API_KEY && apiKey === env.SYNC_API_KEY;
      if (!keyValid && !isAuthenticated) return unauthorized();
      const catchUp = url.searchParams.get("catch_up") === "1";
      const result = await syncSheetToTelegram(env, { catchUp });
      return jsonResponse({ ok: true, result });
    }

    if (request.method === "POST" && url.pathname === "/api/reset-sheet-checkpoints") {
      if (!isAuthenticated) return unauthorized();
      await resetAllSheetCheckpoints(env);
      return jsonResponse({
        ok: true,
        note: "Da xoa snapshot dong bo (hash). Lan sync tiep baseline lai — dung POST /api/sync?catch_up=1 neu can gui het dong hien co mot lan."
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncSheetToTelegram(env, {}));
  }
};

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return jsonResponse({ ok: false, error: "Missing env: ADMIN_PASSWORD" }, 500);

  const payload = await request.json();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  if (username !== ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
    return jsonResponse({ ok: false, error: "Sai tai khoan hoac mat khau." }, 401);
  }

  const sessionValue = await createSessionCookieValue(username, env);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", buildSessionCookie(sessionValue));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleLogout() {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", clearSessionCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleBroadcast(request, env) {
  const payload = await request.json();
  const { ngay, mcc, maCamp, rate, rule } = payload || {};
  if (!ngay || !mcc || !maCamp || !rate || !rule) {
    return jsonResponse({ ok: false, error: "Thieu du lieu bat buoc." }, 400);
  }

  const groups = await getChatGroups(env);
  if (!groups.length) return jsonResponse({ ok: false, error: "Chua co chat group nao." }, 400);

  const message = buildBroadcastMessage({ ngay, mcc, maCamp, rate, rule });
  const results = await sendToAllGroups(message, env.TELEGRAM_BOT_TOKEN, groups);
  return jsonResponse({ ok: true, sent: results.success, failed: results.failed });
}

async function upsertChatGroup(request, env) {
  const payload = await request.json();
  const tabName = String(payload?.tabName || "").trim();
  const chatId = String(payload?.chatId || "").trim();
  if (!tabName || !chatId) {
    return jsonResponse({ ok: false, error: "Tab name va chat ID khong duoc rong." }, 400);
  }

  const groups = await getChatGroups(env);
  const normalized = groups.filter((group) => group.chatId !== chatId);
  normalized.push({ tabName, chatId });
  normalized.sort((a, b) => a.tabName.localeCompare(b.tabName, "vi"));
  await saveChatGroups(env, normalized);
  return jsonResponse({ ok: true, groups: normalized });
}

async function deleteChatGroup(chatId, env) {
  const groups = await getChatGroups(env);
  const nextGroups = groups.filter((group) => group.chatId !== chatId);
  await saveChatGroups(env, nextGroups);
  return jsonResponse({ ok: true, groups: nextGroups });
}

async function resetAllSheetCheckpoints(env) {
  const groups = await getChatGroups(env);
  for (const group of groups) {
    await env.SHEET_STATE_KV.delete(`sheet-last-row:${group.tabName}`);
    await env.SHEET_STATE_KV.delete(`sheet-row-sigs:${group.tabName}`);
  }
}

// Hang 1 (values[0]) luon la tieu de; du lieu bat dau tu hang 2.
function getDataRowsForMainSheet(values) {
  if (!values.length) return [];
  return values.slice(1);
}

function rowHasSyncableData(row, cols, thucThuColIdx, tongThuSheetColIdx) {
  const idxSet = new Set([
    cols.ngay,
    cols.mcc,
    cols.tongTieu,
    cols.thucThu,
    cols.quyDoiUsd,
    thucThuColIdx,
    tongThuSheetColIdx
  ]);
  for (const i of idxSet) {
    if (typeof i !== "number" || !Number.isFinite(i)) continue;
    if (String(row[i] ?? "").trim()) return true;
  }
  return false;
}

async function hashRowSignature(row, cols, thucThuColIdx, tongThuSheetColIdx) {
  const parts = [];
  for (const idx of layoutColumnIndicesForHash(cols, thucThuColIdx, tongThuSheetColIdx)) {
    parts.push(String(row[idx] ?? "").trim());
  }
  const payload = parts.join("\u001e");
  const buf = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function syncSheetToTelegram(env, options = {}) {
  const catchUp = options.catchUp === true;
  validateEnvForSheetSync(env);
  const layout = resolveSheetColumnLayout(env);
  const cols = layout.cols;
  const thucThuColIdx = resolveMainThucThuColumnIndex(env);
  const tongThuSheetColIdx = resolveSheetTongThuColumnIndex(env);
  const groups = await getChatGroups(env);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const congNoSheetId = env.GOOGLE_SHEET_ID;
  const congNoResult = await loadCongNoMap(congNoSheetId, accessToken);
  const congNoMap = congNoResult.map;
  if (congNoResult.error) {
    console.error("[CONG_NO] load failed:", congNoResult.error);
  } else {
    console.log("[CONG_NO] ok tab=", congNoResult.sheetTabUsed, "entries=", congNoMap.size);
  }
  const summary = [];

  for (const group of groups) {
    const sigKey = `sheet-row-sigs:${group.tabName}`;
    const legacyKey = `sheet-last-row:${group.tabName}`;
    const values = await readSheetTab(env.GOOGLE_SHEET_ID, group.tabName, accessToken);
    if (!values.length) {
      summary.push({ tabName: group.tabName, sent: 0, note: "No data rows" });
      continue;
    }

    const dataRows = getDataRowsForMainSheet(values);
    const currentHashes = await Promise.all(
      dataRows.map((r) => hashRowSignature(r, cols, thucThuColIdx, tongThuSheetColIdx))
    );
    await env.SHEET_STATE_KV.delete(legacyKey);

    const storedSigs = await env.SHEET_STATE_KV.get(sigKey);
    let prevHashes = null;
    if (storedSigs) {
      try {
        const parsed = JSON.parse(storedSigs);
        if (Array.isArray(parsed)) prevHashes = parsed;
      } catch {
        prevHashes = null;
      }
    }

    if (prevHashes === null) {
      let sentInit = 0;
      if (catchUp && dataRows.length > 0) {
        for (const row of dataRows) {
          if (!rowHasSyncableData(row, cols, thucThuColIdx, tongThuSheetColIdx)) continue;
          const debtInfo = getDebtInfo(congNoMap, group.tabName);
          const message = buildSheetMessage(
            group.tabName,
            row,
            debtInfo,
            cols,
            thucThuColIdx,
            tongThuSheetColIdx
          );
          const photoUrls = collectPaymentPhotoUrls(debtInfo, env);
          await sendSheetRowNotification(env.TELEGRAM_BOT_TOKEN, group.chatId, message, photoUrls);
          sentInit += 1;
        }
      }
      await env.SHEET_STATE_KV.put(sigKey, JSON.stringify(currentHashes));
      summary.push({
        tabName: group.tabName,
        sent: sentInit,
        dataRows: dataRows.length,
        sheetLayout: layout.name,
        note: catchUp
          ? sentInit > 0
            ? "Catch-up: da gui cac dong hien co"
            : "Catch-up: khong co dong du lieu"
          : "Baseline: da luu snapshot dong (chua gui — them/sua du lieu hoac ?catch_up=1)"
      });
      continue;
    }

    let sentCount = 0;
    let newRowCount = 0;
    let editedRowCount = 0;
    const toSend = [];
    for (let i = 0; i < currentHashes.length; i += 1) {
      if (i >= prevHashes.length) {
        toSend.push({ index: i, kind: "new" });
      } else if (currentHashes[i] !== prevHashes[i]) {
        toSend.push({ index: i, kind: "edited" });
      }
    }

    for (const { index, kind } of toSend) {
      const row = dataRows[index];
      if (!rowHasSyncableData(row, cols, thucThuColIdx, tongThuSheetColIdx)) continue;
      const debtInfo = getDebtInfo(congNoMap, group.tabName);
      const message = buildSheetMessage(
        group.tabName,
        row,
        debtInfo,
        cols,
        thucThuColIdx,
        tongThuSheetColIdx
      );
      const photoUrls = collectPaymentPhotoUrls(debtInfo, env);
      await sendSheetRowNotification(env.TELEGRAM_BOT_TOKEN, group.chatId, message, photoUrls);
      sentCount += 1;
      if (kind === "new") newRowCount += 1;
      else editedRowCount += 1;
    }

    await env.SHEET_STATE_KV.put(sigKey, JSON.stringify(currentHashes));
    summary.push({
      tabName: group.tabName,
      sent: sentCount,
      newRows: newRowCount,
      editedRows: editedRowCount,
      dataRows: dataRows.length,
      sheetLayout: layout.name,
      note:
        sentCount === 0
          ? "Khong co dong moi hoac khong co o du lieu (theo layout) thay doi"
          : "Da gui: dong moi va/hoac dong da sua"
    });
  }
  const mapKeysSample = Array.from(congNoMap.keys()).slice(0, 30);
  const groupMatchHints = groups.map((g) => ({
    tabName: g.tabName,
    normalized: normalizeTabKey(g.tabName),
    matchedCongNo: !!getDebtInfo(congNoMap, g.tabName)
  }));
  return {
    sheetColumnLayout: layout.name,
    mainThucThuColumnIndex: thucThuColIdx,
    sheetTongThuColumnIndex: tongThuSheetColIdx,
    groups: summary,
    congNo: {
      sheetId: congNoSheetId,
      sheetTabUsed: congNoResult.sheetTabUsed,
      entries: congNoMap.size,
      error: congNoResult.error,
      mapKeysSample,
      groupMatchHints
    }
  };
}

function buildBroadcastMessage({ ngay, mcc, maCamp, rate, rule }) {
  const formattedRule = String(rule || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<b>${escapeHtml(line)}</b>`)
    .join("\n");
  return [
    `NGÀY: <b>${escapeHtml(ngay)}</b>`,
    `MCC: <b>${escapeHtml(mcc)}</b>`,
    `MÃ CAMP: <b>${escapeHtml(maCamp)}</b>`,
    `RATE: <b>${escapeHtml(rate)}</b>`,
    `RULE:\n${formattedRule || "<b></b>"}`
  ].join("\n");
}

// Layout legacy (A–G): giong hang revenue A–G.
// Layout revenue: A–H nhu SHEET_COLUMN_LAYOUTS.revenue; CONG_NO cung file: B = cong no.
// Tab CONG_NO cung file GOOGLE_SHEET_ID: A = ten DL, B = cong no; C,D = URL QR (https).
// THỰC THU: MAIN_THUC_THU_COLUMN (mac dinh G). TỔNG THU: SHEET_TONG_THU_COLUMN (mac dinh H), uu tien gia tri o neu co.
function buildSheetMessage(tabName, row, debtInfo, cols, thucThuColIdx, tongThuSheetColIdx) {
  const thucThuRaw = String(row[thucThuColIdx] ?? "").trim();
  const tongThuFromSheet = String(row[tongThuSheetColIdx] ?? "").trim();
  const lines = [
    `NGÀY: <b>${escapeHtml(colByLayout(row, cols, "ngay"))}</b>`,
    `MÃ ĐL: <b>${escapeHtml(tabName)}</b>`,
    `MCC: <b>${escapeHtml(colByLayout(row, cols, "mcc"))}</b>`,
    `TỔNG TIÊU: <b>${escapeHtml(colByLayout(row, cols, "tongTieu"))}</b>`,
    `TIỀN TỆ: <b>${escapeHtml(colByLayout(row, cols, "tienTe"))}</b>`,
    `QUY ĐỔI USD: <b>${escapeHtml(colByLayout(row, cols, "quyDoiUsd"))}</b>`,
    `RATE: <b>${escapeHtml(colByLayout(row, cols, "rate"))}</b>`,
    `THỰC THU: <b>${escapeHtml(thucThuRaw)}</b>`
  ];
  if (debtInfo) {
    lines.push(`CÔNG NỢ CŨ: <b>${escapeHtml(debtInfo.congNoCu)}</b>`);
    let tongThuOut = tongThuFromSheet;
    if (!tongThuOut) {
      const thucThuNum = parseSheetNumber(thucThuRaw);
      const noCuNum = parseSheetNumber(debtInfo.congNoCu);
      tongThuOut = formatNumberVi(thucThuNum + noCuNum);
    }
    lines.push(`TỔNG THU: <b>${escapeHtml(tongThuOut)}</b>`);
  } else if (tongThuFromSheet) {
    lines.push(`TỔNG THU: <b>${escapeHtml(tongThuFromSheet)}</b>`);
  }
  return lines.join("\n");
}

function cleanSheetCellText(s) {
  return String(s || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function normalizeTabKey(s) {
  return cleanSheetCellText(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function getDebtInfo(congNoMap, tabName) {
  const raw = cleanSheetCellText(tabName);
  if (!raw) return null;
  const keys = [
    normalizeTabKey(raw),
    normalizeTabKey(raw.replace(/-/g, "_")),
    normalizeTabKey(raw.replace(/_/g, " "))
  ];
  for (const key of keys) {
    const row = congNoMap.get(key);
    if (row) return row;
  }
  return null;
}

function rowLooksLikeCongNoHeader(row) {
  const a = String(row?.[0] ?? "").trim().toLowerCase();
  if (!a) return false;
  return (
    a.includes("tên") ||
    a.includes("ten tab") ||
    a === "tab" ||
    a.includes("mã đại") ||
    a.includes("ma dai") ||
    a.includes("stt") ||
    a === "#"
  );
}

function buildCongNoMapFromRows(rows) {
  const map = new Map();
  if (!rows.length) return map;
  let dataRows = rows;
  if (rows.length > 1 && rowLooksLikeCongNoHeader(rows[0])) {
    dataRows = rows.slice(1);
  }
  for (const row of dataRows) {
    const rawKey = cleanSheetCellText(row[0] ?? "");
    if (!rawKey) continue;
    const key = normalizeTabKey(rawKey);
    map.set(key, {
      congNoCu: String(row[1] ?? "").trim(),
      photoUrl1: String(row[2] ?? "").trim() || null,
      photoUrl2: String(row[3] ?? "").trim() || null
    });
  }
  return map;
}

async function loadCongNoMap(sheetId, accessToken) {
  const errors = [];
  let best = null;
  for (const tab of CONG_NO_TAB_CANDIDATES) {
    try {
      const rows = await readSheetTab(sheetId, tab, accessToken);
      const map = buildCongNoMapFromRows(rows);
      if (!best || map.size > best.map.size) {
        best = { map, sheetTabUsed: tab, error: null };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${tab}: ${msg}`);
      console.error("[CONG_NO] try tab", tab, msg);
    }
  }
  if (best) return best;
  const error = errors.length ? errors.join(" | ") : "Unknown CONG_NO read error";
  return { map: new Map(), sheetTabUsed: null, error };
}

function collectPaymentPhotoUrls(debtInfo, env) {
  const fromRow = debtInfo
    ? [debtInfo.photoUrl1, debtInfo.photoUrl2].filter((u) => isHttpUrl(u))
    : [];
  const fromEnv = [env.TELEGRAM_PAYMENT_PHOTO_URL_1, env.TELEGRAM_PAYMENT_PHOTO_URL_2]
    .map((u) => String(u || "").trim())
    .filter((u) => isHttpUrl(u));
  const merged = [...fromRow];
  for (const u of fromEnv) {
    if (merged.length >= 2) break;
    if (!merged.includes(u)) merged.push(u);
  }
  return merged.slice(0, 2);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function parseSheetNumber(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return 0;
  s = s.replace(/\s/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      s = parts[0].replace(/\./g, "") + "." + parts[1];
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasDot) {
    const dotParts = s.split(".");
    if (dotParts.length > 2) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatNumberVi(n) {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(n);
}

function toTelegramChatId(chatId) {
  const s = String(chatId ?? "").trim();
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

async function sendSheetRowNotification(botToken, chatId, text, photoUrls) {
  const tgChat = toTelegramChatId(chatId);
  const sent = await callTelegram(botToken, "sendMessage", {
    chat_id: tgChat,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
  const messageId = sent.result.message_id;
  try {
    await callTelegram(botToken, "pinChatMessage", {
      chat_id: tgChat,
      message_id: messageId,
      disable_notification: false
    });
  } catch (error) {
    console.error("[pinChatMessage]", String(chatId), error instanceof Error ? error.message : error);
  }
  for (const photo of photoUrls) {
    try {
      await callTelegram(botToken, "sendPhoto", {
        chat_id: tgChat,
        photo,
        reply_to_message_id: messageId
      });
    } catch (error) {
      console.error("[sendPhoto url]", photo, error instanceof Error ? error.message : error);
      try {
        await sendPhotoByUpload(botToken, tgChat, photo, messageId);
      } catch (error2) {
        console.error("[sendPhoto upload]", photo, error2 instanceof Error ? error2.message : error2);
      }
    }
  }
}

async function sendPhotoByUpload(botToken, chatId, photoUrl, replyToMessageId) {
  const response = await fetch(photoUrl);
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const blob = await response.blob();
  const form = new FormData();
  const tgChat = toTelegramChatId(chatId);
  form.append("chat_id", String(tgChat));
  form.append("photo", blob, "payment.jpg");
  form.append("reply_to_message_id", String(replyToMessageId));
  const sendResponse = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form
  });
  const result = await sendResponse.json();
  if (!sendResponse.ok || !result.ok) throw new Error(result.description || "sendPhoto upload failed");
}

async function sendToAllGroups(message, botToken, groups) {
  if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  let success = 0;
  let failed = 0;
  for (const group of groups) {
    try {
      await sendTelegramMessage(botToken, group.chatId, message);
      success += 1;
    } catch (_error) {
      failed += 1;
    }
  }
  return { success, failed };
}

async function sendTelegramMessage(botToken, chatId, text) {
  await callTelegram(botToken, "sendMessage", {
    chat_id: toTelegramChatId(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function callTelegram(botToken, method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result;
}

function encodeSheetRangeA1(tabName) {
  const escaped = String(tabName).replace(/'/g, "''");
  return encodeURIComponent(`'${escaped}'!A:Z`);
}

async function readSheetTab(sheetId, tabName, accessToken) {
  const range = encodeSheetRangeA1(tabName);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Google Sheets API error");
  return data.values || [];
}

function validateEnvForSheetSync(env) {
  for (const key of ["TELEGRAM_BOT_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEET_ID"]) {
    if (!env[key]) throw new Error(`Missing env: ${key}`);
  }
}

async function getGoogleAccessToken(serviceAccountJson) {
  const serviceAccount = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iss: serviceAccount.client_email,
    scope: SHEET_SCOPE,
    aud: serviceAccount.token_uri,
    exp: now + 3600,
    iat: now
  };
  const unsignedToken = `${base64UrlEncode(JSON.stringify(jwtHeader))}.${base64UrlEncode(
    JSON.stringify(jwtPayload)
  )}`;
  const signature = await signJwt(unsignedToken, serviceAccount.private_key);
  const assertion = `${unsignedToken}.${signature}`;

  const response = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "Failed Google access token");
  return data.access_token;
}

async function signJwt(message, privateKeyPem) {
  const pemBody = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binaryKey = Uint8Array.from(atob(pemBody), (char) => char.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(message)
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(base64Url) {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return decodeURIComponent(
    Array.from(atob(padded))
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function htmlHeaders() {
  return { headers: { "content-type": "text/html; charset=utf-8" } };
}

function unauthorized() {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

function redirectResponse(targetPath) {
  return new Response(null, { status: 302, headers: { location: targetPath } });
}

function buildSessionCookie(value) {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function verifyAdminSession(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const rawValue = cookies[SESSION_COOKIE_NAME];
  if (!rawValue) return false;
  try {
    const [payloadEncoded, signature] = rawValue.split(".");
    if (!payloadEncoded || !signature) return false;
    const expectedSignature = await signHmac(payloadEncoded, getSessionSecret(env));
    if (!timingSafeEqual(signature, expectedSignature)) return false;
    const payload = JSON.parse(decodeBase64Url(payloadEncoded));
    if (payload.username !== ADMIN_USERNAME) return false;
    return Number(payload.exp) >= Math.floor(Date.now() / 1000);
  } catch (_error) {
    return false;
  }
}

async function createSessionCookieValue(username, env) {
  const payload = { username, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS };
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await signHmac(payloadEncoded, getSessionSecret(env));
  return `${payloadEncoded}.${signature}`;
}

function getSessionSecret(env) {
  if (env.ADMIN_SESSION_SECRET) return env.ADMIN_SESSION_SECRET;
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  throw new Error("Missing env: ADMIN_SESSION_SECRET or ADMIN_PASSWORD");
}

async function signHmac(content, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let index = 0; index < a.length; index += 1) out |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return out === 0;
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    result[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1);
  }
  return result;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeChatGroups(groups) {
  if (!Array.isArray(groups)) return [];
  const map = new Map();
  for (const group of groups) {
    const tabName = String(group?.tabName || "").trim();
    const chatId = String(group?.chatId || "").trim();
    if (!tabName || !chatId) continue;
    map.set(chatId, { tabName, chatId });
  }
  return Array.from(map.values());
}

async function getChatGroups(env) {
  const fromKv = await env.SHEET_STATE_KV.get(CHAT_GROUPS_KV_KEY);
  if (fromKv) return sanitizeChatGroups(JSON.parse(fromKv));
  const initialGroups = sanitizeChatGroups(defaultChatGroups);
  await env.SHEET_STATE_KV.put(CHAT_GROUPS_KV_KEY, JSON.stringify(initialGroups));
  return initialGroups;
}

async function saveChatGroups(env, groups) {
  const sanitized = sanitizeChatGroups(groups);
  await env.SHEET_STATE_KV.put(CHAT_GROUPS_KV_KEY, JSON.stringify(sanitized));
}
