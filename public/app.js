/** API trên cùng origin (deploy). Khi mở index.html bằng file:// chỉ xem giao diện — không gọi được Worker. */
function apiUrl(path) {
  if (typeof location !== "undefined" && location.protocol === "file:") return null;
  const p = path.startsWith("/") ? path : `/${path}`;
  return new URL(p, location.origin).toString();
}

let dealerLabelName = "Tên đại lý (trùng cột D — tên khách trên Sheet)";
let dealerLabelChat = "Chat ID nhóm Telegram";
let dealerBtnRemove = "Xóa";
let dealerChatAddBtnLabel = "Thêm";
/** Gợi ý chân bảng + đếm sau lọc */
let dealerChatFootHintText =
  "Bấm « Lấy Chat ID nhóm » để nạp danh sách. « Tên đại lý » phải trùng cột D (tên khách) trên tab TINH_TIEN — Chat ID là nhóm nhận tin cho khách đó.";

/** Danh sách nhóm vừa gọi API getUpdates */
let cachedGroupChats = [];

/** Gợi ý / lỗi khi nạp tab Sheet cho broadcast */
let broadcastTabsEmptyText =
  "Chưa có đại lý nào có Chat ID — thêm ở tab « Đại lý & Chat ID » rồi quay lại đây.";
let broadcastTabsLoadErrText = "Không tải được danh sách đại lý.";

const ADMIN_TAB_KEY = "blackcorp_admin_tab";

function setTab(tab) {
  const tabs = ["dealers", "chat-filter", "sheet-pay", "debt-notify", "ket-qua", "broadcast"];
  const t = tabs.includes(tab) ? tab : "dealers";
  sessionStorage.setItem(ADMIN_TAB_KEY, t);
  for (const btn of document.querySelectorAll(".app-tab")) {
    const on = btn.dataset.tab === t;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.toggleAttribute("hidden", panel.dataset.panel !== t);
  }
  if (t === "broadcast") void loadBroadcastDealers();
  if (t === "debt-notify") void loadDebtNotifyStatus();
}

function restoreTab() {
  const saved = sessionStorage.getItem(ADMIN_TAB_KEY);
  setTab(
    saved === "dealers" ||
      saved === "chat-filter" ||
      saved === "sheet-pay" ||
      saved === "debt-notify" ||
      saved === "ket-qua" ||
      saved === "broadcast"
      ? saved
      : "dealers"
  );
}

async function loadText() {
  try {
    const res = await fetch(new URL("site-text.json", import.meta.url), { cache: "no-store" });
    if (!res.ok) return;
    const t = await res.json();
    if (t.pageTitle) document.title = t.pageTitle;
    if (t.brandNeon) document.getElementById("brandNeon").textContent = t.brandNeon;
    if (t.loginHeading) document.getElementById("loginHeading").textContent = t.loginHeading;
    if (t.loginLabelUser) document.getElementById("loginLabelUser").textContent = t.loginLabelUser;
    if (t.loginLabelPass) document.getElementById("loginLabelPass").textContent = t.loginLabelPass;
    if (t.loginPlaceholderUser)
      document.getElementById("loginUsername").placeholder = t.loginPlaceholderUser;
    if (t.loginButton) document.getElementById("loginButton").textContent = t.loginButton;
    if (t.logoutButton) document.getElementById("logoutButton").textContent = t.logoutButton;
    if (t.tabDealers) document.getElementById("tabDealers").textContent = t.tabDealers;
    if (t.tabChatFilter) document.getElementById("tabChatFilter").textContent = t.tabChatFilter;
    if (t.tabSheetPay) document.getElementById("tabSheetPay").textContent = t.tabSheetPay;
    if (t.tabDebtNotify) document.getElementById("tabDebtNotify").textContent = t.tabDebtNotify;
    if (t.tabKetQua) document.getElementById("tabKetQua").textContent = t.tabKetQua;
    if (t.tabBroadcast) document.getElementById("tabBroadcast").textContent = t.tabBroadcast;
    if (t.chatFilterHeading)
      document.getElementById("chatFilterHeading").textContent = t.chatFilterHeading;
    if (t.dealerHeading) document.getElementById("dealerHeading").textContent = t.dealerHeading;
    if (t.dealerHint) document.getElementById("dealerHint").textContent = t.dealerHint;
    if (t.dealerAddRow) document.getElementById("dealerAddRow").textContent = t.dealerAddRow;
    if (t.dealerSave) document.getElementById("dealerSave").textContent = t.dealerSave;
    if (t.sheetPayHeading) document.getElementById("sheetPayHeading").textContent = t.sheetPayHeading;
    if (t.sheetPayHint) document.getElementById("sheetPayHint").textContent = t.sheetPayHint;
    if (t.sheetPayLinkLabel) document.getElementById("lblSheetPayLink").textContent = t.sheetPayLinkLabel;
    if (t.sheetPayLinkHint) {
      const h = document.getElementById("sheetPayLinkSlotHint");
      if (h) h.textContent = t.sheetPayLinkHint;
    }
    if (t.sheetPayButton) document.getElementById("sendSheetPayment").textContent = t.sheetPayButton;
    if (t.debtNotifyHeading) document.getElementById("debtNotifyHeading").textContent = t.debtNotifyHeading;
    if (t.debtNotifyHint) document.getElementById("debtNotifyHint").textContent = t.debtNotifyHint;
    if (t.debtNotifyStatusLegend)
      document.getElementById("debtNotifyStatusLegend").textContent = t.debtNotifyStatusLegend;
    if (t.debtNotifyRefresh)
      document.getElementById("debtNotifyRefresh").textContent = t.debtNotifyRefresh;
    if (t.debtNotifyStatusFoot)
      document.getElementById("debtNotifyStatusFoot").textContent = t.debtNotifyStatusFoot;
    if (t.ketQuaHeading) document.getElementById("ketQuaHeading").textContent = t.ketQuaHeading;
    if (t.ketQuaIntro) document.getElementById("ketQuaIntro").textContent = t.ketQuaIntro;
    if (t.ketQuaLblLink) document.getElementById("ketQuaLblLink").textContent = t.ketQuaLblLink;
    if (t.ketQuaLblCampaignCol)
      document.getElementById("ketQuaLblCampaignCol").textContent = t.ketQuaLblCampaignCol;
    if (t.ketQuaLblCostCol) document.getElementById("ketQuaLblCostCol").textContent = t.ketQuaLblCostCol;
    if (t.ketQuaLblCurrencyCol)
      document.getElementById("ketQuaLblCurrencyCol").textContent = t.ketQuaLblCurrencyCol;
    if (t.ketQuaLblCap1) document.getElementById("ketQuaLblCap1").textContent = t.ketQuaLblCap1;
    if (t.ketQuaLblCap2) document.getElementById("ketQuaLblCap2").textContent = t.ketQuaLblCap2;
    if (t.ketQuaLblAccountNameCol)
      document.getElementById("ketQuaLblAccountNameCol").textContent = t.ketQuaLblAccountNameCol;
    if (t.ketQuaLblAccountName)
      document.getElementById("ketQuaLblAccountName").textContent = t.ketQuaLblAccountName;
    if (t.ketQuaRun) document.getElementById("ketQuaRun").textContent = t.ketQuaRun;
    if (t.formHeading) document.getElementById("formHeading").textContent = t.formHeading;
    if (t.broadcastCampHint)
      document.getElementById("broadcastCampHint").textContent = t.broadcastCampHint;
    if (t.broadcastTabsLegend)
      document.getElementById("broadcastTabsLegend").textContent = t.broadcastTabsLegend;
    if (t.broadcastSelectAll)
      document.getElementById("broadcastSelectAll").textContent = t.broadcastSelectAll;
    if (t.broadcastSelectNone)
      document.getElementById("broadcastSelectNone").textContent = t.broadcastSelectNone;
    if (t.broadcastTabsEmpty) broadcastTabsEmptyText = t.broadcastTabsEmpty;
    if (t.broadcastTabsLoadErr) broadcastTabsLoadErrText = t.broadcastTabsLoadErr;
    if (t.submitButton) document.getElementById("submitButton").textContent = t.submitButton;
    if (t.footerNote) document.getElementById("footerNote").textContent = t.footerNote;
    const L = t.labels || {};
    if (L.ngay) document.getElementById("lblNgay").textContent = L.ngay;
    if (L.mcc) document.getElementById("lblMcc").textContent = L.mcc;
    if (L.maCamp) document.getElementById("lblCamp").textContent = L.maCamp;
    if (L.rate) document.getElementById("lblRate").textContent = L.rate;
    if (L.rule) document.getElementById("lblRule").textContent = L.rule;
    if (L.dealerName) dealerLabelName = L.dealerName;
    if (L.dealerChat) dealerLabelChat = L.dealerChat;
    if (t.dealerRemove) dealerBtnRemove = t.dealerRemove;
    if (t.dealerFetchHint) document.getElementById("dealerFetchHint").textContent = t.dealerFetchHint;
    if (t.dealerFetchGroupChats)
      document.getElementById("dealerFetchGroupChats").textContent = t.dealerFetchGroupChats;
    if (t.dealerChatFilterLabel)
      document.getElementById("lblDealerChatFilter").textContent = t.dealerChatFilterLabel;
    const filt = document.getElementById("dealerChatFilter");
    if (t.dealerChatFilterPlaceholder) filt.placeholder = t.dealerChatFilterPlaceholder;
    if (t.dealerDownloadCsv) document.getElementById("dealerDownloadCsv").textContent = t.dealerDownloadCsv;
    if (t.dealerDownloadTxt) document.getElementById("dealerDownloadTxt").textContent = t.dealerDownloadTxt;
    if (t.dealerChatColTitle) document.getElementById("thChatTitle").textContent = t.dealerChatColTitle;
    if (t.dealerChatColUser) document.getElementById("thChatUser").textContent = t.dealerChatColUser;
    if (t.dealerChatColId) document.getElementById("thChatId").textContent = t.dealerChatColId;
    if (t.dealerChatColAct) document.getElementById("thChatAct").textContent = t.dealerChatColAct;
    if (t.dealerChatAddBtn) dealerChatAddBtnLabel = t.dealerChatAddBtn;
    if (t.dealerChatFootHint) dealerChatFootHintText = t.dealerChatFootHint;
  } catch {
    /* giữ mặc định trong HTML */
  }
}

function show(el, text, isErr) {
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function addDealerRow(name = "", chat = "") {
  const container = document.getElementById("dealerRows");
  const row = document.createElement("div");
  row.className = "dealer-row";
  row.innerHTML = `
    <label class="field"><span class="dealer-lbl-name"></span><input type="text" class="input rounded inp-name" autocomplete="off" /></label>
    <label class="field"><span class="dealer-lbl-chat"></span><input type="text" class="input rounded inp-chat" autocomplete="off" /></label>
    <button type="button" class="btn ghost btn-remove"></button>
  `;
  row.querySelector(".dealer-lbl-name").textContent = dealerLabelName;
  row.querySelector(".dealer-lbl-chat").textContent = dealerLabelChat;
  row.querySelector(".inp-name").value = name;
  row.querySelector(".inp-chat").value = chat;
  const rm = row.querySelector(".btn-remove");
  rm.textContent = dealerBtnRemove;
  rm.addEventListener("click", () => {
    row.remove();
    if (!document.querySelector(".dealer-row")) addDealerRow("", "");
  });
  container.appendChild(row);
}

function collectDealerMap() {
  const map = {};
  for (const row of document.querySelectorAll(".dealer-row")) {
    const n = row.querySelector(".inp-name").value.trim();
    const c = row.querySelector(".inp-chat").value.trim();
    if (!n) continue;
    map[n] = c;
  }
  return map;
}

function triggerDownload(filename, mime, body) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(cell) {
  const s = String(cell ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Lọc cachedGroupChats theo ô tìm kiếm */
function getFilteredGroupChats() {
  const raw = document.getElementById("dealerChatFilter").value.trim();
  const q = raw.toLowerCase();
  const qUser = q.startsWith("@") ? q.slice(1) : q;
  return cachedGroupChats.filter((c) => {
    if (!q) return true;
    const title = (c.title || "").toLowerCase();
    const user = String(c.username || "")
      .toLowerCase()
      .replace(/^@/, "");
    const idStr = String(c.id);
    return (
      title.includes(q) ||
      user.includes(qUser) ||
      idStr.includes(q.replace(/^-/, "")) ||
      idStr.includes(raw.trim())
    );
  });
}

function renderGroupChatTable() {
  const tbody = document.getElementById("dealerChatTableBody");
  const foot = document.getElementById("dealerChatTableFoot");
  tbody.replaceChildren();

  if (cachedGroupChats.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "chat-table-empty";
    td.textContent = "Chưa có dữ liệu — bấm « Lấy Chat ID nhóm ».";
    tr.appendChild(td);
    tbody.appendChild(tr);
    foot.textContent = dealerChatFootHintText;
    return;
  }

  const list = getFilteredGroupChats();
  if (list.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "chat-table-empty";
    td.textContent = "Không nhóm nào khớp bộ lọc — thử từ khóa khác.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    foot.textContent = `${dealerChatFootHintText} (0/${cachedGroupChats.length} sau lọc)`;
    return;
  }

  for (const c of list) {
    const tr = document.createElement("tr");
    const title = c.title || "(không tên)";
    const userDisp = c.username ? `@${c.username}` : "—";
    const idStr = String(c.id);
    const tabGuess = (c.title || c.username || "").trim();

    const td1 = document.createElement("td");
    td1.textContent = title;
    const td2 = document.createElement("td");
    td2.textContent = userDisp;
    const td3 = document.createElement("td");
    td3.textContent = idStr;
    td3.className = "mono-cell";

    const td4 = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost btn-sm";
    btn.textContent = dealerChatAddBtnLabel;
    btn.addEventListener("click", () => {
      addDealerRow(tabGuess, idStr);
      setTab("dealers");
      document.getElementById("dealerRows")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    td4.appendChild(btn);

    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tr.appendChild(td4);
    tbody.appendChild(tr);
  }

  foot.textContent = `${dealerChatFootHintText} Hiển thị ${list.length}/${cachedGroupChats.length} nhóm (sau lọc).`;
}

function downloadFilteredCsv() {
  const list = getFilteredGroupChats();
  if (list.length === 0) {
    const foot = document.getElementById("chatFilterMsg");
    show(foot, "Không có nhóm sau bộ lọc — xóa ô lọc hoặc chỉnh từ khóa.", true);
    foot.hidden = false;
    return;
  }
  const header = ["Ten_nhom_Telegram", "Username", "Chat_ID"];
  const lines = [
    header.join(","),
    ...list.map((c) =>
      [csvEscape(c.title || ""), csvEscape(c.username ? `@${c.username}` : ""), csvEscape(c.id)].join(
        ","
      )
    ),
  ];
  const body = "\uFEFF" + lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(`telegram-chat-id-${stamp}.csv`, "text/csv;charset=utf-8", body);
}

function downloadFilteredTxt() {
  const list = getFilteredGroupChats();
  if (list.length === 0) {
    const foot = document.getElementById("chatFilterMsg");
    show(foot, "Không có nhóm sau bộ lọc — xóa ô lọc hoặc chỉnh từ khóa.", true);
    foot.hidden = false;
    return;
  }
  const lines = list.map((c) => {
    const name = c.title || c.username || "(không tên)";
    return `${name}\t${c.id}`;
  });
  const body = lines.join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(`telegram-chat-id-${stamp}.txt`, "text/plain;charset=utf-8", body);
}

async function loadBroadcastDealers() {
  const grid = document.getElementById("broadcastTabChecks");
  const status = document.getElementById("broadcastTabsStatus");
  if (!grid || !status) return;
  status.hidden = true;
  status.classList.remove("err");
  const url = apiUrl("/api/dealer-map");
  if (!url) {
    grid.replaceChildren();
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Mở site qua Cloudflare (wrangler dev / deploy) để nạp danh sách đại lý.";
    grid.appendChild(p);
    return;
  }
  try {
    const res = await fetch(url, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      grid.replaceChildren();
      status.hidden = false;
      status.classList.add("err");
      status.textContent = "Phiên hết hạn — đăng nhập lại.";
      return;
    }
    if (!res.ok || !data.ok || !data.map || typeof data.map !== "object") {
      grid.replaceChildren();
      status.hidden = false;
      status.classList.add("err");
      status.textContent = data.error || broadcastTabsLoadErrText;
      return;
    }
    const map = data.map;
    const names = Object.keys(map).filter((k) => String(map[k] ?? "").trim() !== "");
    names.sort((a, b) => a.localeCompare(b, "vi"));
    grid.replaceChildren();
    if (names.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = broadcastTabsEmptyText;
      grid.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const name of names) {
      const lab = document.createElement("label");
      lab.className = "broadcast-tab-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.name = "broadcastDealer";
      cb.value = name;
      const span = document.createElement("span");
      span.textContent = name;
      lab.append(cb, span);
      frag.appendChild(lab);
    }
    grid.appendChild(frag);
  } catch {
    grid.replaceChildren();
    status.hidden = false;
    status.classList.add("err");
    status.textContent = broadcastTabsLoadErrText;
  }
}

async function loadDealerMapUI() {
  const url = apiUrl("/api/dealer-map");
  const container = document.getElementById("dealerRows");
  if (!url) {
    container.replaceChildren();
    addDealerRow("", "");
    return;
  }
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    container.replaceChildren();
    addDealerRow("", "");
    return;
  }
  const data = await res.json();
  const map = data.map && typeof data.map === "object" ? data.map : {};
  container.replaceChildren();
  const keys = Object.keys(map);
  if (keys.length === 0) {
    addDealerRow("", "");
  } else {
    for (const k of keys) {
      addDealerRow(k, map[k] ?? "");
    }
  }
}

async function refreshSession() {
  const url = apiUrl("/api/me");
  if (!url) {
    document.getElementById("gate").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    return false;
  }
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json();
  const ok = data.ok === true;
  document.getElementById("gate").classList.toggle("hidden", ok);
  document.getElementById("app").classList.toggle("hidden", !ok);
  if (ok) restoreTab();
  return ok;
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = apiUrl("/api/login");
  const fd = new FormData(e.target);
  const username = fd.get("username");
  const password = fd.get("password");
  const msg = document.getElementById("loginMsg");
  msg.hidden = true;
  if (!url) {
    show(msg, "Mở trang qua Cloudflare (wrangler dev / deploy), không dùng file:// để đăng nhập.", true);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    show(msg, data.error || "Đăng nhập thất bại", true);
    return;
  }
  const ok = await refreshSession();
  if (ok) await loadDealerMapUI();
});

document.getElementById("logoutButton").addEventListener("click", async () => {
  const url = apiUrl("/api/logout");
  if (url) await fetch(url, { method: "POST", credentials: "include" });
  sessionStorage.removeItem(ADMIN_TAB_KEY);
  cachedGroupChats = [];
  document.getElementById("dealerChatResults")?.classList.add("hidden");
  await refreshSession();
});

for (const btn of document.querySelectorAll(".app-tab")) {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
}

document.getElementById("dealerAddRow").addEventListener("click", () => addDealerRow("", ""));

document.getElementById("sendSheetPayment").addEventListener("click", async () => {
  const msg = document.getElementById("sheetPayMsg");
  msg.hidden = true;
  const url = apiUrl("/api/send-sheet-payment");
  if (!url) {
    show(msg, "Chỉ gửi được khi site chạy trên máy chủ (không dùng file://).", true);
    return;
  }
  const linkFiles = [...document.querySelectorAll("#sheetPayLinkRows input.sheet-pay-link-inp")]
    .sort((a, b) => Number(a.getAttribute("data-tab-index") || 0) - Number(b.getAttribute("data-tab-index") || 0))
    .map((el) => el.value.trim());
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ linkFiles }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    show(msg, "Phiên hết hạn — đăng nhập lại.", true);
    await refreshSession();
    return;
  }
  if (!res.ok || !data.ok) {
    show(msg, data.error || "Gửi lỗi", true);
    return;
  }
  show(msg, data.message || "Đã nhận — bot đang gửi thanh toán…", false);
});

document.getElementById("dealerFetchGroupChats").addEventListener("click", async () => {
  const msg = document.getElementById("chatFilterMsg");
  const results = document.getElementById("dealerChatResults");
  msg.hidden = true;
  const url = apiUrl("/api/telegram-group-chats");
  if (!url) {
    show(msg, "Chỉ chạy khi đăng nhập trên site deploy.", true);
    return;
  }
  show(msg, "Đang tải danh sách từ Telegram…", false);
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    show(msg, data.error || "Phiên hết hạn — đăng nhập lại.", true);
    await refreshSession();
    return;
  }
  if (!res.ok || !data.ok) {
    show(msg, data.error || `Lỗi máy chủ (${res.status})`, true);
    return;
  }
  cachedGroupChats = Array.isArray(data.chats) ? data.chats : [];
  document.getElementById("dealerChatFilter").value = "";
  results.classList.remove("hidden");
  renderGroupChatTable();

  let okMsg =
    cachedGroupChats.length > 0
      ? `Đã gom ${cachedGroupChats.length} nhóm (${data.updatesConsumed ?? 0} update đã đọc). Lọc và tải file nếu cần.`
      : (data.warning || "Không thấy nhóm trong hàng đợi.") + (data.note ? " " + data.note : "");
  show(msg, okMsg, cachedGroupChats.length === 0);
});

document.getElementById("dealerChatFilter").addEventListener("input", () => renderGroupChatTable());
document.getElementById("dealerDownloadCsv").addEventListener("click", () => {
  if (cachedGroupChats.length === 0) return;
  downloadFilteredCsv();
});
document.getElementById("dealerDownloadTxt").addEventListener("click", () => {
  if (cachedGroupChats.length === 0) return;
  downloadFilteredTxt();
});

document.getElementById("broadcastSelectAll").addEventListener("click", () => {
  for (const el of document.querySelectorAll('#broadcastTabChecks input[name="broadcastDealer"]')) {
    el.checked = true;
  }
});
document.getElementById("broadcastSelectNone").addEventListener("click", () => {
  for (const el of document.querySelectorAll('#broadcastTabChecks input[name="broadcastDealer"]')) {
    el.checked = false;
  }
});

function fmtVNDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  } catch {
    return iso;
  }
}

function renderCongNoPreview(resOk, payload) {
  const meta = document.getElementById("congNoPreviewMeta");
  const tbody = document.getElementById("congNoPreviewBody");
  const hint = document.getElementById("congNoPreviewMsg");
  if (!meta || !tbody || !hint) return;
  tbody.replaceChildren();
  hint.hidden = true;
  hint.textContent = "";
  hint.classList.remove("err");

  if (!resOk || !payload || !payload.ok) {
    hint.hidden = false;
    hint.classList.add("err");
    hint.textContent = (payload && payload.error) || "Không đọc được bảng CONG_NO.";
    meta.textContent = "";
    return;
  }

  const id = String(payload.spreadsheetId ?? "").trim();
  const tab = String(payload.tabName ?? "CONG_NO").trim();
  const link = id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : "";
  meta.textContent = link ? `Nguồn: « ${tab} » — ${link}` : `Tab: « ${tab} »`;

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  for (const r of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = r.maDl != null ? String(r.maDl) : "";
    const td2 = document.createElement("td");
    td2.textContent = r.noCu != null ? String(r.noCu) : "";
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    hint.hidden = false;
    hint.textContent =
      "Không có dòng A2:B hợp lệ (cần đủ cả tên cột A và nợ cột B sau khi trim).";
  }
}

async function loadDebtNotifyStatus() {
  const summary = document.getElementById("debtNotifyStatusSummary");
  const list = document.getElementById("debtNotifySentList");
  const errEl = document.getElementById("debtNotifyErrors");
  if (!summary || !list || !errEl) return;

  summary.textContent = "Đang tải…";
  list.replaceChildren();
  errEl.hidden = true;
  errEl.textContent = "";
  errEl.classList.remove("err");

  const base = apiUrl("/api/debt-notify-status");
  const congUrl = apiUrl("/api/cong-no-preview");
  if (!base || !congUrl) {
    summary.textContent = "Chỉ xem được khi mở site qua Worker (không dùng file://).";
    renderCongNoPreview(false, { ok: false, error: "Không gọi được API." });
    return;
  }

  const [resStatus, resCong] = await Promise.all([
    fetch(base, { credentials: "include" }),
    fetch(congUrl, { credentials: "include" }),
  ]);
  const dataCong = await resCong.json().catch(() => ({}));
  renderCongNoPreview(resCong.ok, dataCong);

  const data = await resStatus.json().catch(() => ({}));
  if (resStatus.status === 401) {
    summary.textContent = "Phiên hết hạn — đăng nhập lại.";
    await refreshSession();
    return;
  }
  if (!resStatus.ok || !data.ok) {
    summary.textContent = data.error || "Không đọc được trạng thái.";
    return;
  }

  const run = data.run;
  if (!run) {
    summary.textContent =
      "Chưa có lần chạy nào được lưu — chờ cron 22h (giờ VN) hoặc kiểm tra Worker có KV STORE.";
    return;
  }

  const modeLabel =
    run.mode === "queue"
      ? "Hàng đợi (Queue)"
      : run.mode === "inline"
        ? "Gửi trực tiếp (không Queue)"
        : "Không có tin trong đợt";

  const okCount = Array.isArray(run.sentOk) ? run.sentOk.length : 0;
  const errCount = Array.isArray(run.errors) ? run.errors.length : 0;
  const uniqOk = okCount ? new Set(run.sentOk).size : 0;

  const lines = [];
  lines.push(`Phiên: ${run.runId}`);
  lines.push(`Bắt đầu (giờ Việt Nam): ${fmtVNDateTime(run.startedAt)}`);
  if (run.finishedAt) lines.push(`Kết thúc (giờ Việt Nam): ${fmtVNDateTime(run.finishedAt)}`);
  lines.push(`Chế độ: ${modeLabel}`);
  lines.push(`Tổng trong đợt (đủ tab đại lý + Chat ID): ${run.totalQueued} tin`);
  lines.push(`Đã gửi thành công (theo lần gửi): ${okCount} / ${run.totalQueued}`);
  if (okCount && uniqOk !== okCount) lines.push(`Trong đó ${uniqOk} mã đại lý khác nhau (có thể trùng dòng CONG_NO).`);

  if (run.totalQueued === 0) {
    lines.push("Không có đại lý nào đủ điều kiện trong lần cron gần nhất.");
  } else if (run.complete) {
    if (errCount === 0 && okCount >= run.totalQueued) {
      lines.push("Trạng thái: đã gửi xong toàn bộ đợt (không có lỗi ghi nhận).");
    } else if (errCount > 0) {
      lines.push(`Trạng thái: đợt đã kết thúc — có ${errCount} tin lỗi (xem danh sách lỗi bên dưới).`);
    } else {
      lines.push("Trạng thái: đợt đánh dấu hoàn thành — kiểm tra Queue nếu kỳ vọng chưa đủ tin.");
    }
  } else {
    lines.push("Trạng thái: đang xử lý — với Queue, tin có thể đến vài phút sau 22h.");
  }

  summary.textContent = lines.join("\n");

  for (const ma of run.sentOk || []) {
    const li = document.createElement("li");
    li.textContent = String(ma);
    list.appendChild(li);
  }

  if (errCount > 0) {
    errEl.hidden = false;
    errEl.classList.add("err");
    errEl.textContent = run.errors
      .map((e) => `${e.maDl}: ${e.detail}`)
      .join("\n");
  }
}

document.getElementById("debtNotifyRefresh").addEventListener("click", () => {
  void loadDebtNotifyStatus();
});

document.getElementById("ketQuaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("ketQuaMsg");
  msg.hidden = true;
  const url = apiUrl("/api/run-ket-qua");
  if (!url) {
    show(msg, "Chỉ chạy được khi site trên Worker.", true);
    return;
  }
  const body = {
    spreadsheetUrlOrId: document.getElementById("ketQuaSpreadsheetUrl").value.trim(),
    campaignCol: document.getElementById("ketQuaCampaignCol").value.trim(),
    costCol: document.getElementById("ketQuaCostCol").value.trim(),
    currencyCol: document.getElementById("ketQuaCurrencyCol").value.trim(),
    cap1Code: document.getElementById("ketQuaCap1").value.trim(),
    cap2Codes: document.getElementById("ketQuaCap2").value.trim(),
    accountNameCol: document.getElementById("ketQuaAccountNameCol").value.trim(),
    accountName: document.getElementById("ketQuaAccountName").value.trim(),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    show(msg, "Phiên hết hạn — đăng nhập lại.", true);
    await refreshSession();
    return;
  }
  if (!res.ok || !data.ok) {
    show(msg, data.error || "Chạy thất bại", true);
    return;
  }
  show(msg, data.message || "Đã xong.", false);
});

document.getElementById("dealerSave").addEventListener("click", async () => {
  const msg = document.getElementById("dealerMsg");
  msg.hidden = true;
  const url = apiUrl("/api/dealer-map");
  if (!url) {
    show(msg, "Chỉ lưu được khi chạy trên máy chủ (wrangler dev / deploy).", true);
    return;
  }
  const map = collectDealerMap();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ map }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    show(msg, "Phiên hết hạn — đăng nhập lại.", true);
    await refreshSession();
    return;
  }
  if (!res.ok || !data.ok) {
    show(msg, data.error || "Lưu lỗi", true);
    return;
  }
  show(msg, "Đã lưu cấu hình đại lý / Chat ID.", false);
  void loadBroadcastDealers();
});

document.getElementById("sendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = apiUrl("/api/send-manual");
  const fd = new FormData(e.target);
  const msg = document.getElementById("sendMsg");
  msg.hidden = true;
  if (!url) {
    show(msg, "Gửi form chỉ hoạt động khi site chạy trên máy chủ (không dùng file://).", true);
    return;
  }
  const selectedDealers = [
    ...document.querySelectorAll('#broadcastTabChecks input[name="broadcastDealer"]:checked'),
  ].map((el) => el.value);
  if (selectedDealers.length === 0) {
    show(msg, "Chọn ít nhất một đại lý (nhóm cần gửi).", true);
    return;
  }
  const body = {
    ngay: fd.get("ngay"),
    mcc: fd.get("mcc"),
    maCampPrefix: fd.get("maCampPrefix"),
    rate: fd.get("rate"),
    rule: fd.get("rule"),
    selectedDealers,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    show(msg, "Phiên hết hạn — đăng nhập lại.", true);
    await refreshSession();
    return;
  }
  if (!res.ok || !data.ok) {
    show(msg, data.error || "Gửi lỗi", true);
    return;
  }
  show(msg, data.message || "Đã nhận — bot đang gửi.", false);
});

await loadText();
const loggedIn = await refreshSession();
if (loggedIn) await loadDealerMapUI();
