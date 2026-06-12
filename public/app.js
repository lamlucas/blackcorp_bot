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
  "Bấm « Lấy Chat ID nhóm » để nạp danh sách. « Tên đại lý » phải trùng cột D (tên khách) trên tab BAO_CAO_TK — Chat ID là nhóm nhận tin cho khách đó.";

/** Danh sách nhóm vừa gọi API getUpdates */
let cachedGroupChats = [];

/** Gợi ý / lỗi khi nạp tab Sheet cho broadcast */
let broadcastTabsEmptyText =
  "Chưa có đại lý nào có Chat ID — thêm ở tab « Đại lý & Chat ID » rồi quay lại đây.";
let broadcastTabsLoadErrText = "Không tải được danh sách đại lý.";

const ADMIN_TAB_KEY = "blackcorp_admin_tab";
const ADMIN_TABS = ["dealers", "chat-filter", "sheet-pay", "coc", "cham-cong", "debt-notify", "ket-qua", "ket-qua-files", "broadcast", "email"];
let chamCongSelectedTab = "";
const CHAM_CONG_TEMPLATE_TAB = "SUBEO";

function isChamCongTemplateTab(tabName) {
  const key = String(tabName ?? "").trim().toLowerCase().replace(/[_\s-]+/g, "");
  return key === "subeo";
}

let cocRowsCache = [];
/** @type {Map<number, { ngay: string, thu: string, chi: string, ten: string, note: string }>} */
let cocOriginalBySheetRow = new Map();
let cocMaxSheetRow = 1;

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Ngày hiện tại giờ Việt Nam (dd/mm/yyyy). */
function formatNgayVietnamNow() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
}

function updateBroadcastNgayDisplay() {
  const el = document.getElementById("broadcastNgayDisplay");
  if (el) el.textContent = formatNgayVietnamNow();
}

/** Tách textarea thành mảng — mỗi dòng một giá trị. */
function parseMultilineField(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Màu chữ cái / số đầu tên đại lý trong lưới chọn. */
const DEALER_FIRST_CHAR_COLORS = {
  digit: "#f5f5f5",
  A: "#ffeb3b",
  B: "#42a5f5",
  C: "#66bb6a",
  D: "#ff7043",
  E: "#ab47bc",
  F: "#26c6da",
  G: "#ffa726",
  H: "#ec407a",
  I: "#7e57c2",
  J: "#29b6f6",
  K: "#9ccc65",
  L: "#ef5350",
  M: "#5c6bc0",
  N: "#26a69a",
  O: "#ffca28",
  P: "#8d6e63",
  Q: "#78909c",
  R: "#ff8a65",
  S: "#ba68c8",
  T: "#4dd0e1",
  U: "#aed581",
  V: "#9575cd",
  W: "#4db6ac",
  X: "#f06292",
  Y: "#fff176",
  Z: "#90caf9",
};

function dealerFirstCharColor(ch) {
  if (!ch) return "#e0e0e0";
  if (/\d/.test(ch)) return DEALER_FIRST_CHAR_COLORS.digit;
  const u = ch.toUpperCase();
  return DEALER_FIRST_CHAR_COLORS[u] ?? "#e0e0e0";
}

function appendDealerLabel(parent, name, opts = {}) {
  parent.replaceChildren();
  if (!name) return;
  const hideLeading = opts.hideLeadingChar === true;
  const first = name.charAt(0);
  if (hideLeading) {
    parent.textContent = name;
    return;
  }
  const firstSpan = document.createElement("span");
  firstSpan.className = "dealer-first-char";
  firstSpan.textContent = first;
  firstSpan.style.color = dealerFirstCharColor(first);
  const restSpan = document.createElement("span");
  restSpan.textContent = name.slice(1);
  parent.append(firstSpan, restSpan);
}

function dealerLeadingGroupKey(name) {
  const ch = String(name ?? "").charAt(0);
  if (!ch) return "#";
  if (/\d/.test(ch)) return "0-9";
  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  return "#";
}

/** Gom tên đại lý đã sort thành các cụm cùng ký tự đầu. */
function groupDealerNamesByFirstChar(names) {
  const groups = [];
  let current = null;
  for (const name of names) {
    const key = dealerLeadingGroupKey(name);
    if (!current || current.key !== key) {
      current = { key, names: [] };
      groups.push(current);
    }
    current.names.push(name);
  }
  return groups;
}

function createBroadcastDealerCheckbox(name) {
  const lab = document.createElement("label");
  lab.className = "broadcast-tab-item";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.name = "broadcastDealer";
  cb.value = name;
  const span = document.createElement("span");
  span.className = "broadcast-tab-label";
  span.textContent = name;
  lab.append(cb, span);
  return lab;
}

function closeNavDrawer() {
  const drawer = document.getElementById("navDrawer");
  const toggle = document.getElementById("navMenuToggle");
  drawer?.classList.remove("is-open");
  toggle?.setAttribute("aria-expanded", "false");
  window.setTimeout(() => {
    if (!drawer?.classList.contains("is-open")) drawer?.setAttribute("hidden", "");
  }, 220);
}

function openNavDrawer() {
  const drawer = document.getElementById("navDrawer");
  const toggle = document.getElementById("navMenuToggle");
  drawer?.removeAttribute("hidden");
  void drawer?.offsetWidth;
  drawer?.classList.add("is-open");
  toggle?.setAttribute("aria-expanded", "true");
}

function toggleNavDrawer() {
  const drawer = document.getElementById("navDrawer");
  if (drawer?.classList.contains("is-open")) closeNavDrawer();
  else openNavDrawer();
}

function setTab(tab) {
  const t = ADMIN_TABS.includes(tab) ? tab : "dealers";
  sessionStorage.setItem(ADMIN_TAB_KEY, t);
  closeNavDrawer();
  for (const btn of document.querySelectorAll(".nav-drawer-item")) {
    btn.classList.toggle("active", btn.dataset.tab === t);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const on = panel.dataset.panel === t;
    panel.toggleAttribute("hidden", !on);
    panel.classList.remove("panel-zoom-enter");
    if (on) {
      void panel.offsetWidth;
      panel.classList.add("panel-zoom-enter");
    }
  }
  if (t === "broadcast") {
    updateBroadcastNgayDisplay();
    void loadBroadcastDealers();
  }
  if (t === "debt-notify") void loadDebtNotifyStatus();
  if (t === "coc") void loadCocTable();
  if (t === "cham-cong") void loadChamCongPanel();
  if (t === "email") void loadMailListPanel();
}

function restoreTab() {
  const saved = sessionStorage.getItem(ADMIN_TAB_KEY);
  setTab(ADMIN_TABS.includes(saved) ? saved : "dealers");
}

function fmtMoneyDisplay(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x === 0) return "";
  return x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function normalizeCocMoneyInput(v) {
  return String(v ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(/,/g, "");
}

function cocRowSnapshot(r) {
  return {
    ngay: String(r.ngay ?? "").trim(),
    thu: normalizeCocMoneyInput(r.thu),
    chi: normalizeCocMoneyInput(r.chi),
    ten: String(r.ten ?? "").trim(),
    note: String(r.note ?? "").trim(),
  };
}

function cocRowDiffers(a, b) {
  const left = cocRowSnapshot(a);
  const right = cocRowSnapshot(b);
  return (
    left.ngay !== right.ngay ||
    left.thu !== right.thu ||
    left.chi !== right.chi ||
    left.ten !== right.ten ||
    left.note !== right.note
  );
}

function rebuildCocOriginal(rows) {
  cocOriginalBySheetRow = new Map();
  cocMaxSheetRow = 1;
  for (const r of rows) {
    const sheetRow = Number(r.sheetRow);
    if (!Number.isFinite(sheetRow) || sheetRow < 2) continue;
    cocOriginalBySheetRow.set(sheetRow, cocRowSnapshot(r));
    cocMaxSheetRow = Math.max(cocMaxSheetRow, sheetRow);
  }
}

function renderCocTable(rows) {
  cocRowsCache = rows.map((r) => ({
    sheetRow: r.sheetRow ?? null,
    ngay: r.ngay ?? "",
    thu: r.thu ?? "",
    chi: r.chi ?? "",
    ten: r.ten ?? "",
    note: r.note ?? "",
  }));
  const tb = document.getElementById("cocTableBody");
  if (!tb) return;
  tb.innerHTML = "";
  for (let i = 0; i < cocRowsCache.length; i++) {
    const r = cocRowsCache[i];
    const tr = document.createElement("tr");
    if (r.sheetRow) tr.dataset.sheetRow = String(r.sheetRow);
    tr.innerHTML = `
      <td><input type="text" data-coc="ngay" data-idx="${i}" value="${escapeAttr(r.ngay)}" /></td>
      <td class="th-num"><input type="text" data-coc="thu" data-idx="${i}" value="${escapeAttr(fmtMoneyDisplay(r.thu))}" /></td>
      <td class="th-num"><input type="text" data-coc="chi" data-idx="${i}" value="${escapeAttr(fmtMoneyDisplay(r.chi))}" /></td>
      <td><input type="text" data-coc="ten" data-idx="${i}" value="${escapeAttr(r.ten)}" /></td>
      <td><input type="text" data-coc="note" data-idx="${i}" value="${escapeAttr(r.note)}" /></td>
      <td><button type="button" class="btn ghost btn-row-del" data-coc-del="${i}">×</button></td>`;
    tb.appendChild(tr);
  }
}

function collectCocRowsFromDom() {
  const tb = document.getElementById("cocTableBody");
  if (!tb) return [];
  const rows = [];
  for (const tr of tb.querySelectorAll("tr")) {
    const get = (f) => tr.querySelector(`input[data-coc="${f}"]`)?.value?.trim() ?? "";
    const sheetRowRaw = tr.dataset.sheetRow;
    rows.push({
      sheetRow: sheetRowRaw ? Number(sheetRowRaw) : null,
      ngay: get("ngay"),
      thu: get("thu"),
      chi: get("chi"),
      ten: get("ten"),
      note: get("note"),
    });
  }
  while (rows.length > 0) {
    const r = rows[rows.length - 1];
    if (r.ngay || r.ten || r.note || r.thu || r.chi) break;
    rows.pop();
  }
  return rows;
}

function getCocRowsToSave() {
  const current = collectCocRowsFromDom();
  const updates = [];
  let nextRow = cocMaxSheetRow + 1;
  for (const row of current) {
    const payload = {
      ngay: row.ngay,
      thu: row.thu,
      chi: row.chi,
      ten: row.ten,
      note: row.note,
    };
    if (row.sheetRow) {
      const orig = cocOriginalBySheetRow.get(row.sheetRow);
      if (!orig || cocRowDiffers(row, orig)) {
        updates.push({ sheetRow: row.sheetRow, ...payload });
      }
      continue;
    }
    if (row.ngay || row.ten || row.note || row.thu || row.chi) {
      updates.push({ sheetRow: nextRow, ...payload });
      nextRow++;
    }
  }
  return updates;
}

function renderChamCongTable(rows) {
  const tbody = document.getElementById("chamCongTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const tdNgay = document.createElement("td");
    tdNgay.textContent = row.ngay ?? "";
    const tdTick = document.createElement("td");
    tdTick.textContent = row.chamCong ? "✓" : "";
    tdTick.className = "td-center";
    const tdTien = document.createElement("td");
    tdTien.textContent = fmtMoneyDisplay(row.tienUng) || String(row.tienUng ?? "");
    tdTien.className = "td-num";
    const tdThuong = document.createElement("td");
    tdThuong.textContent = fmtMoneyDisplay(row.thuong) || String(row.thuong ?? "");
    tdThuong.className = "td-num";
    tr.append(tdNgay, tdTick, tdTien, tdThuong);
    tbody.appendChild(tr);
  }
}

function isoDateInputToVn(iso) {
  const m = String(iso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso ?? "").trim();
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function todayIsoDateInput() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fillChamCongEmployeeSelect(employees, selectedTab) {
  const sel = document.getElementById("chamCongEmployeeSelect");
  if (!sel) return;
  sel.innerHTML = "";
  for (const e of employees) {
    const opt = document.createElement("option");
    opt.value = e.tabName;
    opt.textContent = `${e.telegramName} → ${e.tabName}`;
    if (e.tabName === selectedTab) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderChamCongEmployeeTable(employees) {
  const tbody = document.getElementById("chamCongEmployeeTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const e of employees) {
    const tr = document.createElement("tr");
    const tdTg = document.createElement("td");
    tdTg.textContent = e.telegramName ?? "";
    const tdTab = document.createElement("td");
    tdTab.textContent = e.tabName ?? "";
    const tdAct = document.createElement("td");
    tdAct.className = "td-actions";
    const isTemplate = isChamCongTemplateTab(e.tabName);
    if (!isTemplate) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn ghost btn-sm nav-menu-item-danger";
      btn.textContent = "Xóa";
      btn.setAttribute("data-cham-cong-del", e.tabName);
      btn.title = `Xóa tab ${e.tabName}`;
      tdAct.appendChild(btn);
    } else {
      tdAct.textContent = "Tab mẫu";
      tdAct.className = "td-actions hint";
    }
    tr.append(tdTg, tdTab, tdAct);
    tbody.appendChild(tr);
  }
}

function updateChamCongDeleteButton(tabName) {
  const btn = document.getElementById("chamCongDeleteEmployee");
  if (!btn) return;
  const blocked = !tabName || isChamCongTemplateTab(tabName);
  btn.disabled = blocked;
  btn.title = blocked ? "Không xóa được tab mẫu Subeo" : `Xóa tab ${tabName}`;
}

async function loadChamCongPanel() {
  const msg = document.getElementById("chamCongMsg");
  if (msg) msg.hidden = true;
  const url = apiUrl(
    `/api/cham-cong${chamCongSelectedTab ? `?tab=${encodeURIComponent(chamCongSelectedTab)}` : ""}`,
  );
  if (!url) return;
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Không tải chấm công.", true);
    return;
  }
  chamCongSelectedTab = data.tabName || chamCongSelectedTab;
  const employees = data.employees ?? [];
  fillChamCongEmployeeSelect(employees, data.tabName ?? "");
  renderChamCongEmployeeTable(employees);
  updateChamCongDeleteButton(data.tabName ?? chamCongSelectedTab);
  const ngayInput = document.getElementById("chamCongNgayThuong");
  if (ngayInput && !ngayInput.value) ngayInput.value = todayIsoDateInput();
  renderChamCongTable(data.rows ?? []);
}

async function saveChamCongThuong() {
  const msg = document.getElementById("chamCongMsg");
  const url = apiUrl("/api/cham-cong");
  const tabName = document.getElementById("chamCongEmployeeSelect")?.value?.trim() ?? chamCongSelectedTab;
  const ngayIso = document.getElementById("chamCongNgayThuong")?.value ?? "";
  const ngay = isoDateInputToVn(ngayIso);
  const thuong = document.getElementById("chamCongThuong")?.value ?? "";
  if (!url || !tabName) {
    if (msg) show(msg, "Chọn nhân viên trước.", true);
    return;
  }
  if (!ngay) {
    if (msg) show(msg, "Chọn ngày thưởng.", true);
    return;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ tabName, ngay, thuong }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Lưu lỗi.", true);
    return;
  }
  if (msg) show(msg, data.message || "Đã lưu.", false);
  chamCongSelectedTab = tabName;
  await loadChamCongPanel();
}

async function deleteChamCongEmployee(tabName) {
  const msg = document.getElementById("chamCongMsg");
  const name = String(tabName ?? "").trim();
  if (!name) {
    if (msg) show(msg, "Chọn tab cần xóa.", true);
    return;
  }
  if (isChamCongTemplateTab(name)) {
    if (msg) show(msg, "Không thể xóa tab mẫu Subeo.", true);
    return;
  }
  const label = document.getElementById("chamCongEmployeeSelect")?.selectedOptions?.[0]?.textContent ?? name;
  if (!confirm(`Xóa nhân viên/tab « ${label} »? Tab Sheet sẽ bị xóa vĩnh viễn.`)) return;

  const url = apiUrl("/api/cham-cong/employees");
  if (!url) {
    if (msg) show(msg, "Chỉ xóa được khi chạy trên server.", true);
    return;
  }
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ tabName: name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Xóa lỗi.", true);
    return;
  }
  if (msg) show(msg, data.message || "Đã xóa.", false);
  if (chamCongSelectedTab === name) chamCongSelectedTab = "";
  await loadChamCongPanel();
}

async function addChamCongEmployee() {
  const msg = document.getElementById("chamCongMsg");
  const url = apiUrl("/api/cham-cong/employees");
  const telegramName = document.getElementById("chamCongTelegramName")?.value?.trim() ?? "";
  const tabName = document.getElementById("chamCongTabName")?.value?.trim() ?? "";
  if (!url || !telegramName) {
    if (msg) show(msg, "Nhập tên Telegram nhân viên.", true);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ telegramName, tabName: tabName || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Tạo tab lỗi.", true);
    return;
  }
  if (msg) show(msg, data.message || "Đã tạo.", false);
  chamCongSelectedTab = data.tabName || tabName;
  const tgInput = document.getElementById("chamCongTelegramName");
  const tabInput = document.getElementById("chamCongTabName");
  if (tgInput) tgInput.value = "";
  if (tabInput) tabInput.value = "";
  await loadChamCongPanel();
}

async function loadCocTable() {
  const msg = document.getElementById("cocMsg");
  if (msg) msg.hidden = true;
  const url = apiUrl("/api/coc");
  if (!url) return;
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Không tải tab COC.", true);
    return;
  }
  const rows = data.rows ?? [];
  renderCocTable(rows);
  rebuildCocOriginal(rows);
}

async function saveCocTable() {
  const msg = document.getElementById("cocMsg");
  const url = apiUrl("/api/coc");
  if (!url) {
    if (msg) show(msg, "Chỉ lưu được khi chạy trên server.", true);
    return;
  }
  const rows = getCocRowsToSave();
  if (rows.length === 0) {
    if (msg) show(msg, "Không có dòng nào thay đổi.", false);
    return;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ rows }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Lưu lỗi.", true);
    return;
  }
  if (msg) show(msg, data.message || "Đã lưu.", false);
  await loadCocTable();
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
    if (t.tabCoc) document.getElementById("tabCoc").textContent = t.tabCoc;
    if (t.tabDebtNotify) document.getElementById("tabDebtNotify").textContent = t.tabDebtNotify;
    if (t.tabKetQua) document.getElementById("tabKetQua").textContent = t.tabKetQua;
    if (t.tabKetQuaFiles) document.getElementById("tabKetQuaFiles").textContent = t.tabKetQuaFiles;
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
    if (t.sheetPayDatesLabel) {
      const el = document.getElementById("lblSheetPayDates");
      if (el) el.textContent = t.sheetPayDatesLabel;
    }
    if (t.sheetPayMccsLabel) {
      const el = document.getElementById("lblSheetPayMccs");
      if (el) el.textContent = t.sheetPayMccsLabel;
    }
    if (t.sheetPayExcludeLabel) {
      const el = document.getElementById("lblSheetPayExclude");
      if (el) el.textContent = t.sheetPayExcludeLabel;
    }
    if (t.sheetPayButton) document.getElementById("sendSheetPayment").textContent = t.sheetPayButton;
    if (t.cocHeading) document.getElementById("cocHeading").textContent = t.cocHeading;
    if (t.cocHint) document.getElementById("cocHint").textContent = t.cocHint;
    if (t.cocSave) document.getElementById("cocSave").textContent = t.cocSave;
    if (t.cocRefresh) document.getElementById("cocRefresh").textContent = t.cocRefresh;
    if (t.navRefresh) document.getElementById("navRefreshBtn").textContent = t.navRefresh;
    if (t.clearCache) document.getElementById("clearCacheBtn").textContent = t.clearCache;
    if (t.debtNotifyHeading) document.getElementById("debtNotifyHeading").textContent = t.debtNotifyHeading;
    if (t.debtNotifyHint) document.getElementById("debtNotifyHint").textContent = t.debtNotifyHint;
    if (t.debtNotifyStatusLegend)
      document.getElementById("debtNotifyStatusLegend").textContent = t.debtNotifyStatusLegend;
    if (t.debtNotifyRefresh)
      document.getElementById("debtNotifyRefresh").textContent = t.debtNotifyRefresh;
    if (t.debtNotifyStatusFoot)
      document.getElementById("debtNotifyStatusFoot").textContent = t.debtNotifyStatusFoot;
    if (t.congNoPreviewColA)
      document.getElementById("thCongNoColA").textContent = t.congNoPreviewColA;
    if (t.congNoPreviewColB)
      document.getElementById("thCongNoColB").textContent = t.congNoPreviewColB;
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
    if (t.ketQuaFilesHeading)
      document.getElementById("ketQuaFilesHeading").textContent = t.ketQuaFilesHeading;
    if (t.ketQuaFilesIntro) document.getElementById("ketQuaFilesIntro").textContent = t.ketQuaFilesIntro;
    if (t.ketQuaFilesLblLinks)
      document.getElementById("ketQuaFilesLblLinks").textContent = t.ketQuaFilesLblLinks;
    if (t.ketQuaFilesLblOutputLink)
      document.getElementById("ketQuaFilesLblOutputLink").textContent = t.ketQuaFilesLblOutputLink;
    if (t.ketQuaFilesLblCampaignCol)
      document.getElementById("ketQuaFilesLblCampaignCol").textContent = t.ketQuaFilesLblCampaignCol;
    if (t.ketQuaFilesLblCostCol)
      document.getElementById("ketQuaFilesLblCostCol").textContent = t.ketQuaFilesLblCostCol;
    if (t.ketQuaFilesLblCurrencyCol)
      document.getElementById("ketQuaFilesLblCurrencyCol").textContent = t.ketQuaFilesLblCurrencyCol;
    if (t.ketQuaFilesLblCap1)
      document.getElementById("ketQuaFilesLblCap1").textContent = t.ketQuaFilesLblCap1;
    if (t.ketQuaFilesLblCap2)
      document.getElementById("ketQuaFilesLblCap2").textContent = t.ketQuaFilesLblCap2;
    if (t.ketQuaFilesLblAccountNameCol)
      document.getElementById("ketQuaFilesLblAccountNameCol").textContent = t.ketQuaFilesLblAccountNameCol;
    if (t.ketQuaFilesRun) document.getElementById("ketQuaFilesRun").textContent = t.ketQuaFilesRun;
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
    if (L.mcc) document.getElementById("lblMcc").textContent = L.mcc;
    if (L.maCamp) document.getElementById("lblCamp").textContent = L.maCamp;
    if (L.rate) document.getElementById("lblRate").textContent = L.rate;
    if (L.rule) document.getElementById("lblRule").textContent = L.rule;
    if (L.dealerName) dealerLabelName = L.dealerName;
    if (L.dealerChat) dealerLabelChat = L.dealerChat;
    syncDealerComposeLabels();
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

function syncDealerComposeLabels() {
  const compose = document.getElementById("dealerComposeRow");
  if (!compose) return;
  compose.querySelector(".dealer-lbl-name").textContent = dealerLabelName;
  compose.querySelector(".dealer-lbl-chat").textContent = dealerLabelChat;
}

function clearDealerCompose() {
  const nameEl = document.getElementById("dealerComposeName");
  const chatEl = document.getElementById("dealerComposeChat");
  if (nameEl) nameEl.value = "";
  if (chatEl) chatEl.value = "";
}

function fillDealerCompose(name = "", chat = "") {
  const nameEl = document.getElementById("dealerComposeName");
  const chatEl = document.getElementById("dealerComposeChat");
  if (nameEl) nameEl.value = name;
  if (chatEl) chatEl.value = chat;
  nameEl?.focus();
}

function addDealerRow(name = "", chat = "", prepend = false) {
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
  });
  if (prepend && container.firstChild) container.insertBefore(row, container.firstChild);
  else container.appendChild(row);
}

function collectDealerMap() {
  const map = {};
  const pushRow = (rowEl) => {
    const n = rowEl.querySelector(".inp-name")?.value.trim() ?? "";
    const c = rowEl.querySelector(".inp-chat")?.value.trim() ?? "";
    if (!n) return;
    map[n] = c;
  };
  const compose = document.getElementById("dealerComposeRow");
  if (compose) pushRow(compose);
  for (const row of document.querySelectorAll("#dealerRows .dealer-row")) pushRow(row);
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
      fillDealerCompose(tabGuess, idStr);
      setTab("dealers");
      document.getElementById("dealerComposeRow")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    const groups = groupDealerNamesByFirstChar(names);
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "broadcast-dealer-group";
      section.setAttribute("aria-label", `Đại lý bắt đầu bằng ${group.key}`);

      const head = document.createElement("div");
      head.className = "broadcast-dealer-group-head";
      head.style.color = dealerFirstCharColor(group.key === "0-9" ? "0" : group.key.charAt(0));
      head.textContent = group.key;

      const items = document.createElement("div");
      items.className = "broadcast-dealer-group-items";
      for (const name of group.names) {
        items.appendChild(createBroadcastDealerCheckbox(name));
      }

      section.append(head, items);
      frag.appendChild(section);
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
    clearDealerCompose();
    syncDealerComposeLabels();
    return;
  }
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    container.replaceChildren();
    clearDealerCompose();
    syncDealerComposeLabels();
    return;
  }
  const data = await res.json();
  const map = data.map && typeof data.map === "object" ? data.map : {};
  container.replaceChildren();
  clearDealerCompose();
  syncDealerComposeLabels();
  for (const k of Object.keys(map)) {
    addDealerRow(k, map[k] ?? "");
  }
}

async function refreshSession() {
  const url = apiUrl("/api/me");
  const topbarActions = document.getElementById("topbarActions");
  if (!url) {
    document.getElementById("gate").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    topbarActions?.setAttribute("hidden", "");
    return false;
  }
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json();
  const ok = data.ok === true;
  document.getElementById("gate").classList.toggle("hidden", ok);
  document.getElementById("app").classList.toggle("hidden", !ok);
  topbarActions?.toggleAttribute("hidden", !ok);
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

document.getElementById("navMenuToggle")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleNavDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeNavDrawer();
});
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("navDropdown");
  if (!dropdown) return;
  const t = e.target;
  if (t instanceof Node && dropdown.contains(t)) return;
  closeNavDrawer();
});
for (const btn of document.querySelectorAll(".nav-drawer-item")) {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
}
document.getElementById("navRefreshBtn")?.addEventListener("click", () => {
  closeNavDrawer();
  const saved = sessionStorage.getItem(ADMIN_TAB_KEY) || "dealers";
  if (saved === "coc") void loadCocTable();
  else if (saved === "cham-cong") void loadChamCongPanel();
  else if (saved === "debt-notify") void loadDebtNotifyStatus();
  else if (saved === "email") void loadMailListPanel();
  else if (saved === "broadcast") {
    updateBroadcastNgayDisplay();
    void loadBroadcastDealers();
  }
  else if (saved === "dealers") void loadDealerMapUI();
});
document.getElementById("clearCacheBtn")?.addEventListener("click", () => {
  try {
    sessionStorage.removeItem(ADMIN_TAB_KEY);
  } catch {
    /* ignore */
  }
  cachedGroupChats = [];
  cocRowsCache = [];
  cocOriginalBySheetRow = new Map();
  cocMaxSheetRow = 1;
  closeNavDrawer();
  const u = new URL(location.href);
  u.searchParams.set("_t", String(Date.now()));
  location.href = u.toString();
});
document.getElementById("cocRefresh")?.addEventListener("click", () => void loadCocTable());
document.getElementById("cocSave")?.addEventListener("click", () => void saveCocTable());
document.getElementById("chamCongRefresh")?.addEventListener("click", () => void loadChamCongPanel());
document.getElementById("mailListSave")?.addEventListener("click", () => void saveMailListPanel());
document.getElementById("mailListDelete")?.addEventListener("click", () => void deleteMailListPanel());
document.getElementById("chamCongSave")?.addEventListener("click", () => void saveChamCongThuong());
document.getElementById("chamCongAddEmployee")?.addEventListener("click", () => void addChamCongEmployee());
document.getElementById("chamCongEmployeeSelect")?.addEventListener("change", (e) => {
  chamCongSelectedTab = e.target.value || "";
  updateChamCongDeleteButton(chamCongSelectedTab);
  void loadChamCongPanel();
});
document.getElementById("chamCongDeleteEmployee")?.addEventListener("click", () => {
  const tabName = document.getElementById("chamCongEmployeeSelect")?.value?.trim() ?? chamCongSelectedTab;
  void deleteChamCongEmployee(tabName);
});
document.getElementById("chamCongEmployeeTableBody")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-cham-cong-del]");
  if (!btn) return;
  void deleteChamCongEmployee(btn.getAttribute("data-cham-cong-del"));
});
document.getElementById("cocAddRow")?.addEventListener("click", () => {
  const rows = collectCocRowsFromDom();
  rows.unshift({ sheetRow: null, ngay: "", thu: "", chi: "", ten: "", note: "" });
  renderCocTable(rows);
});
document.getElementById("cocTableBody")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-coc-del]");
  if (!btn) return;
  const idx = Number(btn.getAttribute("data-coc-del"));
  const rows = collectCocRowsFromDom();
  rows.splice(idx, 1);
  renderCocTable(rows);
});

document.getElementById("dealerAddRow").addEventListener("click", () => {
  const nameEl = document.getElementById("dealerComposeName");
  const chatEl = document.getElementById("dealerComposeChat");
  const name = nameEl?.value.trim() ?? "";
  const chat = chatEl?.value.trim() ?? "";
  if (name || chat) addDealerRow(name, chat, true);
  clearDealerCompose();
  nameEl?.focus();
});

document.getElementById("sendSheetPayment").addEventListener("click", async () => {
  const msg = document.getElementById("sheetPayMsg");
  msg.hidden = true;
  const url = apiUrl("/api/send-sheet-payment");
  if (!url) {
    show(msg, "Chỉ gửi được khi site chạy trên máy chủ (không dùng file://).", true);
    return;
  }
  const dates = parseMultilineField(document.getElementById("sheetPayDates")?.value ?? "");
  const mccs = parseMultilineField(document.getElementById("sheetPayMccs")?.value ?? "");
  const excludeMccs = parseMultilineField(document.getElementById("sheetPayExcludeMccs")?.value ?? "");
  if (dates.length === 0) {
    show(msg, "Điền ít nhất một dòng NGÀY.", true);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ dates, mccs, excludeMccs }),
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
  const extra =
    Array.isArray(data.filterDates) && data.filterDates.length > 1
      ? ` (${data.filterDates.length} ngày: ${data.filterDates.join(", ")})`
      : "";
  show(msg, (data.message || "Đã nhận — bot đang gửi thanh toán…") + extra, false);
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

  const parts = [];
  if (cachedGroupChats.length > 0) {
    parts.push(
      `Đã gom ${cachedGroupChats.length} nhóm (${data.updatesConsumed ?? 0} update). Lọc hoặc tải CSV/TXT.`
    );
    if (data.usedWebhookBypass) parts.push("Đã quét qua tạm gỡ webhook.");
  } else {
    parts.push(data.warning || "Không thấy nhóm — gửi tin trong nhóm đại lý rồi bấm lại.");
  }
  if (data.hostMismatch && data.thuChiWebhookUrl) {
    parts.push(`Webhook: ${data.thuChiWebhookUrl}`);
  }
  if (data.note) parts.push(data.note);
  show(msg, parts.join(" "), cachedGroupChats.length === 0);
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

async function loadMailListPanel() {
  const msg = document.getElementById("mailListMsg");
  const input = document.getElementById("mailListInput");
  if (msg) msg.hidden = true;
  const url = apiUrl("/api/mail-list");
  if (!url) {
    if (msg) show(msg, "Chỉ dùng được khi chạy trên server.", true);
    return;
  }
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Không tải danh sách email.", true);
    return;
  }
  if (input) input.value = data.text ?? (data.emails ?? []).join("\n");
}

async function saveMailListPanel() {
  const msg = document.getElementById("mailListMsg");
  const url = apiUrl("/api/mail-list");
  const text = document.getElementById("mailListInput")?.value ?? "";
  if (!url) {
    if (msg) show(msg, "Chỉ lưu được khi chạy trên server.", true);
    return;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Lưu lỗi.", true);
    return;
  }
  const input = document.getElementById("mailListInput");
  if (input) input.value = data.text ?? (data.emails ?? []).join("\n");
  if (msg) show(msg, data.message || "Đã lưu.", false);
}

async function deleteMailListPanel() {
  const msg = document.getElementById("mailListMsg");
  if (!confirm("Xóa toàn bộ danh sách email trên KV?")) return;
  const url = apiUrl("/api/mail-list");
  if (!url) {
    if (msg) show(msg, "Chỉ xóa được khi chạy trên server.", true);
    return;
  }
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (msg) show(msg, data.error || "Xóa lỗi.", true);
    return;
  }
  const input = document.getElementById("mailListInput");
  if (input) input.value = "";
  if (msg) show(msg, data.message || "Đã xóa.", false);
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

document.getElementById("ketQuaFilesForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("ketQuaFilesMsg");
  const runBtn = document.getElementById("ketQuaFilesRun");
  msg.hidden = true;

  const url = apiUrl("/api/run-tk-back");
  if (!url) {
    show(msg, "Chỉ chạy được khi site trên Worker.", true);
    return;
  }

  runBtn.disabled = true;
  show(msg, "Đang đọc các Sheet và ghi báo cáo…", false);
  msg.hidden = false;

  const body = {
    spreadsheetLinks: document.getElementById("ketQuaFilesSpreadsheetLinks").value.trim(),
    outputSpreadsheetUrlOrId: document.getElementById("ketQuaFilesOutputUrl").value.trim(),
    campaignCol: document.getElementById("ketQuaFilesCampaignCol").value.trim(),
    costCol: document.getElementById("ketQuaFilesCostCol").value.trim(),
    currencyCol: document.getElementById("ketQuaFilesCurrencyCol").value.trim(),
    cap1Code: document.getElementById("ketQuaFilesCap1").value.trim(),
    cap2Codes: document.getElementById("ketQuaFilesCap2").value.trim(),
    accountNameCol: document.getElementById("ketQuaFilesAccountNameCol").value.trim(),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  runBtn.disabled = false;
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
  await loadDealerMapUI();
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
syncDealerComposeLabels();
updateBroadcastNgayDisplay();
const loggedIn = await refreshSession();
if (loggedIn) await loadDealerMapUI();
