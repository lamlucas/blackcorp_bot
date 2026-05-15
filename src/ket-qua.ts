/**
 * Port logic từ Source/main.py (GoogleSheet_KET_QUA) — tổng hợp chi phí theo cấp mã, ghi sheet KET_QUA.
 */
import {
  sheetsGet,
  sheetsPutValues,
  sheetsValuesClear,
  sheetsBatchUpdate,
  type SheetGrid,
} from "./google";
import type { Env } from "./worker-lib";
import { getAccessTokenFromEnv } from "./worker-lib";

const OUTPUT_SHEET_KET_QUA = "KET_QUA";
const HEADER_ROWS_SKIP = 3;

export type KetQuaDefaultsJson = {
  spreadsheetUrlOrId?: string;
  campaignCol?: string;
  costCol?: string;
  currencyCol?: string;
  cap1Code?: string;
  cap2Codes?: string;
  accountNameCol?: string;
  accountName?: string;
};

export type KetQuaRunInput = {
  spreadsheetUrlOrId: string;
  campaignCol: string;
  costCol: string;
  currencyCol: string;
  cap1Code: string;
  cap2Codes: string;
  /** Cột chữ (A, B…) — chỉ lọc khi có cả accountName */
  accountNameCol: string;
  accountName: string;
};

function normalizeName(name: string): string {
  return String(name)
    .toUpperCase()
    .replace(/–/g, "-")
    .replace(/—/g, "-")
    .trim();
}

export function parseMoney(value: unknown): number {
  if (typeof value === "number" && !Number.isNaN(value) && Number.isFinite(value)) {
    return value;
  }
  if (value == null) return 0;
  let s = String(value).trim();
  if (!s) return 0;
  s = s.replace(/\s/g, "");
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) {
      s = parts.join("");
    } else {
      s = s.replace(",", ".");
    }
  } else if (hasDot && !hasComma) {
    const parts = s.split(".");
    if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) {
      s = parts.join("");
    }
  }
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function splitLevels(text: string): string[] {
  if (!text) return [];
  let clean = normalizeName(text);
  clean = clean.replace(/\s+/g, "");
  clean = clean.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean || clean.includes("--")) return [];
  return clean.split("-").filter(Boolean);
}

function parseCap2List(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const part of text.split(",")) {
    let s = normalizeName(part);
    s = s.replace(/\s+/g, "");
    s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (s) out.push(s);
  }
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const x of out) {
    if (!seen.has(x)) {
      seen.add(x);
      uniq.push(x);
    }
  }
  return uniq;
}

export function extractSpreadsheetId(userInput: string): string {
  const s = (userInput || "").trim();
  if (!s) return "";
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1] ?? "";
  return s;
}

export function colLettersToIdx(col: string): number {
  const c = (col || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(c)) {
    throw new Error("Cột phải nhập dạng chữ, ví dụ: A, B, AA…");
  }
  let n = 0;
  for (const ch of c) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

type SheetMeta = { sheetId: number; title: string };

async function listSheetsMeta(accessToken: string, spreadsheetId: string): Promise<SheetMeta[]> {
  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(sheetId,title))`
  );
  const out: SheetMeta[] = [];
  for (const s of grid.sheets ?? []) {
    const p = s.properties;
    if (p?.title != null && p.sheetId != null) {
      out.push({ sheetId: p.sheetId, title: p.title });
    }
  }
  return out;
}

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

async function fetchSheetAtoZUnformatted(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string
): Promise<unknown[][]> {
  const q = quoteSheet(sheetTitle);
  const range = `${q}!A:Z`;
  const params = new URLSearchParams();
  params.append("ranges", range);
  params.set("majorDimension", "ROWS");
  params.set("valueRenderOption", "UNFORMATTED_VALUE");
  const path = `${spreadsheetId}/values:batchGet?${params.toString()}`;
  const data = await sheetsGet<{ valueRanges?: Array<{ values?: unknown[][] }> }>(accessToken, path);
  return data.valueRanges?.[0]?.values ?? [];
}

type Bucket = {
  totalsCap1All: Record<string, number>;
  totalsCap2Selected: Record<string, number>;
  totalsCap3ByCap2: Record<string, Record<string, number>>;
  totalAll: number;
  totalCap1Sel: number;
  totalCap1Other: number;
};

/** Cột tên tài khoản: chỉ khi có `filter` mới lọc dòng. */
function accountCellMatches(cell: unknown, filter: string): boolean {
  const want = filter.trim();
  if (!want) return true;
  const got = cell == null ? "" : String(cell).trim();
  return got.localeCompare(want, undefined, { sensitivity: "base" }) === 0;
}

function computeResult(
  allSheetTitles: string[],
  dataBySheet: Map<string, unknown[][]>,
  nameColIdx: number,
  costColIdx: number,
  currencyColIdx: number,
  cap1Code: string,
  cap2Codes: string[],
  headerRows: number,
  accountNameColIdx: number | null,
  accountNameFilter: string | null
): Map<string, Bucket> {
  const reportByCurrency = new Map<string, Bucket>();

  let cap1Norm = normalizeName(cap1Code);
  cap1Norm = cap1Norm.replace(/\s+/g, "");
  cap1Norm = cap1Norm.replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  const cap2Set = new Set(cap2Codes);

  function getBucket(curKey: string): Bucket {
    let b = reportByCurrency.get(curKey);
    if (!b) {
      b = {
        totalsCap1All: {},
        totalsCap2Selected: {},
        totalsCap3ByCap2: {},
        totalAll: 0,
        totalCap1Sel: 0,
        totalCap1Other: 0,
      };
      reportByCurrency.set(curKey, b);
    }
    return b;
  }

  for (const title of allSheetTitles) {
    const data = dataBySheet.get(title) ?? [];
    if (data.length <= headerRows) continue;

    for (let i = headerRows; i < data.length; i++) {
      const row = data[i] ?? [];
      if (
        accountNameColIdx != null &&
        accountNameFilter != null &&
        accountNameFilter.trim() !== ""
      ) {
        const ac = accountNameColIdx < row.length ? row[accountNameColIdx] : undefined;
        if (!accountCellMatches(ac, accountNameFilter)) continue;
      }

      const name = nameColIdx < row.length ? row[nameColIdx] : undefined;
      const cost = costColIdx < row.length ? row[costColIdx] : undefined;
      const currency = currencyColIdx < row.length ? row[currencyColIdx] : undefined;

      if (cost === "" || cost == null) continue;

      const value = parseMoney(cost);
      const nameStr = name == null ? "" : String(name).trim();
      if (!nameStr) continue;

      const levels = splitLevels(nameStr);
      if (!levels.length) continue;

      let cur = currency != null ? normalizeName(String(currency)) : "";
      cur = cur.replace(/\s+/g, "");
      const curKey = cur || "(NO_CURRENCY)";

      const bucket = getBucket(curKey);
      bucket.totalAll += value;

      const cap1 = levels[0] ?? "";
      bucket.totalsCap1All[cap1] = (bucket.totalsCap1All[cap1] ?? 0) + value;

      if (cap1Norm && cap1 === cap1Norm) {
        bucket.totalCap1Sel += value;
      } else if (cap1Norm) {
        bucket.totalCap1Other += value;
      }

      const cap2 = levels.length >= 2 ? levels[1] : "";
      const cap3 = levels.length >= 3 ? levels[2] : "";

      if (cap2 && (cap2Set.size === 0 || cap2Set.has(cap2))) {
        if (cap1Norm && cap1 !== cap1Norm) {
          continue;
        }
        bucket.totalsCap2Selected[cap2] = (bucket.totalsCap2Selected[cap2] ?? 0) + value;
        if (cap3) {
          if (!bucket.totalsCap3ByCap2[cap2]) bucket.totalsCap3ByCap2[cap2] = {};
          const d = bucket.totalsCap3ByCap2[cap2];
          d[cap3] = (d[cap3] ?? 0) + value;
        }
      }
    }
  }

  if (!cap1Norm) {
    for (const [, bucket] of reportByCurrency) {
      bucket.totalCap1Other = bucket.totalAll;
    }
  }

  return reportByCurrency;
}

function buildOutputRows(
  cap1Code: string,
  cap2Codes: string[],
  reportByCurrency: Map<string, Bucket>
): (string | number)[][] {
  let cap1Norm = normalizeName(cap1Code);
  cap1Norm = cap1Norm.replace(/\s+/g, "");
  cap1Norm = cap1Norm.replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  const rows: (string | number)[][] = [];
  const sortedCur = [...reportByCurrency.keys()].sort();

  for (const curKey of sortedCur) {
    const b = reportByCurrency.get(curKey)!;
    const { totalsCap1All, totalsCap2Selected, totalsCap3ByCap2, totalAll, totalCap1Sel, totalCap1Other } = b;

    rows.push([`BAO CAO TIEN TE: ${curKey}`, "", "", "", ""]);
    rows.push(["MA CAP 1", "MA CAP 2", "TONG CAP 2", "MA CAP 3", "TONG CAP 3"]);

    const orderedCap2 = cap2Codes.length ? cap2Codes : Object.keys(totalsCap2Selected).sort();
    for (const cap2 of orderedCap2) {
      const totalCap2 = totalsCap2Selected[cap2] ?? 0;
      rows.push([cap1Norm || "(ALL)", cap2, totalCap2, "", ""]);
      const cap3Map = totalsCap3ByCap2[cap2] ?? {};
      for (const cap3 of Object.keys(cap3Map).sort()) {
        rows.push(["", "", "", cap3, cap3Map[cap3] ?? 0]);
      }
    }

    rows.push([]);
    rows.push(["MA CAP 1", "TONG TIEN"]);
    for (const k of Object.keys(totalsCap1All).sort()) {
      rows.push([k, totalsCap1All[k] ?? 0]);
    }

    rows.push([]);
    rows.push(["TONG CHI PHI (COT CHI PHI)", totalAll]);
    rows.push(["TONG CHI PHI (MA CAP 1 NHAP)", totalCap1Sel]);
    rows.push(["TONG CHI PHI (CAC MA CAP 1 CON LAI)", totalCap1Other]);
    rows.push(["CHI PHI CHENH LECH (TONG - CAP 1 NHAP)", totalAll - totalCap1Sel]);
    rows.push([]);
    rows.push(["--------------------", "--------------------", "--------------------", "--------------------", "--------------------"]);
    rows.push([]);
  }

  return rows;
}

async function ensureOutputSheet(
  accessToken: string,
  spreadsheetId: string,
  title: string
): Promise<void> {
  const meta = await listSheetsMeta(accessToken, spreadsheetId);
  if (meta.some((m) => m.title === title)) return;
  await sheetsBatchUpdate(accessToken, spreadsheetId, [
    { addSheet: { properties: { title } } },
  ]);
}

export async function runKetQuaJob(env: Env, raw: KetQuaRunInput): Promise<{ message: string }> {
  const spreadsheetId = extractSpreadsheetId(raw.spreadsheetUrlOrId);
  if (!spreadsheetId) {
    throw new Error("Link hoặc Spreadsheet ID đang trống / không hợp lệ.");
  }

  const cap2Codes = parseCap2List(raw.cap2Codes);
  const nameColIdx = colLettersToIdx(raw.campaignCol);
  const costColIdx = colLettersToIdx(raw.costCol);
  const currencyColIdx = colLettersToIdx(raw.currencyCol.trim());

  const accColRaw = (raw.accountNameCol ?? "").trim();
  const accNameRaw = (raw.accountName ?? "").trim();
  let accountNameColIdx: number | null = null;
  let accountNameFilter: string | null = null;
  if (accColRaw && accNameRaw) {
    accountNameColIdx = colLettersToIdx(accColRaw);
    accountNameFilter = accNameRaw;
  }

  const skip = new Set<string>([OUTPUT_SHEET_KET_QUA]);

  const token = await getAccessTokenFromEnv(env);
  const meta = await listSheetsMeta(token, spreadsheetId);
  const titles = meta.map((m) => m.title).filter((t) => !skip.has(t));

  const dataBySheet = new Map<string, unknown[][]>();
  for (const title of titles) {
    dataBySheet.set(title, await fetchSheetAtoZUnformatted(token, spreadsheetId, title));
  }

  const headerRows = Math.max(0, Math.min(50, HEADER_ROWS_SKIP));
  const report = computeResult(
    titles,
    dataBySheet,
    nameColIdx,
    costColIdx,
    currencyColIdx,
    raw.cap1Code,
    cap2Codes,
    headerRows,
    accountNameColIdx,
    accountNameFilter
  );

  await ensureOutputSheet(token, spreadsheetId, OUTPUT_SHEET_KET_QUA);
  const q = quoteSheet(OUTPUT_SHEET_KET_QUA);
  await sheetsValuesClear(token, spreadsheetId, `${q}!A:Z`);
  const rows = buildOutputRows(raw.cap1Code, cap2Codes, report);
  await sheetsPutValues(token, spreadsheetId, `${q}!A1`, rows, "RAW");

  return {
    message: `Đã ghi đè tab « ${OUTPUT_SHEET_KET_QUA} » (${rows.length} dòng, ${report.size} loại tiền tệ).`,
  };
}

export function parseKetQuaDefaultsFromEnv(env: Env): KetQuaDefaultsJson | null {
  const raw = env.KET_QUA_DEFAULTS_JSON;
  if (raw == null || String(raw).trim() === "") return null;
  try {
    return JSON.parse(String(raw)) as KetQuaDefaultsJson;
  } catch {
    throw new Error("Biến KET_QUA_DEFAULTS_JSON không phải JSON hợp lệ.");
  }
}
