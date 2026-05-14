const $ = (sel, root = document) => root.querySelector(sel);

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

const state = {
  tongQuan: { a2: "", b2: "", c2: "", d2: "", e2: "" },
  docTongQuan: null,
  thuChi: [],
  coc: [],
  congNo: [],
  banDao: [],
  computed: null,
  report: { byDay: [], byMonth: [], todayVietnam: null },
  reportBanDao: { byDay: [], byMonth: [], todayVietnam: null },
};

function rowThuChi(r) {
  return {
    ngay: r.ngay ?? "",
    thu: r.thu ?? "",
    chi: r.chi ?? "",
    ghiChu: r.ghiChu ?? "",
  };
}
function rowCoc(r) {
  return {
    ngay: r.ngay ?? "",
    thu: r.thu ?? "",
    chi: r.chi ?? "",
    ten: r.ten ?? "",
    ghiChu: r.ghiChu ?? "",
  };
}
function rowCongNo(r) {
  return { ten: r.ten ?? "", tienNo: r.tienNo ?? "" };
}
function rowBanDao(r) {
  return {
    ngay: r.ngay ?? "",
    ten: r.ten ?? r.tenKh ?? "",
    diaChi: r.diaChi ?? "",
    sdt: r.sdt ?? "",
    soLuong: r.soLuong ?? "",
    gia: r.gia ?? "",
    thanhTien: r.thanhTien ?? r.tienUs ?? "",
  };
}

const REVEAL_KEY = "bc_reveal_balance";
const AUTO_SYNC_KEY = "bc_auto_sync";
const LAST_SIG_KEY = "bc_payload_sig";

let pollTimer = null;
let toolbarBound = false;

function isRevealed() {
  return sessionStorage.getItem(REVEAL_KEY) === "1";
}
function isAutoSyncOn() {
  return sessionStorage.getItem(AUTO_SYNC_KEY) === "1";
}
function syncSensitiveRevealClass() {
  document.body.classList.toggle("bc-sensitive-revealed", isRevealed());
}

function setRevealed(v) {
  if (v) sessionStorage.setItem(REVEAL_KEY, "1");
  else sessionStorage.removeItem(REVEAL_KEY);
  syncSensitiveRevealClass();
  const inp = $("#tq-a2");
  if (inp) inp.type = v ? "text" : "password";
  const e2inp = $("#tq-e2");
  if (e2inp) e2inp.type = v ? "text" : "password";
  const section = $("#section-sensitive-balance");
  if (section) section.hidden = !v;
  const a2Field = $("#field-a2");
  if (a2Field) a2Field.hidden = !v;
  const e2Field = $("#field-e2");
  if (e2Field) e2Field.hidden = !v;
  const repA2Card = $("#card-rep-a2");
  if (repA2Card) repA2Card.hidden = !v;
  $("#btn-reveal-balance").hidden = v;
  $("#btn-hide-balance").hidden = !v;
  const btnRevealBc = $("#btn-reveal-balance-bao-cao");
  const btnHideBc = $("#btn-hide-balance-bao-cao");
  if (btnRevealBc) btnRevealBc.hidden = v;
  if (btnHideBc) btnHideBc.hidden = !v;
  capNhatHienThiSoDuDauDoc();
  capNhatHienThiBienDong();
  renderThuChi();
  renderReport();
}

function setAutoSyncUi() {
  const btn = $("#btn-auto-sync");
  if (!btn) return;
  const on = isAutoSyncOn();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "Tự động: Bật" : "Tự động: Tắt";
}

function setView(loggedIn) {
  $("#view-login").hidden = loggedIn;
  $("#view-app").hidden = !loggedIn;
  const panels = $("#admin-tab-panels");
  if (panels) panels.hidden = !loggedIn;
  if (!loggedIn && pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function activateTab(id) {
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    const on = p.dataset.panel === id;
    p.hidden = !on;
    p.classList.toggle("active", on);
  });
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
}

/** yyyy-mm-dd theo múi Việt Nam (Asia/Ho_Chi_Minh). */
function todayIsoVietnam() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** yyyy-mm hiện tại (GMT+7). */
function currentMonthIsoVietnam() {
  return todayIsoVietnam().slice(0, 7);
}

/** Tab Báo cáo: bán dao theo tháng — chỉ tháng hiện tại (GMT+7). */
function reportBanDaoCurrentMonthRows() {
  const month = currentMonthIsoVietnam();
  const byMonth = state.reportBanDao.byMonth ?? [];
  return byMonth.filter((r) => String(r.thang ?? "").trim().slice(0, 7) === month);
}

function tbody(id) {
  return $(`#${id} tbody`);
}

/** yyyy-mm-dd → dd/mm/yyyy (hiển thị báo cáo). */
function formatDayForDisplay(s) {
  const t = String(s ?? "").trim().split(/\s+/)[0] ?? "";
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(s ?? "");
}

/** yyyy-mm → Tháng mm/yyyy */
function formatMonthForDisplay(s) {
  const t = String(s ?? "").trim();
  const m = t.match(/^(\d{4})-(\d{2})$/);
  if (m) return `Tháng ${m[2]}/${m[1]}`;
  return t;
}

function cellMoneyDisplay(raw) {
  if (raw == null || raw === "") return "—";
  if (typeof raw === "number" && Number.isFinite(raw)) return fmtMoney(raw);
  const str = String(raw).trim();
  if (!str) return "—";
  const n = parseNumClient(str);
  return fmtMoney(n);
}

function renderThuChi() {
  const tb = tbody("table-thu-chi");
  tb.innerHTML = "";
  state.thuChi.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-readonly">${escapeHtml(formatDayForDisplay(r.ngay ?? ""))}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.thu)}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.chi)}</td>
      <td class="cell-readonly">${escapeHtml(r.ghiChu ?? "")}</td>`;
    tb.appendChild(tr);
  });
}

function renderCoc() {
  const tb = tbody("table-coc");
  tb.innerHTML = "";
  state.coc.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-readonly">${escapeHtml(formatDayForDisplay(r.ngay ?? ""))}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.thu)}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.chi)}</td>
      <td class="cell-readonly">${escapeHtml(r.ten ?? "")}</td>
      <td class="cell-readonly">${escapeHtml(r.ghiChu ?? "")}</td>`;
    tb.appendChild(tr);
  });
}

function renderBanDaoDetail() {
  const tb = tbody("table-ban-dao");
  if (!tb) return;
  tb.innerHTML = "";
  for (const r of state.banDao) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-readonly">${escapeHtml(formatDayForDisplay(r.ngay ?? ""))}</td>
      <td class="cell-readonly">${escapeHtml(r.ten ?? "")}</td>
      <td class="cell-readonly">${escapeHtml(r.diaChi ?? "")}</td>
      <td class="cell-readonly">${escapeHtml(r.sdt ?? "")}</td>
      <td class="cell-readonly cell-num">${escapeHtml(String(r.soLuong ?? ""))}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.gia)}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.thanhTien)}</td>`;
    tb.appendChild(tr);
  }
}

function renderCongNo() {
  const tb = tbody("table-cong-no");
  tb.innerHTML = "";
  state.congNo.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-readonly">${escapeHtml(r.ten ?? "")}</td>
      <td class="cell-readonly cell-num">${cellMoneyDisplay(r.tienNo)}</td>`;
    tb.appendChild(tr);
  });
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function parseNumClient(s) {
  if (s == null || s === "") return 0;
  const raw = String(s).trim().replace(/\s/g, "");
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let t = raw;
  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    t = raw.replace(new RegExp(`\\${thousandSep}`, "g"), "").replace(decimalSep, ".");
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const parts = raw.split(sep);
    if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) {
      t = parts.join("");
    } else if (
      parts.length === 2 &&
      parts[1].length === 3 &&
      parts[0].length >= 1 &&
      /^\d+$/.test(parts[0]) &&
      /^\d+$/.test(parts[1])
    ) {
      t = parts.join("");
    } else {
      t = raw.replace(sep, ".");
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

function capNhatHienThiSoDuDauDoc() {
  const valEl = $("#so-du-dau-doc-hien-thi");
  const rawEl = $("#so-du-dau-doc-raw");
  if (!valEl) return;
  if (!isRevealed()) {
    valEl.textContent = "Đang ẩn — bấm Presently và nhập mật khẩu để xem.";
    if (rawEl) {
      rawEl.hidden = true;
      rawEl.textContent = "";
    }
    return;
  }
  const raw = ($("#tq-a2")?.value ?? "").trim();
  if (!raw) {
    valEl.textContent = "Chưa có dữ liệu — ô A2 trên TONG_QUAN đang trống.";
    if (rawEl) {
      rawEl.hidden = true;
      rawEl.textContent = "";
    }
    return;
  }
  const n = parseNumClient($("#tq-a2").value);
  valEl.textContent = fmtMoney(n);
  if (rawEl) {
    const fromApi = state.docTongQuan?.a2_soDuDau?.raw;
    if (fromApi != null && String(fromApi).trim() !== raw) {
      rawEl.hidden = false;
      rawEl.textContent = `Giá trị gốc trên Sheet (lần tải gần nhất): ${fromApi}`;
    } else {
      rawEl.hidden = true;
      rawEl.textContent = "";
    }
  }
}

function capNhatHienThiBienDong() {
  const el = $("#bien-dong-doc-hien-thi");
  if (!el) return;
  if (!isRevealed()) {
    el.textContent = "Đang ẩn — bấm Presently (cùng mật khẩu với Balance) để xem.";
    return;
  }
  const v = ($("#tq-e2")?.value ?? "").trim();
  if (!v) {
    el.textContent = "—";
    return;
  }
  el.textContent = fmtMoney(parseNumClient(v));
}

function refreshComputedFromClient() {
  const duDau = parseNumClient($("#tq-a2").value);
  const bienDongTuSheet = parseNumClient(String($("#tq-e2")?.value ?? "").trim() || "0");
  let sumCocB = 0;
  let sumCocC = 0;
  for (const r of state.coc) {
    sumCocB += parseNumClient(r.thu);
    sumCocC += parseNumClient(r.chi);
  }
  let sumNo = 0;
  for (const r of state.congNo) {
    sumNo += parseNumClient(r.tienNo);
  }
  $("#tq-b2").value = fmtMoney(sumCocC);
  $("#tq-c2").value = fmtMoney(sumCocB);
  $("#tq-d2").value = fmtMoney(sumNo);
  state.computed = {
    tongCoc: sumCocC,
    nhanCoc: sumCocB,
    tongCongNo: sumNo,
    duDauNhap: duDau,
    bienDongE2: bienDongTuSheet,
  };
  renderReport();
  capNhatHienThiSoDuDauDoc();
  capNhatHienThiBienDong();
}

function renderReport() {
  const c = state.computed;
  $("#rep-a2").textContent = isRevealed() && c ? fmtMoney(c.duDauNhap) : "—";
  $("#rep-b2").textContent = c ? fmtMoney(c.tongCoc) : "—";
  $("#rep-c2").textContent = c ? fmtMoney(c.nhanCoc) : "—";
  $("#rep-d2").textContent = c ? fmtMoney(c.tongCongNo) : "—";

  const rtc = state.report?.todayVietnam;
  const rtl = $("#report-thu-chi-today-label");
  const rtthu = $("#report-thu-chi-today-thu");
  const rtchi = $("#report-thu-chi-today-chi");
  if (rtl && rtthu && rtchi) {
    const d = rtc?.date ?? todayIsoVietnam();
    rtl.textContent = formatDayForDisplay(d);
    const tThu = typeof rtc?.tongThu === "number" && Number.isFinite(rtc.tongThu) ? rtc.tongThu : 0;
    const tChi = typeof rtc?.tongChi === "number" && Number.isFinite(rtc.tongChi) ? rtc.tongChi : 0;
    rtthu.textContent = `Tổng thu: ${fmtMoney(tThu)}`;
    rtchi.textContent = `Tổng chi: ${fmtMoney(tChi)}`;
  }

  const repBdMonthRows = reportBanDaoCurrentMonthRows();
  const tbBdRepMonth = $("#table-report-bd-month tbody");
  if (tbBdRepMonth) {
    tbBdRepMonth.innerHTML = "";
    for (const r of repBdMonthRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(formatMonthForDisplay(r.thang))}</td><td>${fmtMoney(r.tong)}</td>`;
      tbBdRepMonth.appendChild(tr);
    }
  }

  const dayLabel = $("#report-bd-today-label");
  const dayTotal = $("#report-bd-day-total");
  if (dayLabel && dayTotal) {
    const tv = state.reportBanDao.todayVietnam;
    const d = tv?.date ?? todayIsoVietnam();
    dayLabel.textContent = formatDayForDisplay(d);
    const t = typeof tv?.tong === "number" && Number.isFinite(tv.tong) ? tv.tong : 0;
    dayTotal.textContent = fmtMoney(t);
  }

  const bdD = $("#table-bandao-day tbody");
  if (bdD) {
    bdD.innerHTML = "";
    for (const r of state.reportBanDao.byDay ?? []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(formatDayForDisplay(r.date))}</td><td>${fmtMoney(r.tong)}</td>`;
      bdD.appendChild(tr);
    }
  }
  populateBandaoMonthSelectOptions();
  syncBandaoMonthPanel();
}

function populateBandaoMonthSelectOptions() {
  const sel = $("#sel-bandao-panel-month");
  if (!sel) return;
  const saved = sel.value;
  sel.innerHTML = '<option value="">— Chọn tháng —</option>';
  const months = [...(state.reportBanDao.byMonth ?? [])].sort((a, b) =>
    String(b.thang).localeCompare(String(a.thang)),
  );
  for (const r of months) {
    const opt = document.createElement("option");
    opt.value = String(r.thang);
    opt.textContent = formatMonthForDisplay(r.thang);
    sel.appendChild(opt);
  }
  if (saved && months.some((m) => String(m.thang) === saved)) sel.value = saved;
  else sel.value = "";
}

function syncBandaoMonthPanel() {
  const sel = $("#sel-bandao-panel-month");
  const wrap = $("#wrap-bandao-month-table");
  const bdM = $("#table-bandao-month tbody");
  if (!sel || !wrap || !bdM) return;
  const v = sel.value;
  if (!v) {
    wrap.hidden = true;
    bdM.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  bdM.innerHTML = "";
  const r = (state.reportBanDao.byMonth ?? []).find((x) => String(x.thang) === v);
  if (r) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(formatMonthForDisplay(r.thang))}</td><td>${fmtMoney(r.tong)}</td>`;
    bdM.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyPayload(data) {
  syncSensitiveRevealClass();
  state.tongQuan = data.tongQuan ?? state.tongQuan;
  state.docTongQuan = data.docTongQuan ?? null;
  state.thuChi = (data.thuChi ?? []).map(rowThuChi);
  state.coc = (data.coc ?? []).map(rowCoc);
  state.congNo = (data.congNo ?? []).map(rowCongNo);
  state.banDao = (data.banDao ?? []).map(rowBanDao);
  state.computed = data.computed ?? null;
  state.report = {
    byDay: data.report?.byDay ?? [],
    byMonth: data.report?.byMonth ?? [],
    todayVietnam: data.report?.todayVietnam ?? null,
  };
  state.reportBanDao = data.reportBanDao ?? { byDay: [], byMonth: [], todayVietnam: null };

  $("#tq-a2").value = state.tongQuan.a2 ?? "";
  $("#tq-b2").value = state.tongQuan.b2 ? String(state.tongQuan.b2) : "";
  $("#tq-c2").value = state.tongQuan.c2 ? String(state.tongQuan.c2) : "";
  $("#tq-e2").value =
    state.tongQuan.e2 !== undefined && state.tongQuan.e2 !== null && String(state.tongQuan.e2) !== ""
      ? String(state.tongQuan.e2)
      : "";

  sessionStorage.setItem(LAST_SIG_KEY, JSON.stringify(data));

  renderThuChi();
  renderCoc();
  renderCongNo();
  renderBanDaoDetail();
  refreshComputedFromClient();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text || "Lỗi không xác định" };
  }
  if (!res.ok) {
    let msg = json?.error || res.statusText;
    if (typeof msg === "string" && /^\s*</.test(msg)) {
      msg =
        "Server trả HTML thay vì JSON (Worker lỗi nặng hoặc chưa deploy bản sửa). Mở Workers Logs trên Cloudflare.";
    }
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function setSyncStatus(msg, kind) {
  const el = $("#sync-status");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

/** @returns {Promise<boolean>} true nếu dữ liệu đổi hoặc luôn khi force */
async function fetchSheetAndApply(options = {}) {
  const { force = false, silent = false } = options;
  const data = await api("/api/sheet", { method: "GET" });
  const sig = JSON.stringify(data);
  const prev = sessionStorage.getItem(LAST_SIG_KEY) || "";
  if (!force && sig === prev) {
    if (!silent) setSyncStatus("Đã là mới nhất (không đổi).", "ok");
    return false;
  }
  applyPayload(data);
  if (!silent) setSyncStatus("Đã tải dữ liệu từ Google Sheet.", "ok");
  return true;
}

async function tryLoadSession() {
  try {
    const data = await api("/api/sheet", { method: "GET" });
    setView(true);
    applyPayload(data);
    return true;
  } catch (e) {
    if (e.status === 401) {
      setView(false);
      return false;
    }
    throw e;
  }
}

function startAutoPoll() {
  if (pollTimer != null) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!isAutoSyncOn() || document.hidden) return;
    try {
      await fetchSheetAndApply({ force: false, silent: true });
    } catch {
      /* bỏ qua lỗi mạng từng lần */
    }
  }, 45000);
}

function bindToolbarAfterLogin() {
  if (toolbarBound) return;
  toolbarBound = true;
  $("#btn-refresh")?.addEventListener("click", async () => {
    try {
      await fetchSheetAndApply({ force: true, silent: false });
    } catch (e) {
      setSyncStatus(e.message || "Làm mới thất bại.", "err");
    }
  });

  $("#btn-auto-sync")?.addEventListener("click", () => {
    if (isAutoSyncOn()) sessionStorage.removeItem(AUTO_SYNC_KEY);
    else sessionStorage.setItem(AUTO_SYNC_KEY, "1");
    setAutoSyncUi();
    if (isAutoSyncOn()) startAutoPoll();
    else if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  $("#btn-clear-cache")?.addEventListener("click", () => {
    sessionStorage.removeItem(REVEAL_KEY);
    sessionStorage.removeItem(AUTO_SYNC_KEY);
    sessionStorage.removeItem(LAST_SIG_KEY);
    setSyncStatus("Đã xóa cache trình duyệt. Đang tải lại…", "ok");
    location.reload();
  });

  $("#sel-bandao-panel-month")?.addEventListener("change", () => syncBandaoMonthPanel());
}

function bindOverviewInput() {
  $("#tq-a2").addEventListener("input", refreshComputedFromClient);
  $("#tq-a2").addEventListener("change", refreshComputedFromClient);
}

async function main() {
  bindTabs();
  activateTab("tong_quan");
  bindOverviewInput();
  setRevealed(isRevealed());
  setAutoSyncUi();

  async function onRevealBalanceClick() {
    const p = prompt("Nhập mật khẩu để hiện Số dư đầu:");
    if (!p) return;
    try {
      await api("/api/reveal-balance", { method: "POST", body: JSON.stringify({ password: p }) });
      setRevealed(true);
    } catch (e) {
      alert(e.body?.error || e.message || "Sai mật khẩu.");
    }
  }
  $("#btn-reveal-balance").addEventListener("click", onRevealBalanceClick);
  $("#btn-hide-balance").addEventListener("click", () => setRevealed(false));
  $("#btn-reveal-balance-bao-cao")?.addEventListener("click", onRevealBalanceClick);
  $("#btn-hide-balance-bao-cao")?.addEventListener("click", () => setRevealed(false));

  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const username = String(fd.get("username") || "");
    const password = String(fd.get("password") || "");
    const errEl = $("#login-error");
    errEl.hidden = true;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
      await tryLoadSession();
      bindToolbarAfterLogin();
      if (isAutoSyncOn()) startAutoPoll();
    } catch (e) {
      errEl.textContent = e.body?.error || e.message || "Đăng nhập thất bại.";
      errEl.hidden = false;
    }
  });

  $("#btn-logout").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch {
      /* ignore */
    }
    setView(false);
  });

  try {
    const ok = await tryLoadSession();
    if (!ok) setView(false);
    else {
      bindToolbarAfterLogin();
      if (isAutoSyncOn()) startAutoPoll();
    }
  } catch (e) {
    setView(false);
    $("#login-error").textContent =
      e.body?.error ||
      e.message ||
      "Không tải được dữ liệu. Kiểm tra biến môi trường / quyền service account.";
    $("#login-error").hidden = false;
  }
}

main();
