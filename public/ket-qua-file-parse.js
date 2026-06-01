/** Đọc XLSX/CSV trên trình duyệt (SheetJS CDN). */

let xlsxLoadPromise = null;

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

/** Parse CSV — hỗ trợ dấu phẩy, ngoặc kép, xuống dòng trong ô. */
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

export async function parseSpreadsheetFile(file) {
  const name = String(file.name ?? "").toLowerCase();
  if (name.endsWith(".csv")) {
    const text = await file.text();
    return parseCsvText(text);
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await loadXlsxLib();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
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
