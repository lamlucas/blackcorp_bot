import type { Env } from "../env";
import { getSheetsAccessToken, sheetsBatchGet, sheetsBatchGetMergeSafe, sheetsBatchUpdate, sheetsValuesAppend } from "../lib/google";
import {
  buildCocAppendedMatrix,
  buildThuChiAppendedMatrix,
  normalizeCocDataRow,
  num,
  padMatrix,
  rateNumericOrEmpty,
  stringifySheetRow,
} from "../lib/thuChiSheet";

const SHEET_TQ = "TONG_QUAN";
const SHEET_TC = "THU_CHI";
const SHEET_COC = "COC";
const SHEET_CN = "CONG_NO";
const SHEET_BAN_DAO = "BAN_DAO";
const SHEET_BAO_CAO_TK = "BAO_CAO_TK";

const CHAT_THU_CHI_DEFAULT = "-1003727898214";
const CHAT_BAN_DAO_DEFAULT = "-5091396609";
const CHAT_BAO_CAO_DEFAULT = "-1003992397667";

function thuChiChatId(env: Env): string {
  const v = (env as { TELEGRAM_THU_CHI_CHAT_ID?: string }).TELEGRAM_THU_CHI_CHAT_ID;
  return (v && String(v).trim()) || CHAT_THU_CHI_DEFAULT;
}
function banDaoChatId(env: Env): string {
  const v = (env as { TELEGRAM_BAN_DAO_CHAT_ID?: string }).TELEGRAM_BAN_DAO_CHAT_ID;
  return (v && String(v).trim()) || CHAT_BAN_DAO_DEFAULT;
}
function baoCaoChatId(env: Env): string {
  const v = (env as { TELEGRAM_BAO_CAO_CHAT_ID?: string }).TELEGRAM_BAO_CAO_CHAT_ID;
  return (v && String(v).trim()) || CHAT_BAO_CAO_DEFAULT;
}

/** File chứa tab BAN_DAO (đơn dao). */
function spreadsheetIdBanDao(env: Env): string {
  const v = (env as { SPREADSHEET_ID_BAN_DAO?: string }).SPREADSHEET_ID_BAN_DAO?.trim();
  return v || env.SPREADSHEET_ID_DEBT_SALES;
}

/** THU: số - ghi chú / CHI: số - ghi chú */
function parseThuChiMessage(text: string): { kind: "THU" | "CHI"; amountStr: string; note: string } | null {
  const t = text.trim();
  const head = t.match(/^(THU|CHI)\s*:\s*(.+)$/i);
  if (!head) return null;
  const kind = head[1].toUpperCase() === "THU" ? "THU" : "CHI";
  const rest = head[2].trim();
  const idx = rest.search(/\s-\s/);
  if (idx === -1) return null;
  const amountStr = rest.slice(0, idx).trim();
  const note = rest.slice(idx + 3).trim();
  if (!amountStr || !note) return null;
  if (!/\d/.test(amountStr.replace(/\s/g, ""))) return null;
  if (!Number.isFinite(num(amountStr))) return null;
  return { kind, amountStr, note };
}

/** Tab COC: dòng mới — A ngày (GMT+7), B Thu, C Chi, D Tên, E Ghi chú.
 * Cú pháp mới: `CỌC - THU - 1000 - VL - THẲNG` / `CỌC - CHI - ...` (nhóm Thu chi).
 * Legacy: `CỌC:` + `THU|CHI - số - ghi chú` (D/E để trống / gộp vào note). */
type CocParsedLine = {
  kind: "THU" | "CHI";
  amountStr: string;
  ten: string;
  note: string;
};

function parseCocDashLine(line: string): CocParsedLine | null {
  const m = line.match(/^CỌC\s*-\s*(THU|CHI)\s*-\s*([\d\s.,]+)\s*-\s*(.+?)\s*-\s*(.+)$/i);
  if (!m) return null;
  const kind = m[1]!.toUpperCase() === "THU" ? "THU" : "CHI";
  const amountStr = m[2]!.trim();
  const ten = m[3]!.trim();
  const note = m[4]!.trim();
  if (!amountStr || !ten || !note || !Number.isFinite(num(amountStr))) return null;
  return { kind, amountStr, ten, note };
}

function parseCocMessage(text: string): { lines: CocParsedLine[] } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const dashParsed = lines.map(parseCocDashLine);
  if (dashParsed.every((x) => x != null)) {
    return { lines: dashParsed as CocParsedLine[] };
  }

  const pushThuChiLine = (line: string, out: CocParsedLine[]) => {
    const m = line.match(/^(THU|CHI)\s*-\s*([\d\s.,]+)\s*-\s*(.+)$/i);
    if (!m) return;
    const kind = m[1]!.toUpperCase() === "THU" ? "THU" : "CHI";
    const amountStr = m[2]!.trim();
    const note = m[3]!.trim();
    if (!amountStr || !note || !Number.isFinite(num(amountStr))) return;
    out.push({ kind, amountStr, ten: "", note });
  };

  if (lines.length === 1) {
    const m = lines[0]!.match(/^CỌC\s*:\s*(THU|CHI)\s*-\s*([\d\s.,]+)\s*-\s*(.+)$/i);
    if (!m) return null;
    const kind = m[1]!.toUpperCase() === "THU" ? "THU" : "CHI";
    const amountStr = m[2]!.trim();
    const note = m[3]!.trim();
    if (!amountStr || !note || !Number.isFinite(num(amountStr))) return null;
    return { lines: [{ kind, amountStr, ten: "", note }] };
  }

  if (!/^CỌC\s*:/i.test(lines[0]!)) return null;
  const out: CocParsedLine[] = [];

  const afterCoc = lines[0]!.replace(/^CỌC\s*:/i, "").trim();
  if (afterCoc) pushThuChiLine(afterCoc, out);

  for (let i = 1; i < lines.length; i++) {
    pushThuChiLine(lines[i]!, out);
  }
  return out.length ? { lines: out } : null;
}

/** Dòng đầu CÔNG NỢ: rồi Tên - số */
function parseCongNoMessage(text: string): { pairs: { name: string; amountStr: string }[] } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!/^CÔNG\s*NỢ\s*:/i.test(lines[0]!)) return null;
  const pairs: { name: string; amountStr: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.lastIndexOf("-");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const amountStr = line.slice(idx + 1).trim();
    if (!name || !amountStr || !Number.isFinite(num(amountStr))) continue;
    pairs.push({ name, amountStr });
  }
  return pairs.length ? { pairs } : null;
}

type BanDaoFields = {
  ten: string;
  diaChi: string;
  sdt: string;
  soLuong: string;
  gia: string;
  thanhTien: string;
};

/** Mỗi dòng dạng TÊN: …, ĐỊA CHỈ: … (nhóm Báo Đơn Dao US). */
function parseBanDaoMessage(text: string): BanDaoFields | null {
  const out: BanDaoFields = { ten: "", diaChi: "", sdt: "", soLuong: "", gia: "", thanhTien: "" };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let m = line.match(/^\s*TÊN\s*:\s*(.+)$/i);
    if (m) {
      out.ten = m[1]!.trim();
      continue;
    }
    m = line.match(/^\s*ĐỊA\s*CHỈ\s*:\s*(.+)$/i);
    if (m) {
      out.diaChi = m[1]!.trim();
      continue;
    }
    m = line.match(/^\s*SỐ\s*ĐIỆN\s*THOẠI\s*:\s*(.+)$/i);
    if (m) {
      out.sdt = m[1]!.trim();
      continue;
    }
    m = line.match(/^\s*SỐ\s*LƯỢNG\s*:\s*(.+)$/i);
    if (m) {
      out.soLuong = m[1]!.trim();
      continue;
    }
    m = line.match(/^\s*GIÁ\s*:\s*(.+)$/i);
    if (m) {
      out.gia = m[1]!.trim();
      continue;
    }
    m = line.match(/^\s*THÀNH\s*TIỀN\s*:\s*(.+)$/i);
    if (m) {
      out.thanhTien = m[1]!.trim();
      continue;
    }
  }
  const has = `${out.ten}${out.diaChi}${out.sdt}${out.soLuong}${out.gia}${out.thanhTien}`.trim();
  return has ? out : null;
}

function parseBaoCaoMessage(text: string): {
  mcc: string;
  taiKhoan: string[];
  tenPairs: { d: string; e: string }[];
} | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let mcc = "";
  const tk: string[] = [];
  const tenPairs: { d: string; e: string }[] = [];
  let phase: "none" | "mcc" | "tk" | "ten" = "none";

  for (const line of lines) {
    if (!line) continue;
    if (/^MCC\s*:/i.test(line)) {
      phase = "mcc";
      mcc = line.replace(/^MCC\s*:\s*/i, "").trim();
      continue;
    }
    if (/^TÀI\s*KHOẢN\s*:/i.test(line) || /^TAI\s*KHOAN\s*:/i.test(line)) {
      phase = "tk";
      const r = line.replace(/^TÀI\s*KHOẢN\s*:\s*/i, "").replace(/^TAI\s*KHOAN\s*:\s*/i, "").trim();
      if (r) tk.push(r);
      continue;
    }
    if (/^TÊN\s*:/i.test(line)) {
      phase = "ten";
      const r = line.replace(/^TÊN\s*:\s*/i, "").trim();
      if (r) {
        for (const part of r.split(/[,;]/)) {
          const p = part.trim();
          const m = p.match(/^(.+?)\s*-\s*([\d\s.,]+)\s*$/);
          if (m) tenPairs.push({ d: m[1]!.trim(), e: m[2]!.trim() });
        }
      }
      continue;
    }
    if (phase === "tk") tk.push(line);
    else if (phase === "ten") {
      const m = line.match(/^(.+?)\s*-\s*([\d\s.,]+)\s*$/);
      if (m) tenPairs.push({ d: m[1]!.trim(), e: m[2]!.trim() });
    }
  }
  if (!mcc && tk.length === 0 && tenPairs.length === 0) return null;
  return { mcc, taiKhoan: tk, tenPairs };
}

/** Chỉ các dòng mới gửi lên API append (không đọc/ghi lại toàn bảng — giữ % cột E, định dạng ngày cột A). */
function buildBaoCaoTkNewRowsOnly(
  mcc: string,
  taiKhoan: string[],
  tenPairs: { d: string; e: string }[],
  ngay: string,
): (string | number)[][] {
  const n = Math.max(taiKhoan.length, tenPairs.length, 1);
  const rows: (string | number)[][] = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      ngay,
      mcc,
      taiKhoan[i] ?? "",
      tenPairs[i]?.d ?? "",
      rateNumericOrEmpty(tenPairs[i]?.e ?? ""),
    ]);
  }
  return rows;
}

function formatNgayFromTelegram(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSec * 1000));
}

/** Nối dòng CÔNG NỢ mới ở cuối (không ghi đè / không merge tên). */
function appendCongNoMatrix(
  existing: unknown[][],
  pairs: { name: string; amountStr: string }[],
): (string | number)[][] {
  const header = existing[0]?.length
    ? stringifySheetRow(existing[0] as unknown[])
    : ["Tên", "Tiền nợ"];
  while (header.length < 2) header.push("");
  const h = header.slice(0, 2).map(String);
  const body: (string | number)[][] = [];
  for (let r = 1; r < existing.length; r++) {
    const row = stringifySheetRow((existing[r] as unknown[]) ?? []).slice(0, 2);
    while (row.length < 2) row.push("");
    if (!row.join("").trim()) continue;
    const n = num(row[1]);
    body.push([row[0], Number.isFinite(n) ? n : row[1]]);
  }
  for (const p of pairs) {
    body.push([p.name.trim(), num(p.amountStr)]);
  }
  return padMatrix([h, ...body], 2);
}

async function telegramSendMessage(botToken: string, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("telegram sendMessage", res.status, err);
  }
}

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
    date?: number;
  };
};

export const onRequestGet: PagesFunction<Env> = async () => {
  return new Response("Telegram webhook (POST)", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const botToken = (env as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN chưa cấu hình" });
  }

  const secret = (env as { TELEGRAM_WEBHOOK_SECRET?: string }).TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret) {
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (got !== secret) {
      return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim();
  const unix = msg?.date;

  if (chatId == null || !text || unix == null) {
    return Response.json({ ok: true, ignored: true });
  }

  const sid = String(chatId);

  if (sid === banDaoChatId(env)) {
    const fields = parseBanDaoMessage(text);
    if (!fields) {
      await telegramSendMessage(
        botToken,
        chatId,
        "Gửi đơn theo từng dòng:\nTÊN: …\nĐỊA CHỈ: …\nSỐ ĐIỆN THOẠI: …\nSỐ LƯỢNG: …\nGIÁ: …\nTHÀNH TIỀN: …",
      );
      return Response.json({ ok: true, ignored: true });
    }
    try {
      const token = await getSheetsAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const idBd = spreadsheetIdBanDao(env);
      const ngay = formatNgayFromTelegram(unix);
      const newRow: (string | number)[] = [
        ngay,
        fields.ten,
        fields.diaChi,
        fields.sdt,
        fields.soLuong.trim() === "" ? "" : num(fields.soLuong),
        fields.gia.trim() === "" ? "" : num(fields.gia),
        fields.thanhTien.trim() === "" ? "" : num(fields.thanhTien),
      ];
      await sheetsValuesAppend(token, idBd, `'${SHEET_BAN_DAO}'!A:G`, [newRow], "USER_ENTERED");
      await telegramSendMessage(botToken, chatId, "Đã thêm 1 dòng vào BAN_DAO (append — không ghi đè định dạng cũ).");
      return Response.json({ ok: true, kind: "ban_dao" });
    } catch (e) {
      const msgErr = e instanceof Error ? e.message : String(e);
      console.error("telegram ban_dao", msgErr);
      await telegramSendMessage(botToken, chatId, `Lỗi ghi BAN_DAO: ${msgErr}`);
      return Response.json({ ok: false, error: msgErr }, { status: 500 });
    }
  }

  if (sid === baoCaoChatId(env)) {
    const parsed = parseBaoCaoMessage(text);
    if (!parsed) {
      await telegramSendMessage(
        botToken,
        chatId,
        "Gửi theo khối:\nMCC: …\nTÀI KHOẢN:\n(id dòng 1)\n(id dòng 2)\nTÊN:\nTP - 57\nAKR - 57",
      );
      return Response.json({ ok: true, ignored: true });
    }
    try {
      const token = await getSheetsAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const ngay = formatNgayFromTelegram(unix);
      const addedRows = Math.max(parsed.taiKhoan.length, parsed.tenPairs.length, 1);
      const newRows = buildBaoCaoTkNewRowsOnly(parsed.mcc, parsed.taiKhoan, parsed.tenPairs, ngay);
      await sheetsValuesAppend(
        token,
        env.SPREADSHEET_ID_DEBT_SALES,
        `'${SHEET_BAO_CAO_TK}'!A:E`,
        newRows,
        "USER_ENTERED",
      );
      await telegramSendMessage(
        botToken,
        chatId,
        `Đã thêm ${addedRows} dòng vào BAO_CAO_TK (append — không ghi đè định dạng % / ngày).`,
      );
      return Response.json({ ok: true, kind: "bao_cao" });
    } catch (e) {
      const msgErr = e instanceof Error ? e.message : String(e);
      console.error("telegram bao_cao", msgErr);
      await telegramSendMessage(botToken, chatId, `Lỗi ghi BAO_CAO_TK: ${msgErr}`);
      return Response.json({ ok: false, error: msgErr }, { status: 500 });
    }
  }

  if (sid !== thuChiChatId(env)) {
    return Response.json({ ok: true, ignored: true });
  }

  const congNoBlock = parseCongNoMessage(text);
  const cocBlock = parseCocMessage(text);
  const thuChiOne = parseThuChiMessage(text);

  if (!congNoBlock && !cocBlock && !thuChiOne) {
    return Response.json({ ok: true, ignored: true });
  }

  try {
    const token = await getSheetsAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const idMain = env.SPREADSHEET_ID_MAIN;

    const batchTq = await sheetsBatchGet(token, idMain, [`'${SHEET_TQ}'!A1:E2`]);
    const batchMainTabs = await sheetsBatchGetMergeSafe(token, idMain, [
      `'${SHEET_TC}'!A1:E2000`,
      `'${SHEET_COC}'!A1:E2000`,
    ]);
    const batchDebtCn = await sheetsBatchGetMergeSafe(token, env.SPREADSHEET_ID_DEBT_SALES, [
      `'${SHEET_CN}'!A1:B2000`,
    ]);
    const tc = batchMainTabs[SHEET_TC] ?? [];
    const cocRaw = batchMainTabs[SHEET_COC] ?? [];
    const cnRaw = batchDebtCn[SHEET_CN] ?? [];
    const tq = (batchTq[SHEET_TQ] ?? []).map(stringifySheetRow);

    const a2Raw = (tq[1] ?? [])[0] ?? "0";
    const a2Num = num(String(a2Raw));

    const cocData = cocRaw.length > 1 ? cocRaw.slice(1).map(normalizeCocDataRow) : [];

    const sumFromCoc = (rows: string[][]) =>
      rows.reduce(
        (s, r) => ({ b2Chi: s.b2Chi + num(r[2]), c2Thu: s.c2Thu + num(r[1]) }),
        { b2Chi: 0, c2Thu: 0 },
      );
    /** Chỉ cập nhật A2:C2 (Dư đầu / Tổng cọc / Nhận cọc). Không ghi D2 (Tổng công nợ) hay E2 (Biến động). */
    const tqUpdateRow2ABC = (cocBodyRows: string[][]) => {
      const sumCoc = sumFromCoc(cocBodyRows);
      return [[a2Num, sumCoc.b2Chi, sumCoc.c2Thu]] as (string | number)[][];
    };

    if (congNoBlock) {
      const matrix = appendCongNoMatrix(cnRaw, congNoBlock.pairs);
      const cnBodyAfter = matrix.slice(1).map((r) => [String(r[0] ?? ""), String(r[1] ?? "")]);
      const cocRowsForSum = cocData.map((r) => [
        String(r[0] ?? ""),
        String(r[1] ?? ""),
        String(r[2] ?? ""),
        String(r[3] ?? ""),
        String(r[4] ?? ""),
      ]);
      const tqRow2 = tqUpdateRow2ABC(cocRowsForSum);
      await sheetsBatchUpdate(token, env.SPREADSHEET_ID_DEBT_SALES, [
        { range: `'${SHEET_CN}'!A1:B${matrix.length}`, values: matrix },
      ]);
      await sheetsBatchUpdate(token, idMain, [{ range: `'${SHEET_TQ}'!A2:C2`, values: tqRow2 }]);
      await telegramSendMessage(
        botToken,
        chatId,
        `Đã nối ${congNoBlock.pairs.length} dòng vào CONG_NO (file theo dõi tài khoản).`,
      );
      return Response.json({ ok: true, kind: "cong_no" });
    }

    if (cocBlock) {
      const ngayOnly = formatNgayFromTelegram(unix);
      const newCocRows = cocBlock.lines.map((line) => ({
        ngay: ngayOnly,
        thu: line.kind === "THU" ? String(num(line.amountStr)) : "",
        chi: line.kind === "CHI" ? String(num(line.amountStr)) : "",
        ten: line.ten,
        note: line.note,
      }));
      const cocMatrix = buildCocAppendedMatrix(cocRaw, newCocRows);
      const cocRowsForSum = cocMatrix.slice(1).map((row) => row.map((c) => String(c ?? "")));
      const tqRow2 = tqUpdateRow2ABC(cocRowsForSum);
      await sheetsBatchUpdate(token, idMain, [
        { range: `'${SHEET_COC}'!A1:E${cocMatrix.length}`, values: cocMatrix },
      ]);
      await sheetsBatchUpdate(token, idMain, [{ range: `'${SHEET_TQ}'!A2:C2`, values: tqRow2 }]);
      await telegramSendMessage(
        botToken,
        chatId,
        `Đã ghi CỌC (${cocBlock.lines.length} dòng) — nối cuối tab COC (MAIN), ngày GMT+7.`,
      );
      return Response.json({ ok: true, kind: "coc" });
    }

    if (thuChiOne) {
      const ngay = formatNgayFromTelegram(unix);
      const amount = String(num(thuChiOne.amountStr));
      const thu = thuChiOne.kind === "THU" ? amount : "";
      const chi = thuChiOne.kind === "CHI" ? amount : "";
      const thuChiMatrix = buildThuChiAppendedMatrix(tc, [
        { ngay, thu, chi, ghiChu: thuChiOne.note },
      ]);
      const cocRowsForSum = cocData.map((r) => [
        String(r[0] ?? ""),
        String(r[1] ?? ""),
        String(r[2] ?? ""),
        String(r[3] ?? ""),
        String(r[4] ?? ""),
      ]);
      const tqRow2 = tqUpdateRow2ABC(cocRowsForSum);
      await sheetsBatchUpdate(token, idMain, [
        { range: `'${SHEET_TC}'!A1:D${thuChiMatrix.length}`, values: thuChiMatrix },
      ]);
      await sheetsBatchUpdate(token, idMain, [{ range: `'${SHEET_TQ}'!A2:C2`, values: tqRow2 }]);
      const label = thuChiOne.kind === "THU" ? "Thu" : "Chi";
      await telegramSendMessage(
        botToken,
        chatId,
        `Đã ghi ${label} ${amount} — ${thuChiOne.note} (ngày ${ngay}); nối cuối THU_CHI.`,
      );
      return Response.json({ ok: true, kind: "thu_chi" });
    }

    return Response.json({ ok: true, ignored: true });
  } catch (e) {
    const msgErr = e instanceof Error ? e.message : String(e);
    console.error("telegram-webhook sheet error", msgErr);
    await telegramSendMessage(botToken, chatId, `Lỗi ghi Sheet: ${msgErr}`);
    return Response.json({ ok: false, error: msgErr }, { status: 500 });
  }
};
