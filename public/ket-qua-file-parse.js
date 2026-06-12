/** Đọc CSV/XLSX trên trình duyệt (dự phòng khi không gọi được Worker). */

let xlsxLoadPromise = null;

export const SLIM_COLUMN_MAP = {
  campaignCol: "A",
  costCol: "B",
  currencyCol: "C",
  accountNameCol: "D",
};

export function colLettersToIdx(col) {
  const c = String(col ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]+$/.test(c)) {
    throw new Error(`Cột không hợp lệ: ${col}`);
  }
  let n = 0;
  for (const ch of c) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export function loadXlsxLib() {
  if (typeof globalThis.XLSX !== "undefined") {
    return Promise.resolve(globalThis.XLSX);
  }
  if (!xlsxLoadPromise) {
    xlsxLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.async = true;
      s.onload = () => {
        if (globalThis.XLSX) resolve(globalThis.XLSX);
        else reject(new Error("Không tải được thư viện XLSX."));
      };
      s.onerror = () => reject(new Error("Không tải được thư viện XLSX từ CDN."));
      document.head.appendChild(s);
    });
  }
  return xlsxLoadPromise;
}

export function parseCsvText(text) {
  const raw = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r" && next === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) {
    rows.push(row);
  }

  return rows;
}

function cellStr(row, colIdx) {
  if (colIdx < 0 || colIdx >= row.length) return "";
  const v = row[colIdx];
  if (v == null) return "";
  return String(v).trim();
}

async function parseSpreadsheetFileFull(file) {
  const name = String(file.name ?? "").toLowerCase();
  if (name.endsWith(".csv")) {
    const text = await file.text();
    return parseCsvText(text);
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await loadXlsxLib();
    const buf = await file.arrayBuffer();
    let wb;
    try {
      wb = XLSX.read(buf, {
        type: "array",
        cellDates: false,
        dense: true,
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        sheetStubs: false,
      });
    } catch (e) {
      const hint = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Không đọc được « ${file.name} » (${hint}). Thử mở bằng Excel → Lưu lại, hoặc xuất CSV.`,
      );
    }
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    const sheet = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
  }
  throw new Error(`Định dạng không hỗ trợ: ${file.name} (chỉ .xlsx, .xls, .csv).`);
}

/** Thu gọn 4 cột + đọc tuần tự từng file (giảm RAM). */
export async function parseSpreadsheetFileSlim(file, config) {
  const headerRows = config.headerRows ?? 3;
  const accIdx = colLettersToIdx(config.accountNameCol);
  const campIdx = colLettersToIdx(config.campaignCol);
  const costIdx = colLettersToIdx(config.costCol);
  const currIdx = colLettersToIdx(config.currencyCol);

  const full = await parseSpreadsheetFileFull(file);
  const slim = [];
  for (let i = 0; i < full.length; i++) {
    const row = full[i] ?? [];
    if (i < headerRows) {
      slim.push(["", "", "", ""]);
      continue;
    }
    slim.push([
      cellStr(row, accIdx),
      cellStr(row, campIdx),
      costIdx < row.length ? row[costIdx] : "",
      cellStr(row, currIdx),
    ]);
  }
  return slim;
}

/** @deprecated dùng parseSpreadsheetFileSlim */
export async function parseSpreadsheetFile(file) {
  return parseSpreadsheetFileFull(file);
}
