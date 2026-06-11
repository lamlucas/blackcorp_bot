/**
 * Lọc File Account Back — so sánh tài khoản/chiến dịch giữa các tab Sheet, ghi báo cáo ra tab mới.
 */
import {
  colLettersToIdx,
  parseMoney,
  computeResult,
  buildOutputRows,
  parseCap2List,
  HEADER_ROWS_SKIP,
  extractSpreadsheetId,
} from "./ket-qua";
import {
  sheetsGet,
  sheetsPutValues,
  sheetsValuesClear,
  sheetsBatchUpdate,
  type SheetGrid,
} from "./google";
import type { Env } from "./worker-lib";
import { getAccessTokenFromEnv } from "./worker-lib";

/** Tab báo cáo TK Back (không đọc làm nguồn). */
export const TK_BACK_OUTPUT_SHEETS = {
  account: "TK_BACK_TAI_KHOAN",
  tinhTien: "TK_BACK_TINH_TIEN",
} as const;

/** Tab báo cáo cũ (giữ để bỏ qua khi đọc nguồn). */
export const ACCOUNT_BACK_OUTPUT_SHEETS = {
  account: "BACK_TAI_KHOAN",
  campaign: "BACK_CHIEN_DICH",
  ketQua: "BACK_KET_QUA",
} as const;

const SKIP_SOURCE_TABS = new Set<string>([
  "KET_QUA",
  ACCOUNT_BACK_OUTPUT_SHEETS.account,
  ACCOUNT_BACK_OUTPUT_SHEETS.campaign,
  ACCOUNT_BACK_OUTPUT_SHEETS.ketQua,
  TK_BACK_OUTPUT_SHEETS.account,
  TK_BACK_OUTPUT_SHEETS.tinhTien,
]);

export type ParsedFileInput = {
  fileName: string;
  rows: unknown[][];
};

export type KetQuaFilesConfig = {
  campaignCol: string;
  costCol: string;
  currencyCol: string;
  cap1Code: string;
  cap2Codes: string;
  accountNameCol: string;
  headerRows?: number;
};

export type KetQuaFilesAnalyzeResult = {
  accountReportTxt: string;
  campaignReportTxt: string;
  ketQuaCsv: string;
  summary: string;
};

function normKey(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function normDisplay(s: string): string {
  return String(s ?? "").trim();
}

function cellStr(row: unknown[], colIdx: number): string {
  if (colIdx < 0 || colIdx >= row.length) return "";
  return normDisplay(String(row[colIdx] ?? ""));
}

/** Thu thập tài khoản / chiến dịch theo từng file (chi phí cao nhất mỗi cặp tài khoản+chiến dịch trong file). */
function collectPerFile(
  files: ParsedFileInput[],
  accColIdx: number,
  campColIdx: number,
  costColIdx: number,
  headerRows: number,
): {
  accountsByFile: Map<string, Set<string>>;
  /** fileName -> accountKey -> campaignKey -> { display, cost } */
  campaignsByFile: Map<string, Map<string, Map<string, { display: string; cost: number }>>>;
} {
  const accountsByFile = new Map<string, Set<string>>();
  const campaignsByFile = new Map<string, Map<string, Map<string, { display: string; cost: number }>>>();

  for (const f of files) {
    const accSet = new Set<string>();
    const campMap = new Map<string, Map<string, { display: string; cost: number }>>();

    for (let i = headerRows; i < f.rows.length; i++) {
      const row = f.rows[i] ?? [];
      const acc = cellStr(row, accColIdx);
      const camp = cellStr(row, campColIdx);
      const costRaw = costColIdx < row.length ? row[costColIdx] : undefined;
      if (!acc || !camp) continue;
      const cost = parseMoney(costRaw);
      if (costRaw === "" || costRaw == null) continue;

      accSet.add(acc);
      const accKey = normKey(acc);
      let byCamp = campMap.get(accKey);
      if (!byCamp) {
        byCamp = new Map();
        campMap.set(accKey, byCamp);
      }
      const campKey = normKey(camp);
      const prev = byCamp.get(campKey);
      if (!prev || cost >= prev.cost) {
        byCamp.set(campKey, { display: camp, cost });
      }
    }

    accountsByFile.set(f.fileName, accSet);
    campaignsByFile.set(f.fileName, campMap);
  }

  return { accountsByFile, campaignsByFile };
}

/** Báo cáo 1: tài khoản có ở file này nhưng thiếu ở file khác. */
export function buildAccountPresenceReport(
  files: ParsedFileInput[],
  accountNameCol: string,
  headerRows = HEADER_ROWS_SKIP,
): string {
  if (files.length === 0) return "Không có file nào.";
  const accColIdx = colLettersToIdx(accountNameCol);
  const fileNames = files.map((f) => f.fileName);
  const { accountsByFile } = collectPerFile(files, accColIdx, 0, 0, headerRows);

  const allAccounts = new Set<string>();
  for (const set of accountsByFile.values()) {
    for (const a of set) allAccounts.add(a);
  }

  const lines: string[] = [];
  lines.push("=== BÁO CÁO TÀI KHOẢN (có / không có giữa các file) ===");
  lines.push(`Số file: ${fileNames.length}`);
  lines.push(`Danh sách file: ${fileNames.join(" | ")}`);
  lines.push(`Cột tên tài khoản: ${accountNameCol.toUpperCase()}`);
  lines.push(`Bỏ qua ${headerRows} dòng đầu mỗi file (tiêu đề).`);
  lines.push("");

  const sorted = [...allAccounts].sort((a, b) => a.localeCompare(b, "vi"));
  let count = 0;
  for (const acc of sorted) {
    const present: string[] = [];
    const absent: string[] = [];
    for (const fn of fileNames) {
      const set = accountsByFile.get(fn) ?? new Set();
      if (set.has(acc)) present.push(fn);
      else absent.push(fn);
    }
    if (absent.length === 0) continue;
    count++;
    lines.push(`TÀI KHOẢN: ${acc}`);
    lines.push(`  CÓ trong file: ${present.join(", ") || "(không)"}`);
    lines.push(`  KHÔNG CÓ trong file: ${absent.join(", ")}`);
    lines.push("");
  }

  if (count === 0) {
    lines.push("(Mọi tài khoản đều xuất hiện trong tất cả các file — hoặc không có tài khoản nào.)");
  }

  return lines.join("\n");
}

/** Báo cáo 2: chiến dịch theo tài khoản — chỉ có ở một số file (kèm chi phí cao nhất). */
export function buildCampaignCrossFileReport(
  files: ParsedFileInput[],
  config: KetQuaFilesConfig,
): string {
  if (files.length === 0) return "Không có file nào.";
  const headerRows = config.headerRows ?? HEADER_ROWS_SKIP;
  const accColIdx = colLettersToIdx(config.accountNameCol);
  const campColIdx = colLettersToIdx(config.campaignCol);
  const costColIdx = colLettersToIdx(config.costCol);
  const fileNames = files.map((f) => f.fileName);

  const { campaignsByFile } = collectPerFile(
    files,
    accColIdx,
    campColIdx,
    costColIdx,
    headerRows,
  );

  const accountKeys = new Set<string>();
  for (const fn of fileNames) {
    for (const k of campaignsByFile.get(fn)?.keys() ?? []) accountKeys.add(k);
  }

  const lines: string[] = [];
  lines.push("=== BÁO CÁO CHIẾN DỊCH (chỉ có ở một số file / trùng tên giữa các file) ===");
  lines.push(`Số file: ${fileNames.length}`);
  lines.push(`File: ${fileNames.join(" | ")}`);
  lines.push(
    `Cột: tài khoản=${config.accountNameCol}, chiến dịch=${config.campaignCol}, chi phí=${config.costCol}`,
  );
  lines.push("");

  let asymCount = 0;
  let dupCount = 0;

  for (const accKey of [...accountKeys].sort()) {
    const campaignKeys = new Set<string>();
    for (const fn of fileNames) {
      for (const ck of campaignsByFile.get(fn)?.get(accKey)?.keys() ?? []) {
        campaignKeys.add(ck);
      }
    }

    for (const campKey of [...campaignKeys].sort()) {
      const presentFiles: string[] = [];
      const costs: { file: string; campaign: string; cost: number }[] = [];

      for (const fn of fileNames) {
        const entry = campaignsByFile.get(fn)?.get(accKey)?.get(campKey);
        if (entry) {
          presentFiles.push(fn);
          costs.push({ file: fn, campaign: entry.display, cost: entry.cost });
        }
      }

      if (presentFiles.length === 0) continue;

      const accLabel = findAccountDisplay(files, accColIdx, accKey, headerRows);
      const campLabel = costs[0]?.campaign ?? campKey;

      if (presentFiles.length > 1) {
        dupCount++;
        const max = costs.reduce((a, b) => (b.cost > a.cost ? b : a));
        lines.push(`[TRÙNG TÊN CHIẾN DỊCH — nhiều file] TÀI KHOẢN: ${accLabel}`);
        lines.push(`  Chiến dịch: ${campLabel}`);
        lines.push(`  Có trong: ${presentFiles.join(", ")}`);
        for (const c of costs.sort((a, b) => b.cost - a.cost)) {
          lines.push(`    - ${c.file}: chi phí ${c.cost}`);
        }
        lines.push(`  Chi phí cao nhất: ${max.cost} (${max.file})`);
        lines.push("");
      }

      if (presentFiles.length > 0 && presentFiles.length < fileNames.length) {
        asymCount++;
        const absent = fileNames.filter((fn) => !presentFiles.includes(fn));
        const max = costs.reduce((a, b) => (b.cost > a.cost ? b : a));
        lines.push(`[CHỈ MỘT SỐ FILE] TÀI KHOẢN: ${accLabel}`);
        lines.push(`  Chiến dịch: ${campLabel}`);
        lines.push(`  Chi phí cao nhất: ${max.cost} — file: ${max.file}`);
        lines.push(`  CÓ trong file: ${presentFiles.join(", ")}`);
        lines.push(`  KHÔNG CÓ trong file: ${absent.join(", ")}`);
        lines.push("");
      }
    }
  }

  lines.push(`Tổng: ${asymCount} chiến dịch chỉ có ở một số file; ${dupCount} chiến dịch trùng tên ở nhiều file.`);

  return lines.join("\n");
}

/** Tài khoản có ở một số file nhưng thiếu ở file khác. */
export function getAsymmetricAccountNames(
  files: ParsedFileInput[],
  accountNameCol: string,
  headerRows = HEADER_ROWS_SKIP,
): string[] {
  if (files.length < 2) return [];
  const accColIdx = colLettersToIdx(accountNameCol);
  const fileNames = files.map((f) => f.fileName);
  const { accountsByFile } = collectPerFile(files, accColIdx, 0, 0, headerRows);

  const allAccounts = new Set<string>();
  for (const set of accountsByFile.values()) {
    for (const a of set) allAccounts.add(a);
  }

  const out: string[] = [];
  for (const acc of [...allAccounts].sort((a, b) => a.localeCompare(b, "vi"))) {
    let presentCount = 0;
    for (const fn of fileNames) {
      if ((accountsByFile.get(fn) ?? new Set()).has(acc)) presentCount++;
    }
    if (presentCount > 0 && presentCount < fileNames.length) {
      out.push(acc);
    }
  }
  return out;
}

/** Tính tiền theo mã cấp (logic KET_QUA) cho từng tài khoản back, nhóm theo tiền tệ. */
export function buildKetQuaRowsForAccounts(
  files: ParsedFileInput[],
  config: KetQuaFilesConfig,
  accountNames: string[],
): (string | number)[][] {
  if (!accountNames.length) {
    return [
      [
        "(Không có tài khoản nào chỉ xuất hiện ở một số file — không tính tiền.)",
      ],
    ];
  }

  const headerRows = config.headerRows ?? HEADER_ROWS_SKIP;
  const cap2Codes = parseCap2List(config.cap2Codes);
  const nameColIdx = colLettersToIdx(config.campaignCol);
  const costColIdx = colLettersToIdx(config.costCol);
  const currencyColIdx = colLettersToIdx(config.currencyCol.trim());
  const accColIdx = colLettersToIdx(config.accountNameCol);

  const titles = files.map((f) => f.fileName);
  const dataBySheet = new Map<string, unknown[][]>();
  for (const f of files) {
    dataBySheet.set(f.fileName, f.rows);
  }

  const out: (string | number)[][] = [
    [
      "Báo cáo tính tiền cho tài khoản « back » (có ở một số file, thiếu ở file khác). Mỗi khối = một tài khoản; bên trong nhóm theo đơn vị tiền tệ.",
    ],
    [],
  ];

  for (const accName of accountNames) {
    const report = computeResult(
      titles,
      dataBySheet,
      nameColIdx,
      costColIdx,
      currencyColIdx,
      config.cap1Code,
      cap2Codes,
      headerRows,
      accColIdx,
      accName,
    );
    out.push([`=== TÀI KHOẢN: ${accName} ===`, "", "", "", ""]);
    out.push(...buildOutputRows(config.cap1Code, cap2Codes, report));
    out.push([]);
  }

  return out;
}

export function parseSpreadsheetLinks(text: string): string[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new Error("Nhập ít nhất một link Google Sheet (mỗi dòng một link).");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const id = extractSpreadsheetId(line);
    if (!id) {
      throw new Error(`Link không hợp lệ: ${line}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function findAccountDisplay(
  files: ParsedFileInput[],
  accColIdx: number,
  accKey: string,
  headerRows: number,
): string {
  for (const f of files) {
    for (let i = headerRows; i < f.rows.length; i++) {
      const row = f.rows[i] ?? [];
      const acc = cellStr(row, accColIdx);
      if (acc && normKey(acc) === accKey) return acc;
    }
  }
  return accKey;
}

function rowsToCsv(rows: (string | number)[][]): string {
  return rows
    .map((row) =>
      row
        .map((c) => {
          const s = String(c ?? "");
          if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        })
        .join(","),
    )
    .join("\r\n");
}

/** Tổng hợp KET_QUA giống tab Sheet — mỗi file = một “tab”. */
export function buildKetQuaFromFiles(
  files: ParsedFileInput[],
  config: KetQuaFilesConfig,
): (string | number)[][] {
  const headerRows = config.headerRows ?? HEADER_ROWS_SKIP;
  const cap2Codes = parseCap2List(config.cap2Codes);
  const nameColIdx = colLettersToIdx(config.campaignCol);
  const costColIdx = colLettersToIdx(config.costCol);
  const currencyColIdx = colLettersToIdx(config.currencyCol.trim());

  const titles = files.map((f) => f.fileName);
  const dataBySheet = new Map<string, unknown[][]>();
  for (const f of files) {
    dataBySheet.set(f.fileName, f.rows);
  }

  const report = computeResult(
    titles,
    dataBySheet,
    nameColIdx,
    costColIdx,
    currencyColIdx,
    config.cap1Code,
    cap2Codes,
    headerRows,
    null,
    null,
  );

  return buildOutputRows(config.cap1Code, cap2Codes, report);
}

export function analyzeKetQuaFiles(
  files: ParsedFileInput[],
  config: KetQuaFilesConfig,
): KetQuaFilesAnalyzeResult {
  if (!files.length) {
    throw new Error("Không có tab nguồn nào trên Sheet.");
  }
  if (!config.accountNameCol?.trim()) {
    throw new Error("Nhập cột tên tài khoản (bắt buộc để so sánh giữa các file).");
  }
  if (!config.campaignCol?.trim() || !config.costCol?.trim() || !config.currencyCol?.trim()) {
    throw new Error("Nhập đủ cột chiến dịch, chi phí và đơn vị tiền tệ.");
  }

  colLettersToIdx(config.accountNameCol);
  colLettersToIdx(config.campaignCol);
  colLettersToIdx(config.costCol);
  colLettersToIdx(config.currencyCol);

  const accountReportTxt = buildAccountPresenceReport(
    files,
    config.accountNameCol,
    config.headerRows ?? HEADER_ROWS_SKIP,
  );
  const campaignReportTxt = buildCampaignCrossFileReport(files, config);
  const ketQuaRows = buildKetQuaFromFiles(files, config);
  const ketQuaCsv = rowsToCsv(ketQuaRows);

  return {
    accountReportTxt,
    campaignReportTxt,
    ketQuaCsv,
    summary: `Đã phân tích ${files.length} tab. Xem tab « ${ACCOUNT_BACK_OUTPUT_SHEETS.account} », « ${ACCOUNT_BACK_OUTPUT_SHEETS.campaign} », « ${ACCOUNT_BACK_OUTPUT_SHEETS.ketQua} » trên Sheet.`,
  };
}

export type AccountBackFilterInput = {
  spreadsheetUrlOrId: string;
  campaignCol: string;
  costCol: string;
  currencyCol: string;
  cap1Code: string;
  cap2Codes: string;
  accountNameCol: string;
};

/** Input panel Tính Tiền TK Back — nhiều link, ghi tab trên Sheet kết quả. */
export type TkBackInput = {
  /** Mỗi dòng một link Google Sheet (= một file nguồn). */
  spreadsheetLinks: string;
  /** Sheet nhận báo cáo; mặc định = link dòng đầu. */
  outputSpreadsheetUrlOrId?: string;
  campaignCol: string;
  costCol: string;
  currencyCol: string;
  cap1Code: string;
  cap2Codes: string;
  accountNameCol: string;
};

type SheetMeta = { sheetId: number; title: string };

function quoteSheet(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

async function listSheetsMeta(accessToken: string, spreadsheetId: string): Promise<SheetMeta[]> {
  const grid = await sheetsGet<SheetGrid>(
    accessToken,
    `${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
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

async function fetchSheetAtoZUnformatted(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
): Promise<unknown[][]> {
  const q = quoteSheet(sheetTitle);
  const range = `${q}!A:ZZ`;
  const params = new URLSearchParams();
  params.append("ranges", range);
  params.set("majorDimension", "ROWS");
  params.set("valueRenderOption", "UNFORMATTED_VALUE");
  const path = `${spreadsheetId}/values:batchGet?${params.toString()}`;
  const data = await sheetsGet<{ valueRanges?: Array<{ values?: unknown[][] }> }>(accessToken, path);
  return data.valueRanges?.[0]?.values ?? [];
}

async function ensureOutputSheet(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<void> {
  const meta = await listSheetsMeta(accessToken, spreadsheetId);
  if (meta.some((m) => m.title === title)) return;
  await sheetsBatchUpdate(accessToken, spreadsheetId, [{ addSheet: { properties: { title } } }]);
}

function textReportToRows(text: string): (string | number)[][] {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => [line]);
}

async function writeSheetTab(
  accessToken: string,
  spreadsheetId: string,
  title: string,
  rows: (string | number)[][],
): Promise<number> {
  await ensureOutputSheet(accessToken, spreadsheetId, title);
  const q = quoteSheet(title);
  await sheetsValuesClear(accessToken, spreadsheetId, `${q}!A:ZZ`);
  if (rows.length > 0) {
    await sheetsPutValues(accessToken, spreadsheetId, `${q}!A1`, rows, "RAW");
  }
  return rows.length;
}

async function getSpreadsheetTitle(
  accessToken: string,
  spreadsheetId: string,
): Promise<string> {
  const data = await sheetsGet<{ properties?: { title?: string } }>(
    accessToken,
    `${spreadsheetId}?fields=properties(title)`,
  );
  return data.properties?.title?.trim() || spreadsheetId;
}

async function loadFirstSourceSheetFromSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  fileLabel: string,
): Promise<ParsedFileInput> {
  const meta = await listSheetsMeta(accessToken, spreadsheetId);
  const title = meta.map((m) => m.title).find((t) => !SKIP_SOURCE_TABS.has(t));
  if (!title) {
    throw new Error(`« ${fileLabel} »: không có tab dữ liệu (đã bỏ tab báo cáo/KET_QUA).`);
  }
  const rows = await fetchSheetAtoZUnformatted(accessToken, spreadsheetId, title);
  return { fileName: fileLabel, rows };
}

async function loadSourceTabsFromSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
): Promise<ParsedFileInput[]> {
  const meta = await listSheetsMeta(accessToken, spreadsheetId);
  const titles = meta.map((m) => m.title).filter((t) => !SKIP_SOURCE_TABS.has(t));
  if (titles.length === 0) {
    throw new Error(
      "Không có tab nguồn nào (đã bỏ KET_QUA và các tab báo cáo BACK_*). Thêm tab dữ liệu vào Sheet.",
    );
  }
  const files: ParsedFileInput[] = [];
  for (const title of titles) {
    const rows = await fetchSheetAtoZUnformatted(accessToken, spreadsheetId, title);
    files.push({ fileName: title, rows });
  }
  return files;
}

/** Đọc mọi tab nguồn trên Sheet, lọc Account Back, ghi 3 tab báo cáo. */
export async function runAccountBackFilterJob(
  env: Env,
  raw: AccountBackFilterInput,
): Promise<{ message: string }> {
  const spreadsheetId = extractSpreadsheetId(raw.spreadsheetUrlOrId);
  if (!spreadsheetId) {
    throw new Error("Link hoặc Spreadsheet ID đang trống / không hợp lệ.");
  }

  const config: KetQuaFilesConfig = {
    campaignCol: raw.campaignCol.trim(),
    costCol: raw.costCol.trim(),
    currencyCol: raw.currencyCol.trim(),
    cap1Code: raw.cap1Code.trim(),
    cap2Codes: raw.cap2Codes.trim(),
    accountNameCol: raw.accountNameCol.trim(),
    headerRows: HEADER_ROWS_SKIP,
  };

  const token = await getAccessTokenFromEnv(env);
  const files = await loadSourceTabsFromSpreadsheet(token, spreadsheetId);
  const result = analyzeKetQuaFiles(files, config);

  const accRows = await writeSheetTab(
    token,
    spreadsheetId,
    ACCOUNT_BACK_OUTPUT_SHEETS.account,
    textReportToRows(result.accountReportTxt),
  );
  const campRows = await writeSheetTab(
    token,
    spreadsheetId,
    ACCOUNT_BACK_OUTPUT_SHEETS.campaign,
    textReportToRows(result.campaignReportTxt),
  );
  const ketQuaRows = buildKetQuaFromFiles(files, config);
  const ketRows = await writeSheetTab(
    token,
    spreadsheetId,
    ACCOUNT_BACK_OUTPUT_SHEETS.ketQua,
    ketQuaRows,
  );

  return {
    message:
      `Đã lọc ${files.length} tab nguồn. Ghi báo cáo: « ${ACCOUNT_BACK_OUTPUT_SHEETS.account} » (${accRows} dòng), « ${ACCOUNT_BACK_OUTPUT_SHEETS.campaign} » (${campRows} dòng), « ${ACCOUNT_BACK_OUTPUT_SHEETS.ketQua} » (${ketRows} dòng).`,
  };
}

/** Tính Tiền TK Back: nhiều link Sheet, lọc tài khoản back, tính tiền theo tài khoản + tiền tệ. */
export async function runTkBackJob(env: Env, raw: TkBackInput): Promise<{ message: string }> {
  const sourceIds = parseSpreadsheetLinks(raw.spreadsheetLinks);
  const outputId = raw.outputSpreadsheetUrlOrId?.trim()
    ? extractSpreadsheetId(raw.outputSpreadsheetUrlOrId)
    : sourceIds[0];
  if (!outputId) {
    throw new Error("Link Sheet kết quả không hợp lệ.");
  }

  const config: KetQuaFilesConfig = {
    campaignCol: raw.campaignCol.trim(),
    costCol: raw.costCol.trim(),
    currencyCol: raw.currencyCol.trim(),
    cap1Code: raw.cap1Code.trim(),
    cap2Codes: raw.cap2Codes.trim(),
    accountNameCol: raw.accountNameCol.trim(),
    headerRows: HEADER_ROWS_SKIP,
  };

  if (!config.accountNameCol) {
    throw new Error("Nhập cột tên tài khoản (bắt buộc).");
  }
  if (!config.campaignCol || !config.costCol || !config.currencyCol) {
    throw new Error("Nhập đủ cột chiến dịch, chi phí và đơn vị tiền tệ.");
  }

  const token = await getAccessTokenFromEnv(env);
  const files: ParsedFileInput[] = [];

  for (let i = 0; i < sourceIds.length; i++) {
    const id = sourceIds[i]!;
    const title = await getSpreadsheetTitle(token, id);
    const label = sourceIds.length > 1 ? `${i + 1}. ${title}` : title;
    files.push(await loadFirstSourceSheetFromSpreadsheet(token, id, label));
  }

  const asymmetricAccounts = getAsymmetricAccountNames(
    files,
    config.accountNameCol,
    config.headerRows,
  );

  const accountReportTxt = buildAccountPresenceReport(
    files,
    config.accountNameCol,
    config.headerRows,
  );
  const tinhTienRows = buildKetQuaRowsForAccounts(files, config, asymmetricAccounts);

  const accRows = await writeSheetTab(
    token,
    outputId,
    TK_BACK_OUTPUT_SHEETS.account,
    textReportToRows(accountReportTxt),
  );
  const tienRows = await writeSheetTab(
    token,
    outputId,
    TK_BACK_OUTPUT_SHEETS.tinhTien,
    tinhTienRows,
  );

  return {
    message:
      `Đã đọc ${files.length} file Sheet. Tìm ${asymmetricAccounts.length} tài khoản back. ` +
      `Ghi tab « ${TK_BACK_OUTPUT_SHEETS.account} » (${accRows} dòng) và « ${TK_BACK_OUTPUT_SHEETS.tinhTien} » (${tienRows} dòng) ` +
      `trên Sheet kết quả.`,
  };
}
