import type { BaoCaoFilterSlot, BaoCaoTkFilteredRow } from "./bao-cao-tk";
import {
  getDealerChatMap,
  resolveChatIdForCustomerNameColumnD,
  normalizeDealerNameKey,
} from "./dealer-map";
import {
  appendSheetPayRunError,
  appendSheetPayRunWarning,
  finishSheetPayRun,
  recordSheetPayFooterSent,
  type SheetPayRunState,
} from "./sheet-pay-status";
import { appendSheetPayLog } from "./sheet-pay-log";
import type { Env } from "./worker-lib";
import { getAccessTokenFromEnv, getCongNoFullMap, getDebtMap } from "./worker-lib";

const META_PREFIX = "sheet_pay:meta:";
const CHUNK_SIZE_DEFAULT = 3;

export type SheetPayRowJob = {
  sheetRow1Based: number;
  panelNgay: string;
  customerD: string;
  chatId: string;
};

export type SheetPayFooterTarget = {
  customerD: string;
  chatId: string;
};

export type SheetPayRunMeta = {
  runId: string;
  continueToken: string;
  workerOrigin: string;
  filterSlots: BaoCaoFilterSlot[];
  excludeMccs: string[];
  forceResend: boolean;
  filterSig: string;
  bOldSnapshot: Record<string, number>;
  rowJobs: SheetPayRowJob[];
  footerTargets: SheetPayFooterTarget[];
  chunkSize: number;
  batchPauseMs: number;
  telegramGapMs: number;
  footerSentKeys: string[];
  rowsSent: number;
  /** Đại lý có dòng chưa gửi nhưng thiếu map Chat ID */
  unmappedCustomers: string[];
  /** Dòng bỏ qua vì thiếu cột bắt buộc */
  incompleteRows: { customerD: string; sheetRow: number; missing: string[] }[];
  filterMatchCount: number;
};

export type SheetPayStartOpts = {
  runId: string;
  forceResend: boolean;
  filterSlots: BaoCaoFilterSlot[];
  excludeMccs: string[];
  workerOrigin: string;
};

/** Job trong Cloudflare Queue — mỗi message = 1 lô chi phí, footer, hoặc tin hàng loạt. */
export type SheetPayQueueJob =
  | { kind: "chunk"; runId: string; offset: number }
  | { kind: "footers"; runId: string }
  | { kind: "manual-broadcast"; runId: string; offset: number };

type ChunkSheetCache = {
  debtMap: Map<string, string>;
  congNoFullMap: Awaited<ReturnType<typeof getCongNoFullMap>>;
  filterRows: BaoCaoTkFilteredRow[];
};

function metaKey(runId: string): string {
  return `${META_PREFIX}${runId}`;
}

export async function loadSheetPayMeta(env: Env, runId: string): Promise<SheetPayRunMeta | null> {
  if (!env.STORE) return null;
  const raw = await env.STORE.get(metaKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SheetPayRunMeta;
  } catch {
    return null;
  }
}

async function saveSheetPayMeta(env: Env, meta: SheetPayRunMeta): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(metaKey(meta.runId), JSON.stringify(meta));
}

function resolvePaymentImageUrl(env: Env): string {
  const fromEnv = env.PAYMENT_IMAGE_URL_1?.trim();
  if (fromEnv) return fromEnv;
  return "https://cdn.jsdelivr.net/gh/lamlucas/blackcorp_bot@main/qr1.jpg";
}

async function sendPaymentQrPhoto(
  env: Env,
  chatId: string,
  pause: () => Promise<void>,
): Promise<void> {
  const qrUrl = resolvePaymentImageUrl(env);
  if (!qrUrl) return;
  const { sendPhotoUrl, pinMessage } = await import("./telegram");
  try {
    const photo = await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, qrUrl);
    await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, photo.message_id);
  } catch {
    /* QR lß╗ùi */
  }
  await pause();
}

/** Cron: ghi KV trạng thái → enqueue hoặc gửi inline. */
export async function startSheetPayRun(env: Env, opts: SheetPayStartOpts): Promise<void> {
  const meta = await prepareSheetPayMeta(env, opts);
  if (!meta) return;
  for (const name of meta.unmappedCustomers) {
    await appendSheetPayRunWarning(
      env,
      opts.runId,
      `Tên khách: ${name} — chưa map Chat ID (bỏ qua dòng chưa gửi).`,
    );
  }
  for (const row of meta.incompleteRows) {
    await appendSheetPayRunWarning(
      env,
      opts.runId,
      `Dòng ${row.sheetRow} (${row.customerD}): thiếu ${row.missing.join(", ")}.`,
    );
  }
  if (meta.filterMatchCount === 0) {
    await finishSheetPayRun(env, opts.runId);
    return;
  }
  if (meta.rowJobs.length === 0 && meta.unmappedCustomers.length > 0) {
    await appendSheetPayLog(env, "warn", "Không gửi chi phí — thiếu map Chat ID", {
      runId: opts.runId,
      unmapped: meta.unmappedCustomers,
      filterMatchCount: meta.filterMatchCount,
    });
  }
  if (meta.incompleteRows.length > 0) {
    await appendSheetPayLog(env, "warn", "Một số dòng thiếu trường bắt buộc", {
      runId: opts.runId,
      incompleteRows: meta.incompleteRows,
    });
  }
  if (meta.rowJobs.length === 0 && !opts.forceResend) {
    await appendSheetPayRunWarning(
      env,
      opts.runId,
      "Không có dòng chi phí mới (các dòng lọc đều Done). Chọn Xác nhận trên popup để gửi lại.",
    );
  }
  if (meta.rowJobs.length === 0 && meta.footerTargets.length === 0) {
    await finishSheetPayRun(env, opts.runId);
    return;
  }
  if (env.SHEET_PAY_QUEUE) {
    await env.SHEET_PAY_QUEUE.send({ kind: "chunk", runId: opts.runId, offset: 0 });
    return;
  }
  await processSheetPayChunk(env, opts.runId, 0);
}

export async function deliverSheetPayQueueJob(env: Env, job: SheetPayQueueJob): Promise<void> {
  if (job.kind === "manual-broadcast") {
    const { processManualBroadcastChunk } = await import("./manual-broadcast");
    await processManualBroadcastChunk(env, job.runId, job.offset);
    return;
  }
  if (job.kind === "chunk") {
    await processSheetPayChunk(env, job.runId, job.offset);
    return;
  }
  await processSheetPayFooters(env, job.runId);
}

export async function continueSheetPayRun(
  env: Env,
  runId: string,
  offset: number,
  token: string,
): Promise<boolean> {
  const meta = await loadSheetPayMeta(env, runId);
  if (!meta || meta.continueToken !== token) return false;
  await processSheetPayChunk(env, runId, offset);
  return true;
}

async function prepareSheetPayMeta(env: Env, opts: SheetPayStartOpts): Promise<SheetPayRunMeta | null> {
  const {
    BAO_CAO_TK_TAB_NAME,
    BAO_CAO_COL,
    readBaoCaoTkSheetRows,
    filterBaoCaoSheetRowsBySlots,
    isRowExcludedByMcc,
    getBaoCaoRowPaymentMissingLabels,
    isBaoCaoRowNoteDone,
    filterSlotsSignature,
    buildFilterMismatchDiagnostic,
  } = await import("./bao-cao-tk");
  const { getCongNoOpeningColumnCForCustomerD, parseMoneyNumber } = await import("./format");

  let token: string;
  try {
    token = await getAccessTokenFromEnv(env);
  } catch {
    const errMsg = "Không lấy được token Google Sheets.";
    await appendSheetPayRunError(env, opts.runId, errMsg);
    await appendSheetPayLog(env, "error", errMsg, { runId: opts.runId });
    return null;
  }

  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
  const store = env.STORE!;

  let debtMap: Map<string, string>;
  let congNoFullMap: Awaited<ReturnType<typeof getCongNoFullMap>>;
  try {
    congNoFullMap = await getCongNoFullMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
    debtMap = await getDebtMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  } catch {
    debtMap = new Map();
    congNoFullMap = new Map();
  }

  const dealerMap = await getDealerChatMap(store);

  let allEntries: Awaited<ReturnType<typeof readBaoCaoTkSheetRows>>;
  try {
    allEntries = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
  } catch {
    const errMsg = "Không đọc được tab BAO_CAO_TK.";
    await appendSheetPayRunError(env, opts.runId, errMsg);
    await appendSheetPayLog(env, "error", errMsg, { runId: opts.runId });
    return null;
  }

  const filterRows = filterBaoCaoSheetRowsBySlots(allEntries, opts.filterSlots);
  const filterSig = filterSlotsSignature(opts.filterSlots);
  const forceResend = opts.forceResend === true;

  if (filterRows.length === 0) {
    const diag = buildFilterMismatchDiagnostic(allEntries, opts.filterSlots);
    const errMsg = `Không khớp NGÀY/MCC: ${diag.summary}`;
    await appendSheetPayRunError(env, opts.runId, errMsg.slice(0, 500));
    await appendSheetPayLog(env, "error", errMsg, {
      runId: opts.runId,
      filterSlots: opts.filterSlots,
      ...diag.detail,
    });
  }

  const customerTargets = new Map<string, SheetPayFooterTarget>();
  const bOldSnapshot: Record<string, number> = {};
  const rowJobs: SheetPayRowJob[] = [];
  const unmappedPending = new Set<string>();
  const incompleteRows: SheetPayRunMeta["incompleteRows"] = [];

  for (const entry of filterRows) {
    const customerD = normalizeDealerNameKey(String(entry.cells[BAO_CAO_COL.TEN_KHACH] ?? ""));
    if (!customerD) continue;
    const key = customerD.toLowerCase();
    if (!customerTargets.has(key)) {
      const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
      if (chatId) {
        customerTargets.set(key, { customerD, chatId });
        bOldSnapshot[key] = getCongNoOpeningColumnCForCustomerD(congNoFullMap, customerD);
      }
    }
  }

  for (const entry of filterRows) {
    const row = entry.cells;
    if (!forceResend && isBaoCaoRowNoteDone(row)) continue;

    const rowNgay = String(row[BAO_CAO_COL.NGAY] ?? "").trim();
    const rowMcc = String(row[BAO_CAO_COL.MCC] ?? "").trim();
    if (isRowExcludedByMcc(rowNgay, rowMcc, entry.panelNgay, opts.excludeMccs)) continue;

    const customerD = normalizeDealerNameKey(String(row[BAO_CAO_COL.TEN_KHACH] ?? ""));
    const chatId = resolveChatIdForCustomerNameColumnD(customerD, dealerMap);
    const missingLabels = getBaoCaoRowPaymentMissingLabels(row);

    if (!chatId) {
      if (customerD) unmappedPending.add(customerD);
      continue;
    }
    if (missingLabels.length > 0) {
      incompleteRows.push({
        customerD,
        sheetRow: entry.sheetRow1Based,
        missing: missingLabels,
      });
      continue;
    }

    rowJobs.push({
      sheetRow1Based: entry.sheetRow1Based,
      panelNgay: entry.panelNgay,
      customerD,
      chatId,
    });
  }

  rowJobs.sort((a, b) => a.sheetRow1Based - b.sheetRow1Based);

  const pauseMs = parseInt(env.DEBT_CRON_BATCH_PAUSE_MS ?? "4000", 10);
  const batchPauseMs =
    Number.isFinite(pauseMs) && pauseMs >= 0 ? Math.min(pauseMs, 120_000) : 4000;
  const chunkRaw = parseInt(env.SHEET_PAY_MSG_BATCH_SIZE ?? String(CHUNK_SIZE_DEFAULT), 10);
  const chunkSize =
    Number.isFinite(chunkRaw) && chunkRaw > 0 ? Math.min(chunkRaw, 20) : CHUNK_SIZE_DEFAULT;

  const meta: SheetPayRunMeta = {
    runId: opts.runId,
    continueToken: crypto.randomUUID(),
    workerOrigin: opts.workerOrigin.replace(/\/$/, ""),
    filterSlots: opts.filterSlots,
    excludeMccs: opts.excludeMccs,
    forceResend,
    filterSig,
    bOldSnapshot,
    rowJobs,
    footerTargets: [...customerTargets.values()],
    chunkSize,
    batchPauseMs,
    telegramGapMs: 400,
    footerSentKeys: [],
    rowsSent: 0,
    unmappedCustomers: [...unmappedPending],
    incompleteRows,
    filterMatchCount: filterRows.length,
  };

  await saveSheetPayMeta(env, meta);

  const { persistSheetPayRunStart } = await import("./sheet-pay-status");
  const state: SheetPayRunState = {
    runId: opts.runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    complete: false,
    errors: [],
    warnings: [],
    footersSent: [],
    totalRowJobs: rowJobs.length,
    rowsSent: 0,
    mode: env.SHEET_PAY_QUEUE ? "queue" : "chunked",
  };
  await persistSheetPayRunStart(env, state);

  return meta;
}

async function scheduleNextChunk(env: Env, meta: SheetPayRunMeta, offset: number): Promise<void> {
  const delaySec = meta.batchPauseMs > 0 ? Math.min(Math.ceil(meta.batchPauseMs / 1000), 900) : 0;

  if (env.SHEET_PAY_QUEUE) {
    await env.SHEET_PAY_QUEUE.send(
      { kind: "chunk", runId: meta.runId, offset },
      delaySec > 0 ? { delaySeconds: delaySec } : undefined,
    );
    return;
  }

  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, 2000 * attempt));
      }
      const res = await fetch(`${meta.workerOrigin}/api/sheet-pay-continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: meta.runId,
          offset,
          token: meta.continueToken,
        }),
      });
      if (res.ok || res.status === 202) return;
      if (attempt === maxAttempts - 1) {
        const errMsg = `Không gọi tiếp lô gửi (HTTP ${res.status}) — thử bấm Gửi lại.`;
        await appendSheetPayRunError(env, meta.runId, errMsg);
        await appendSheetPayLog(env, "error", errMsg, { runId: meta.runId, httpStatus: res.status });
        await finishSheetPayRun(env, meta.runId, { timedOut: true });
      }
    } catch (e) {
      if (attempt === maxAttempts - 1) {
        const detail = e instanceof Error ? e.message : String(e);
        const errMsg = `Lỗi gọi tiếp lô gửi: ${detail.slice(0, 200)}`;
        await appendSheetPayRunError(env, meta.runId, errMsg);
        await appendSheetPayLog(env, "error", errMsg, { runId: meta.runId });
        await finishSheetPayRun(env, meta.runId, { timedOut: true });
      }
    }
  }
}

async function scheduleFooters(env: Env, meta: SheetPayRunMeta): Promise<void> {
  const delaySec = meta.batchPauseMs > 0 ? Math.min(Math.ceil(meta.batchPauseMs / 1000), 900) : 0;
  if (env.SHEET_PAY_QUEUE) {
    await env.SHEET_PAY_QUEUE.send(
      { kind: "footers", runId: meta.runId },
      delaySec > 0 ? { delaySeconds: delaySec } : undefined,
    );
    return;
  }
  if (delaySec > 0) {
    await new Promise<void>((r) => setTimeout(r, meta.batchPauseMs));
  }
  await processSheetPayFooters(env, meta.runId);
}

async function loadChunkSheetCache(env: Env, meta: SheetPayRunMeta): Promise<ChunkSheetCache> {
  const { BAO_CAO_TK_TAB_NAME, readBaoCaoTkSheetRows, filterBaoCaoSheetRowsBySlots } =
    await import("./bao-cao-tk");
  const token = await getAccessTokenFromEnv(env);
  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
  const congNoFullMap = await getCongNoFullMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  const debtMap = await getDebtMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  const allEntries = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
  const filterRows = filterBaoCaoSheetRowsBySlots(allEntries, meta.filterSlots);
  return { debtMap, congNoFullMap, filterRows };
}

export async function processSheetPayFooters(env: Env, runId: string): Promise<void> {
  const meta = await loadSheetPayMeta(env, runId);
  if (!meta) {
    await appendSheetPayRunError(env, runId, "Mß║Ñt dß╗» liß╗çu l├┤ gß╗¡i (KV meta).");
    await finishSheetPayRun(env, runId);
    return;
  }

  for (const target of meta.footerTargets) {
    try {
      await deliverSheetPayFooter(env, meta, target);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await appendSheetPayRunError(
        env,
        runId,
        `T├¬n kh├ích: ${target.customerD} ΓÇö footer lß╗ùi: ${detail.slice(0, 160)}`,
      );
    }
  }

  await finishSheetPayRun(env, runId);
}

export async function processSheetPayChunk(
  env: Env,
  runId: string,
  offset: number,
): Promise<void> {
  const meta = await loadSheetPayMeta(env, runId);
  if (!meta) {
    await appendSheetPayRunError(env, runId, "Mß║Ñt dß╗» liß╗çu l├┤ gß╗¡i (KV meta).");
    await finishSheetPayRun(env, runId);
    return;
  }

  /** Nghß╗ë giß╗»a c├íc l├┤ ΓÇö ─æß║╖t ─æß║ºu l├┤ (kh├┤ng chß║╖n HTTP continue / queue message tr╞░ß╗¢c). */
  if (offset > 0 && meta.batchPauseMs > 0 && !env.SHEET_PAY_QUEUE) {
    await new Promise<void>((r) => setTimeout(r, meta.batchPauseMs));
  }

  const pauseShort = () =>
    new Promise<void>((r) => setTimeout(r, meta.telegramGapMs));

  const slice = meta.rowJobs.slice(offset, offset + meta.chunkSize);
  let sheetCache: ChunkSheetCache | null = null;

  for (const job of slice) {
    try {
      if (!sheetCache) sheetCache = await loadChunkSheetCache(env, meta);
      await deliverSheetPayRowJob(env, meta, job, sheetCache);
      meta.rowsSent++;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await appendSheetPayRunError(
        env,
        runId,
        `D├▓ng ${job.sheetRow1Based} (${job.customerD}): ${detail.slice(0, 160)}`,
      );
    }
    await pauseShort();
  }

  await saveSheetPayMeta(env, meta);
  await updateRowsSentCount(env, runId, meta.rowsSent);

  const nextOffset = offset + meta.chunkSize;
  if (nextOffset < meta.rowJobs.length) {
    await scheduleNextChunk(env, meta, nextOffset);
    return;
  }

  await scheduleFooters(env, meta);
}

async function updateRowsSentCount(env: Env, runId: string, rowsSent: number): Promise<void> {
  if (!env.STORE) return;
  const raw = await env.STORE.get(`sheet_pay:run:${runId}`);
  if (!raw) return;
  try {
    const s = JSON.parse(raw) as SheetPayRunState;
    s.rowsSent = rowsSent;
    await env.STORE.put(`sheet_pay:run:${runId}`, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

async function deliverSheetPayRowJob(
  env: Env,
  meta: SheetPayRunMeta,
  job: SheetPayRowJob,
  cache: ChunkSheetCache,
): Promise<void> {
  const {
    BAO_CAO_TK_TAB_NAME,
    BAO_CAO_COL,
    readBaoCaoTongThuCell,
    sumPayableColumnIUpToRow,
  } = await import("./bao-cao-tk");
  const {
    formatSheetPaymentRowMessage,
    formatMoneyForThanhToanLine,
    formatDebtDisplayForTelegram,
    congNoColumnBForDealerName,
    getCongNoColumnBForCustomerD,
    parseMoneyNumber,
    resolveCongNoMaDlKeyByCustomerName,
  } = await import("./format");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");
  const { writeSheetCell } = await import("./worker-lib");

  const token = await getAccessTokenFromEnv(env);
  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
  const debtMap = cache.debtMap;
  const filterRows = cache.filterRows;

  const entry = filterRows.find((e) => e.sheetRow1Based === job.sheetRow1Based);
  if (!entry) return;

  const row = entry.cells;
  const sheetRow = entry.sheetRow1Based;
  const customerD = job.customerD;
  const chatId = job.chatId;
  const rowMcc = String(row[BAO_CAO_COL.MCC] ?? "");
  const tongThuDisplay = readBaoCaoTongThuCell(row) || "0";
  const tongThuNum = parseMoneyNumber(tongThuDisplay);
  const bStr = getCongNoColumnBForCustomerD(debtMap, customerD);
  const bNum = bStr != null ? parseMoneyNumber(bStr) : 0;
  const openingC = meta.bOldSnapshot[customerD.trim().toLowerCase()] ?? 0;

  let congNoSauMcc: string;
  if (meta.forceResend && tongThuNum > 0) {
    const sumUpTo = sumPayableColumnIUpToRow(filterRows, customerD, sheetRow);
    congNoSauMcc = formatDebtDisplayForTelegram(
      formatMoneyForThanhToanLine(Math.round((openingC + sumUpTo) * 100) / 100),
    );
  } else if (tongThuNum > 0) {
    const base = bStr != null && bNum > 0 ? bNum : openingC;
    congNoSauMcc = formatDebtDisplayForTelegram(
      formatMoneyForThanhToanLine(Math.round((base + tongThuNum) * 100) / 100),
    );
  } else {
    congNoSauMcc = congNoColumnBForDealerName(debtMap, customerD);
  }

  const html = formatSheetPaymentRowMessage({
    ngay: job.panelNgay,
    mcc: rowMcc.trim(),
    taiKhoan: String(row[BAO_CAO_COL.TAI_KHOAN] ?? "").trim(),
    maDlTenKhach: customerD,
    rate: String(row[BAO_CAO_COL.RATE] ?? "").trim(),
    tongTieu: String(row[BAO_CAO_COL.TONG_TIEU] ?? "").trim(),
    tienTe: String(row[BAO_CAO_COL.TIEN_TE] ?? "").trim(),
    quyDoiUsd: String(row[BAO_CAO_COL.QUY_DOI_USD] ?? "").trim(),
    congNoCu: congNoSauMcc,
    tongThu: tongThuDisplay,
    linkFile: String(row[BAO_CAO_COL.LINK_FILE] ?? "").trim(),
  });

  const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);

  const writeRowNote = async (status: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeSheetCell(
          token,
          debtSpreadsheetId,
          BAO_CAO_TK_TAB_NAME,
          BAO_CAO_COL.NOTE_COL_LETTER,
          sheetRow,
          status,
        );
        return;
      } catch {
        if (attempt === 0) await new Promise<void>((r) => setTimeout(r, 400));
      }
    }
  };

  await writeRowNote("Done");

  try {
    await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
  } catch {
    /* ghim lß╗ùi */
  }

  if (tongThuNum > 0 && !meta.forceResend) {
    const { upsertCongNoDebt } = await import("./cong-no-sheet");
    const maDlKey = resolveCongNoMaDlKeyByCustomerName(debtMap, customerD) ?? customerD.trim();
    if (maDlKey) {
      const current = bStr != null ? parseMoneyNumber(bStr) : openingC;
      const newTotal = Math.round((current + tongThuNum) * 100) / 100;
      const newDebtDisplay = formatMoneyForThanhToanLine(newTotal);
      await upsertCongNoDebt(
        token,
        debtSpreadsheetId,
        env.DEBT_TAB_NAME.trim(),
        maDlKey,
        newDebtDisplay,
      );
      debtMap.set(maDlKey, newDebtDisplay);
    }
  }
}

async function deliverSheetPayFooter(
  env: Env,
  meta: SheetPayRunMeta,
  target: SheetPayFooterTarget,
): Promise<void> {
  const footerRunKey = `${target.chatId}\x1e${target.customerD.trim().toLowerCase()}\x1e${meta.filterSig}`;
  if (meta.footerSentKeys.includes(footerRunKey)) return;

  const {
    BAO_CAO_TK_TAB_NAME,
    readBaoCaoTkSheetRows,
    filterBaoCaoSheetRowsBySlots,
    buildTongTienBreakdownForCustomer,
    sumTongThuColumnIForCustomerFilterRows,
    allBaoCaoFilterRowsDoneForCustomer,
  } = await import("./bao-cao-tk");
  const {
    formatTongTienCanThanhToanMessage,
    formatMoneyForThanhToanLine,
    getCongNoColumnBForCustomerD,
    getCongNoOpeningColumnCForCustomerD,
    parseMoneyNumber,
    congNoDebtMatchesTongTien,
  } = await import("./format");
  const { sendHtmlMessage } = await import("./telegram");

  const token = await getAccessTokenFromEnv(env);
  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID?.trim() || env.MAIN_SPREADSHEET_ID.trim();
  const congNoFullMap = await getCongNoFullMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  const debtMap = await getDebtMap(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  const allEntries = await readBaoCaoTkSheetRows(token, debtSpreadsheetId, BAO_CAO_TK_TAB_NAME);
  const filterRows = filterBaoCaoSheetRowsBySlots(allEntries, meta.filterSlots);

  const sumI = sumTongThuColumnIForCustomerFilterRows(filterRows, target.customerD);
  const openingC =
    meta.bOldSnapshot[target.customerD.trim().toLowerCase()] ??
    getCongNoOpeningColumnCForCustomerD(congNoFullMap, target.customerD);
  const bStr = getCongNoColumnBForCustomerD(debtMap, target.customerD);
  const bCurrent = bStr != null ? parseMoneyNumber(bStr) : 0;

  let bOldDisplay: number;
  let total: number;

  if (!meta.forceResend && !allBaoCaoFilterRowsDoneForCustomer(filterRows, target.customerD)) {
    await appendSheetPayRunWarning(
      env,
      meta.runId,
      `Tên khách: ${target.customerD} — chưa gửi hết dòng chi phí (chờ cột J Done).`,
    );
    return;
  }

  const expectedTotal = Math.round((openingC + sumI) * 100) / 100;
  bOldDisplay = openingC;
  total = bCurrent > 0 ? bCurrent : expectedTotal;

  if (sumI > 0 && bCurrent > 0 && !congNoDebtMatchesTongTien(openingC, sumI, bCurrent)) {
    const errMsg = `Tên khách: ${target.customerD} lệch nợ (C=${openingC}, ΣI=${sumI}, B=${bCurrent})`;
    await appendSheetPayRunError(env, meta.runId, errMsg);
    await appendSheetPayLog(env, "error", errMsg, {
      runId: meta.runId,
      customerD: target.customerD,
      openingC,
      sumI,
      bCurrent,
    });
    meta.footerSentKeys.push(footerRunKey);
    await saveSheetPayMeta(env, meta);
    return;
  }

  if (total <= 0) {
    await appendSheetPayRunWarning(
      env,
      meta.runId,
      `Tên khách: ${target.customerD} — bỏ TỔNG TIỀN (nợ đầu ngày C=${openingC} + TỔNG THU=${sumI} = 0).`,
    );
    meta.footerSentKeys.push(footerRunKey);
    await saveSheetPayMeta(env, meta);
    return;
  }

  const pauseShort = () =>
    new Promise<void>((r) => setTimeout(r, meta.telegramGapMs));

  const breakdown = buildTongTienBreakdownForCustomer(filterRows, target.customerD, bOldDisplay);
  const htmlThanhToan = formatTongTienCanThanhToanMessage({
    bOld: formatMoneyForThanhToanLine(bOldDisplay),
    mccLines: breakdown.mccLines.map((line) => ({
      mcc: line.mcc,
      amount: line.amountDisplay,
    })),
    total: formatMoneyForThanhToanLine(total),
  });

  try {
    await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, target.chatId, htmlThanhToan);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await appendSheetPayRunError(
      env,
      meta.runId,
      `T├¬n kh├ích: ${target.customerD} ΓÇö gß╗¡i Tß╗öNG TIß╗ÇN Telegram lß╗ùi: ${detail.slice(0, 160)}`,
    );
    meta.footerSentKeys.push(footerRunKey);
    await saveSheetPayMeta(env, meta);
    return;
  }

  await pauseShort();
  try {
    await sendPaymentQrPhoto(env, target.chatId, pauseShort);
  } catch {
    await appendSheetPayRunWarning(
      env,
      meta.runId,
      `T├¬n kh├ích: ${target.customerD} ΓÇö gß╗¡i QR lß╗ùi (tin tß╗òng ─æ├ú gß╗¡i).`,
    );
  }

  await recordSheetPayFooterSent(env, meta.runId, target.customerD);
  meta.footerSentKeys.push(footerRunKey);
  await saveSheetPayMeta(env, meta);
}
