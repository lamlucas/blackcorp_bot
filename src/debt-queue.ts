import type { Env } from "./worker-lib";
import {
  getAccessTokenFromEnv,
  getDebtRowsOrdered,
  getSheetTitles,
  readTabRows,
} from "./worker-lib";
import { getDealerChatMap, resolveChatId } from "./dealer-map";
import {
  persistDebtRunStart,
  recordDebtSentError,
  recordDebtSentOk,
  type DebtNotifyRunState,
} from "./debt-notify-status";

/** Dữ liệu gửi công nợ (trước khi gắn runId cho một lần chạy cron). */
export type DebtNotifyJobBody = {
  chatId: string;
  maDl: string;
  noCuDisplay: string;
};

/** Payload trong Cloudflare Queue — đủ để gửi Telegram + đồng bộ KV trạng thái. */
export type DebtNotifyJob = DebtNotifyJobBody & { runId: string };

const QUEUE_SEND_CHUNK = 100;

/** Thu thập jobs gửi công nợ: đọc A2:B tab CONG_NO trên DEBT_SPREADSHEET_ID; mỗi cột A phải trùng (trim) tên tab đại lý trên MAIN_SPREADSHEET_ID; Chat ID = B1 tab đó hoặc KV dealer map. */
export async function collectDebtNotifyJobs(env: Env): Promise<DebtNotifyJobBody[]> {
  let token: string;
  try {
    token = await getAccessTokenFromEnv(env);
  } catch {
    return [];
  }

  const debtSpreadsheetId = env.DEBT_SPREADSHEET_ID
    ? env.DEBT_SPREADSHEET_ID
    : env.MAIN_SPREADSHEET_ID;

  let debtRows: { maDl: string; noCuDisplay: string }[];
  try {
    debtRows = await getDebtRowsOrdered(token, debtSpreadsheetId, env.DEBT_TAB_NAME);
  } catch {
    debtRows = [];
  }

  const dealerMap = await getDealerChatMap(env.STORE);
  const titles = await getSheetTitles(token, env.MAIN_SPREADSHEET_ID);
  const canonicalTitleByTrim = new Map<string, string>();
  for (const t of titles) {
    if (t === env.DEBT_TAB_NAME) continue;
    canonicalTitleByTrim.set(t.trim(), t);
  }

  const jobs: DebtNotifyJobBody[] = [];
  for (const { maDl, noCuDisplay } of debtRows) {
    const sheetTitle = canonicalTitleByTrim.get(maDl.trim());
    if (!sheetTitle) continue;

    const rows = await readTabRows(token, env.MAIN_SPREADSHEET_ID, sheetTitle);
    const chatId = resolveChatId(sheetTitle, rows.chatId, dealerMap);
    if (!chatId) continue;

    jobs.push({ chatId, maDl, noCuDisplay });
  }
  return jobs;
}

export async function flushJobsToQueue(
  queue: Queue<DebtNotifyJob>,
  jobs: DebtNotifyJob[]
): Promise<void> {
  for (let i = 0; i < jobs.length; i += QUEUE_SEND_CHUNK) {
    const slice = jobs.slice(i, i + QUEUE_SEND_CHUNK);
    await queue.sendBatch(slice.map((body) => ({ body })));
  }
}

type InlineBatchOpts = {
  batchSize?: number;
  pauseBetweenBatchesMs?: number;
};

/** Gửi trực tiếp (không Queue): `wrangler dev` hoặc chưa tạo consumer. */
export async function deliverDebtJobsInline(
  env: Env,
  jobs: DebtNotifyJob[],
  batchOpts?: InlineBatchOpts
): Promise<void> {
  const pauseBetweenTelegram = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 55));

  const batchSize = batchOpts?.batchSize;
  const pauseBetweenBatchesMs = batchOpts?.pauseBetweenBatchesMs ?? 0;
  const useBatching =
    typeof batchSize === "number" && Number.isFinite(batchSize) && batchSize > 0;

  let sentInBatch = 0;

  for (const job of jobs) {
    try {
      await deliverDebtNotifyJob(env, job);
      try {
        await recordDebtSentOk(env, job.runId, job.maDl);
      } catch {
        /* KV lỗi — không chặn các nhóm sau */
      }
    } catch (e) {
      try {
        await recordDebtSentError(
          env,
          job.runId,
          job.maDl,
          e instanceof Error ? e.message : String(e)
        );
      } catch {
        /* KV lỗi */
      }
    }
    await pauseBetweenTelegram();

    sentInBatch++;
    if (useBatching && sentInBatch >= batchSize!) {
      sentInBatch = 0;
      if (pauseBetweenBatchesMs > 0) {
        await new Promise<void>((r) => setTimeout(r, pauseBetweenBatchesMs));
      }
    }
  }
}

/** Một tin Telegram (+ QR + ghim). */
export async function deliverDebtNotifyJob(env: Env, job: DebtNotifyJob): Promise<void> {
  const { formatDebtOnlyNotify } = await import("./format");
  const { sendHtmlMessage, pinMessage, sendPhotoUrl } = await import("./telegram");

  const { chatId, maDl, noCuDisplay } = job;
  const htmlDebt = formatDebtOnlyNotify({
    maDl,
    noCu: noCuDisplay,
  });

  const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, htmlDebt);
  await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
  if (env.PAYMENT_IMAGE_URL_1) {
    await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_1);
  }
  if (env.PAYMENT_IMAGE_URL_2) {
    await sendPhotoUrl(env.TELEGRAM_BOT_TOKEN, chatId, env.PAYMENT_IMAGE_URL_2);
  }
}

/** Cron: ghi KV trạng thái → enqueue hoặc gửi inline. */
export async function runDebtNotifyProducer(env: Env): Promise<void> {
  const runId = `run-${Date.now()}`;
  const jobs = await collectDebtNotifyJobs(env);

  const emptyState: DebtNotifyRunState = {
    runId,
    mode: "none",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalQueued: 0,
    expectedMaDl: [],
    sentOk: [],
    errors: [],
    complete: true,
  };

  if (jobs.length === 0) {
    await persistDebtRunStart(env, emptyState);
    return;
  }

  const jobsWithRun: DebtNotifyJob[] = jobs.map((j) => ({ ...j, runId }));

  await persistDebtRunStart(env, {
    runId,
    mode: env.DEBT_NOTIFY_QUEUE ? "queue" : "inline",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalQueued: jobsWithRun.length,
    expectedMaDl: jobsWithRun.map((j) => j.maDl),
    sentOk: [],
    errors: [],
    complete: false,
  });

  if (env.DEBT_NOTIFY_QUEUE) {
    await flushJobsToQueue(env.DEBT_NOTIFY_QUEUE, jobsWithRun);
    return;
  }

  const bs = parseInt(env.DEBT_CRON_BATCH_SIZE ?? "6", 10);
  const pauseMs = parseInt(env.DEBT_CRON_BATCH_PAUSE_MS ?? "4000", 10);
  const batchSize = Number.isFinite(bs) && bs > 0 ? Math.min(bs, 50) : 6;
  const pauseBetweenBatchesMs =
    Number.isFinite(pauseMs) && pauseMs >= 0 ? Math.min(pauseMs, 120_000) : 4000;

  await deliverDebtJobsInline(env, jobsWithRun, {
    batchSize,
    pauseBetweenBatchesMs,
  });
}
