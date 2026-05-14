/** Logic chung tab THU_CHI (Google Sheet + bot Telegram). */

export const THU_CHI_PAD_ROWS = 500;

export function num(s: string | undefined): number {
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

/** Serial ngày Google Sheet (ô định dạng Ngày) → YYYY-MM-DD (UTC theo serial). */
export function sheetsSerialToIsoDate(serial: number): string {
  const days = Math.floor(serial);
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + days * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 1970 || y > 2100) return String(serial);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Chuẩn hoá chuỗi ngày (ISO, dd/mm/yyyy, serial Sheet) → `yyyy-mm-dd` để gom theo tháng đúng. */
export function flexibleDateToIso(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const core = raw.split(/\s+/)[0] ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(core)) return core;
  const iso = core.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = core.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const n = Number(String(core).replace(",", "."));
  if (Number.isFinite(n) && n > 35000 && n < 65000 && Math.floor(n) === n) {
    return sheetsSerialToIsoDate(Math.floor(n));
  }
  return raw;
}

export function stringifySheetRow(cells: unknown): string[] {
  if (!Array.isArray(cells)) return [];
  return cells.map((c) => {
    if (c == null || c === "") return "";
    if (typeof c === "boolean") return c ? "TRUE" : "FALSE";
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
    return String(c);
  });
}

/** Chuẩn hóa một dòng THU_CHI sau batchGet UNFORMATTED. */
export function normalizeThuChiDataRow(cells: unknown): string[] {
  const src = Array.isArray(cells) ? cells : [];
  const row = [...src];
  while (row.length < 4) row.push("");
  const a = row[0];
  let ngay = "";
  if (typeof a === "number" && Number.isFinite(a)) {
    ngay = sheetsSerialToIsoDate(a);
  } else {
    ngay = String(a ?? "").trim();
  }
  const th = row[1];
  const thu = typeof th === "number" && Number.isFinite(th) ? String(th) : String(th ?? "").trim();
  const ch = row[2];
  const chi = typeof ch === "number" && Number.isFinite(ch) ? String(ch) : String(ch ?? "").trim();
  const ghiChu = String(row[3] ?? "").trim();
  return [ngay, thu, chi, ghiChu];
}

function numericOrText(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell).trim();
}

/** Số cột dữ liệu Bán dao (A–G). */
export const BAN_DAO_COLS = 7;

/** Chuẩn hóa một dòng BAN_DAO: A ngày, B Tên, C Địa chỉ, D SĐT, E SL, F Giá, G Thành tiền. */
export function normalizeBanDaoDataRow(cells: unknown): string[] {
  const src = Array.isArray(cells) ? cells : [];
  const row = [...src];
  while (row.length < BAN_DAO_COLS) row.push("");
  const a = row[0];
  let ngay = "";
  if (typeof a === "number" && Number.isFinite(a)) {
    ngay = sheetsSerialToIsoDate(a);
  } else {
    ngay = String(a ?? "").trim();
  }
  return [
    ngay,
    String(row[1] ?? "").trim(),
    String(row[2] ?? "").trim(),
    String(row[3] ?? "").trim(),
    numericOrText(row[4]),
    numericOrText(row[5]),
    numericOrText(row[6]),
  ];
}

/** Giữ dòng tiêu đề + dữ liệu cũ (bỏ dòng trống cuối) rồi nối dòng mới, pad cột G. */
export function buildBanDaoAppendedMatrix(
  existing: unknown[][],
  appendedBodyRows: (string | number)[][],
): (string | number)[][] {
  const header = existing[0]?.length
    ? stringifySheetRow(existing[0] as unknown[])
    : ["Ngày", "Tên", "Địa chỉ", "SĐT", "Số lượng", "Giá", "Thành tiền"];
  while (header.length < BAN_DAO_COLS) header.push("");
  const h = header.slice(0, BAN_DAO_COLS).map(String);
  const body: string[][] = [];
  for (let i = 1; i < existing.length; i++) {
    const row = stringifySheetRow((existing[i] as unknown[]) ?? []).slice(0, BAN_DAO_COLS);
    while (row.length < BAN_DAO_COLS) row.push("");
    if (row.join("").trim()) body.push(row);
  }
  for (const r of appendedBodyRows) {
    const o = [...r];
    while (o.length < BAN_DAO_COLS) o.push("");
    body.push(o.slice(0, BAN_DAO_COLS).map((c) => String(c ?? "")));
  }
  return padMatrix([h, ...body], BAN_DAO_COLS);
}

/** Chuẩn bị ma trận ghi Sheet: giữ kiểu number cho ô số (B, C) để tránh locale. */
export function padMatrix(rows: (string | number)[][], cols: number): (string | number)[][] {
  const out = rows.map((r) =>
    r.map((c) => {
      if (c == null) return "";
      if (typeof c === "number") {
        if (!Number.isFinite(c)) return "";
        return c;
      }
      return String(c);
    }),
  );
  const target = Math.max(THU_CHI_PAD_ROWS, out.length);
  while (out.length < target) {
    out.push(Array(cols).fill("") as (string | number)[]);
  }
  return out;
}

export function parseRows(rows: string[][], cols: number): string[][] {
  return rows.map((r) => {
    const o = [...r];
    while (o.length < cols) o.push("");
    return o.slice(0, cols).map((c) => (c == null ? "" : String(c)));
  });
}

export type ThuChiSheetModel = {
  ngay: string;
  thu: string;
  chi: string;
  ghiChu: string;
};

/** Tab COC: A Ngày, B Thu, C Chi, D Tên, E Ghi chú / note. */
export type CocSheetModel = {
  ngay: string;
  thu: string;
  chi: string;
  ten: string;
  note: string;
};

export const COC_COLS = 5;

/** Cột RATE (E) trên BAO_CAO_TK: luôn ghi kiểu số để công thức MULTIPLY không nhận chuỗi. */
export function rateNumericOrEmpty(raw: string): number | "" {
  const t = (raw ?? "").trim();
  if (!t) return "";
  if (!/[\d]/.test(t)) return "";
  const n = num(t);
  return Number.isFinite(n) ? n : "";
}

/** Chuẩn hóa một dòng COC (A–E). */
export function normalizeCocDataRow(cells: unknown): string[] {
  const src = Array.isArray(cells) ? cells : [];
  const row = [...src];
  while (row.length < COC_COLS) row.push("");
  const a = row[0];
  let ngay = "";
  if (typeof a === "number" && Number.isFinite(a)) {
    ngay = sheetsSerialToIsoDate(a);
  } else {
    ngay = String(a ?? "").trim();
  }
  const th = row[1];
  const thu = typeof th === "number" && Number.isFinite(th) ? String(th) : String(th ?? "").trim();
  const ch = row[2];
  const chi = typeof ch === "number" && Number.isFinite(ch) ? String(ch) : String(ch ?? "").trim();
  let ten = String(row[3] ?? "").trim();
  let note = String(row[4] ?? "").trim();
  /** Dòng cũ 4 cột: D là “Ghi chú” — không có cột Tên. */
  if (note === "" && ten !== "") {
    note = ten;
    ten = "";
  }
  return [ngay, thu, chi, ten, note];
}

export function cocModelsFromSheetRows(dataRows: string[][]): CocSheetModel[] {
  return dataRows.map((r) => ({
    ngay: r[0] ?? "",
    thu: r[1] ?? "",
    chi: r[2] ?? "",
    ten: r[3] ?? "",
    note: r[4] ?? "",
  }));
}

/** Giữ tiêu đề + dòng có dữ liệu, nối dòng COC mới (không xóa dòng cũ). */
export function buildCocAppendedMatrix(
  existing: unknown[][],
  appended: CocSheetModel[],
): (string | number)[][] {
  const defaultHeader = ["Ngày", "Thu", "Chi", "Tên", "Ghi chú"];
  const header = existing[0]?.length
    ? stringifySheetRow(existing[0] as unknown[])
    : defaultHeader;
  while (header.length < COC_COLS) header.push("");
  const h = header.slice(0, COC_COLS).map(String);
  const body: (string | number)[][] = [];
  for (let i = 1; i < existing.length; i++) {
    const norm = normalizeCocDataRow(existing[i]);
    if (!norm.join("").trim()) continue;
    const thuS = norm[1] ?? "";
    const chiS = norm[2] ?? "";
    body.push([
      norm[0],
      thuS.trim() === "" ? "" : num(thuS),
      chiS.trim() === "" ? "" : num(chiS),
      norm[3],
      norm[4],
    ]);
  }
  for (const m of appended) {
    body.push([
      m.ngay,
      m.thu.trim() === "" ? "" : num(m.thu),
      m.chi.trim() === "" ? "" : num(m.chi),
      m.ten,
      m.note,
    ]);
  }
  return padMatrix([h, ...body], COC_COLS);
}

/** Giữ tiêu đề + dòng có dữ liệu, nối dòng THU_CHI mới (không xóa dòng cũ). */
export function buildThuChiAppendedMatrix(
  existing: unknown[][],
  appended: ThuChiSheetModel[],
): (string | number)[][] {
  const defaultHeader = ["Ngày", "Thu", "Chi", "Ghi chú"];
  const header = existing[0]?.length
    ? stringifySheetRow(existing[0] as unknown[])
    : defaultHeader;
  while (header.length < 4) header.push("");
  const h = header.slice(0, 4).map(String);
  const body: (string | number)[][] = [];
  for (let i = 1; i < existing.length; i++) {
    const row = stringifySheetRow((existing[i] as unknown[]) ?? []).slice(0, 4);
    while (row.length < 4) row.push("");
    if (!row.join("").trim()) continue;
    const thuS = row[1] ?? "";
    const chiS = row[2] ?? "";
    body.push([
      row[0],
      thuS.trim() === "" ? "" : num(thuS),
      chiS.trim() === "" ? "" : num(chiS),
      row[3],
    ]);
  }
  for (const m of appended) {
    body.push([
      m.ngay,
      m.thu.trim() === "" ? "" : num(m.thu),
      m.chi.trim() === "" ? "" : num(m.chi),
      m.ghiChu,
    ]);
  }
  return padMatrix([h, ...body], 4);
}

export function isThuChiModelEmpty(m: {
  ngay: string;
  thu: string;
  chi: string;
  ghiChu: string;
}): boolean {
  return `${m.ngay ?? ""}${m.thu ?? ""}${m.chi ?? ""}${m.ghiChu ?? ""}`.trim() === "";
}

/** Điền từng dòng mới vào dòng trống (A–D) đầu tiên từ trên xuống; không sửa dòng đã có dữ liệu. Hết chỗ trống thì nối cuối. */
export function applyThuChiNewRowsFillEmptySlots(
  existingModels: ThuChiSheetModel[],
  newRows: ThuChiSheetModel[],
): ThuChiSheetModel[] {
  const out = existingModels.map((m) => ({ ...m }));
  let u = 0;
  for (let i = 0; i < out.length && u < newRows.length; i++) {
    if (!isThuChiModelEmpty(out[i]!)) continue;
    out[i] = { ...newRows[u]! };
    u++;
  }
  while (u < newRows.length) {
    out.push({ ...newRows[u]! });
    u++;
  }
  return out;
}

/** Bỏ các dòng trống hoàn toàn ở cuối (tránh kéo công thức E xuống hàng pad không có dữ liệu). */
export function trimTrailingEmptyThuChiModels(
  rows: { ngay: string; thu: string; chi: string; ghiChu: string }[],
): { ngay: string; thu: string; chi: string; ghiChu: string }[] {
  const o = [...rows];
  while (o.length > 0 && isThuChiModelEmpty(o[o.length - 1]!)) o.pop();
  return o;
}

/** Ma trận tab THU_CHI: header + dòng dữ liệu A-D, phần pad phía dưới để trống. */
export function buildThuChiPaddedMatrix(
  rows: { ngay: string; thu: string; chi: string; ghiChu: string }[],
): (string | number)[][] {
  const header: (string | number)[] = ["Ngày", "Thu", "Chi", "Ghi chú"];
  const out: (string | number)[][] = [header];
  const trimmed = trimTrailingEmptyThuChiModels(rows);
  const dataCount = trimmed.length;
  const totalBody = Math.max(THU_CHI_PAD_ROWS - 1, Math.max(1, dataCount));

  for (let i = 0; i < totalBody; i++) {
    if (i < dataCount) {
      const model = trimmed[i]!;
      const ngay = model.ngay ?? "";
      const thu = model.thu ?? "";
      const chi = model.chi ?? "";
      const ghiChu = model.ghiChu ?? "";
      const thuCell: string | number = thu.trim() === "" ? "" : num(thu);
      const chiCell: string | number = chi.trim() === "" ? "" : num(chi);
      out.push([ngay, thuCell, chiCell, ghiChu]);
    } else if (dataCount === 0 && i === 0) {
      out.push(["", "", "", ""]);
    } else {
      out.push(["", "", "", ""]);
    }
  }
  return out;
}

/** Dòng “mới nhất”: dòng cuối cùng (từ dưới lên) có ít nhất một ô Ngày/Thu/Chi có dữ liệu. */
export function latestThuChiRow(thuChiData: string[][]): { thu: number; chi: number } {
  for (let i = thuChiData.length - 1; i >= 0; i--) {
    const r = thuChiData[i];
    const has = Boolean(
      (r[0] ?? "").trim() || (r[1] ?? "").trim() || (r[2] ?? "").trim(),
    );
    if (has) return { thu: num(r[1]), chi: num(r[2]) };
  }
  return { thu: 0, chi: 0 };
}

/** E2 biến động tổng quan: bắt đầu từ A2 rồi cộng dồn Thu - Chi theo thứ tự từ trên xuống. */
export function bienDongE2(duDau: number, thuChiData: string[][]): number {
  let x = duDau;
  for (const r of thuChiData) {
    const has = Boolean((r[0] ?? "").trim() || (r[1] ?? "").trim() || (r[2] ?? "").trim());
    if (!has) continue;
    x += num(r[1]) - num(r[2]);
  }
  return x;
}

export function sheetRowsToThuChiModels(dataRows: string[][]): {
  ngay: string;
  thu: string;
  chi: string;
  ghiChu: string;
}[] {
  return dataRows.map((r) => ({
    ngay: r[0] ?? "",
    thu: r[1] ?? "",
    chi: r[2] ?? "",
    ghiChu: r[3] ?? "",
  }));
}
