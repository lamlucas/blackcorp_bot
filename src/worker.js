import defaultChatGroups from "./chat-groups.json";
import indexHtml from "./index.html";

const SHEET_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const ADMIN_USERNAME = "Black777777";
const SESSION_COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;
const CHAT_GROUPS_KV_KEY = "chat-groups:v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAuthenticated = await verifyAdminSession(request, env);

    if (request.method === "GET" && url.pathname === "/login") {
      if (isAuthenticated) return redirectResponse("/");
      return new Response(renderLoginHtml(), htmlHeaders());
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
      const result = await syncSheetToTelegram(env);
      return jsonResponse({ ok: true, result });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(syncSheetToTelegram(env));
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

async function syncSheetToTelegram(env) {
  validateEnvForSheetSync(env);
  const groups = await getChatGroups(env);
  const accessToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const summary = [];

  for (const group of groups) {
    const stateKey = `sheet-last-row:${group.tabName}`;
    const values = await readSheetTab(env.GOOGLE_SHEET_ID, group.tabName, accessToken);
    if (!values.length) {
      summary.push({ tabName: group.tabName, sent: 0, note: "No data rows" });
      continue;
    }

    const headers = values[0];
    const dataRows = values.slice(1);
    const storedLastRow = await env.SHEET_STATE_KV.get(stateKey);
    if (storedLastRow === null) {
      await env.SHEET_STATE_KV.put(stateKey, String(dataRows.length));
      summary.push({ tabName: group.tabName, sent: 0, note: "Initialized checkpoint" });
      continue;
    }

    const newRows = dataRows.slice(Number(storedLastRow));
    let sentCount = 0;
    for (const row of newRows) {
      const message = buildSheetMessage(headers, row);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, group.chatId, message);
      sentCount += 1;
    }

    await env.SHEET_STATE_KV.put(stateKey, String(dataRows.length));
    summary.push({ tabName: group.tabName, sent: sentCount });
  }
  return { groups: summary };
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

function buildSheetMessage(headers, row) {
  const labels = ["NGAY", "MCC", "TONG TIEU", "TIEN TE", "QUY DOI USD", "RATE", "THUC THU"];
  const values = labels.map((label, index) => {
    const headerIndex = findHeaderIndex(headers, label);
    if (headerIndex >= 0) return row[headerIndex] || "";
    return row[index] || "";
  });
  return [
    `NGAY: <b>${escapeHtml(values[0])}</b>`,
    `MCC: <b>${escapeHtml(values[1])}</b>`,
    `TONG TIEU: <b>${escapeHtml(values[2])}</b>`,
    `TIEN TE: <b>${escapeHtml(values[3])}</b>`,
    `QUY DOI USD: <b>${escapeHtml(values[4])}</b>`,
    `RATE: <b>${escapeHtml(values[5])}</b>`,
    `THUC THU: <b>${escapeHtml(values[6])}</b>`
  ].join("\n");
}

function findHeaderIndex(headers, expectedLabel) {
  const normalizedExpected = normalizeLabel(expectedLabel);
  return headers.findIndex((header) => normalizeLabel(header) === normalizedExpected);
}

function normalizeLabel(value) {
  return String(value || "").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram sendMessage failed");
}

async function readSheetTab(sheetId, tabName, accessToken) {
  const range = encodeURIComponent(`${tabName}!A:Z`);
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

function renderLoginHtml() {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin Login</title>
    <style>
      :root { --bg:#090b16; --card:#131a33; --text:#e8edff; --accent:#1de9ff; --accent2:#ff3ecf; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Arial,sans-serif; color:var(--text); background:radial-gradient(circle at top,#101c45 0%,var(--bg) 45%); }
      .card { width:min(92vw,430px); background:rgba(19,26,51,.92); border:1px solid rgba(255,255,255,.12); border-radius:18px; padding:22px; }
      .title { text-align:center; font-size:26px; font-weight:700; margin-bottom:14px; text-shadow:0 0 8px var(--accent),0 0 16px var(--accent),0 0 30px var(--accent2); }
      .sub { text-align:center; font-size:13px; opacity:.9; margin-bottom:16px; }
      label { display:block; margin-bottom:6px; font-weight:600; font-size:14px; }
      input { width:100%; margin-bottom:12px; border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.06); color:#fff; border-radius:12px; padding:11px 13px; outline:none; }
      input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(29,233,255,.22); }
      button { width:100%; border:0; border-radius:12px; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; font-weight:700; font-size:15px; padding:11px 14px; cursor:pointer; }
      .status { margin-top:12px; min-height:18px; text-align:center; font-size:14px; color:#ff9db9; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">ADMIN LOGIN</div>
      <div class="sub">Username co dinh: <b>${ADMIN_USERNAME}</b></div>
      <form id="login-form">
        <label for="username">Username</label>
        <input id="username" name="username" value="${ADMIN_USERNAME}" required />
        <label for="password">Mat khau</label>
        <input id="password" name="password" type="password" required />
        <button type="submit">Dang nhap</button>
      </form>
      <div id="status" class="status"></div>
    </div>
    <script>
      const form = document.getElementById("login-form");
      const statusEl = document.getElementById("status");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        statusEl.textContent = "";
        const formData = new FormData(form);
        const payload = { username: formData.get("username"), password: formData.get("password") };
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          statusEl.textContent = result.error || "Dang nhap that bai";
          return;
        }
        window.location.href = "/";
      });
    </script>
  </body>
</html>`;
}
