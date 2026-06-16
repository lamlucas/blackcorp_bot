import { getDealerChatMap, resolveChatIdForCustomerNameColumnD } from "./dealer-map";
import type { SheetPayQueueJob } from "./sheet-pay-queue";
import type { Env } from "./worker-lib";

const META_PREFIX = "manual_broadcast:meta:";
const CHUNK_SIZE_DEFAULT = 2;
const TELEGRAM_GAP_MS = 500;
const CHUNK_DELAY_SEC = 2;

export type ManualBroadcastInput = {
  ngay: string;
  mcc: string;
  maCampPrefix: string;
  rate: string;
  ruleLines: string[];
  selectedDealers: string[];
  workerOrigin: string;
};

type ManualBroadcastMeta = ManualBroadcastInput & {
  runId: string;
  continueToken: string;
  chunkSize: number;
  gapMs: number;
  sent: number;
  errors: string[];
};

function metaKey(runId: string): string {
  return `${META_PREFIX}${runId}`;
}

function newRunId(): string {
  return `mb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function loadMeta(env: Env, runId: string): Promise<ManualBroadcastMeta | null> {
  if (!env.STORE) return null;
  const raw = await env.STORE.get(metaKey(runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ManualBroadcastMeta;
  } catch {
    return null;
  }
}

async function saveMeta(env: Env, meta: ManualBroadcastMeta): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(metaKey(meta.runId), JSON.stringify(meta));
}

async function scheduleNextChunk(env: Env, meta: ManualBroadcastMeta, offset: number): Promise<void> {
  const job: SheetPayQueueJob = { kind: "manual-broadcast", runId: meta.runId, offset };
  if (env.SHEET_PAY_QUEUE) {
    await env.SHEET_PAY_QUEUE.send(job, { delaySeconds: CHUNK_DELAY_SEC });
    return;
  }

  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise<void>((r) => setTimeout(r, 2000 * attempt));
      }
      const res = await fetch(`${meta.workerOrigin}/api/send-manual-continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: meta.runId,
          offset,
          token: meta.continueToken,
        }),
      });
      if (res.ok || res.status === 202) return;
    } catch {
      /* retry */
    }
  }
}

/** Gửi tin hàng loạt — mỗi lô vài nhóm qua Queue (tránh Worker timeout). */
export async function startManualBroadcast(env: Env, input: ManualBroadcastInput): Promise<void> {
  if (!env.STORE) return;

  const chunkRaw = parseInt(env.MANUAL_BROADCAST_BATCH_SIZE ?? String(CHUNK_SIZE_DEFAULT), 10);
  const chunkSize =
    Number.isFinite(chunkRaw) && chunkRaw > 0 ? Math.min(chunkRaw, 10) : CHUNK_SIZE_DEFAULT;

  const runId = newRunId();
  const meta: ManualBroadcastMeta = {
    ...input,
    runId,
    continueToken: crypto.randomUUID(),
    workerOrigin: input.workerOrigin.replace(/\/$/, ""),
    chunkSize,
    gapMs: TELEGRAM_GAP_MS,
    sent: 0,
    errors: [],
  };
  await saveMeta(env, meta);

  if (env.SHEET_PAY_QUEUE) {
    await env.SHEET_PAY_QUEUE.send({ kind: "manual-broadcast", runId, offset: 0 });
    return;
  }
  await processManualBroadcastChunk(env, runId, 0);
}

export async function verifyManualBroadcastContinue(
  env: Env,
  runId: string,
  token: string,
): Promise<boolean> {
  const meta = await loadMeta(env, runId);
  return meta !== null && meta.continueToken === token;
}

export async function processManualBroadcastChunk(
  env: Env,
  runId: string,
  offset: number,
): Promise<void> {
  const meta = await loadMeta(env, runId);
  if (!meta) return;

  const { formatManualMessage } = await import("./format");
  const { sendHtmlMessage, pinMessage } = await import("./telegram");
  const dealerMap = await getDealerChatMap(env.STORE);
  const prefix = meta.maCampPrefix.trim();
  const pause = () => new Promise<void>((r) => setTimeout(r, meta.gapMs));

  const slice = meta.selectedDealers.slice(offset, offset + meta.chunkSize);
  for (const dealerName of slice) {
    const chatId = resolveChatIdForCustomerNameColumnD(dealerName, dealerMap);
    if (!chatId) {
      meta.errors.push(`${dealerName}: thiếu Chat ID`);
      continue;
    }
    const maCamp = `${prefix} - ${dealerName}`;
    const html = formatManualMessage({
      ngay: meta.ngay,
      mcc: meta.mcc,
      maCamp,
      rate: meta.rate,
      ruleLines: meta.ruleLines,
    });
    try {
      const msg = await sendHtmlMessage(env.TELEGRAM_BOT_TOKEN, chatId, html);
      meta.sent++;
      await pause();
      try {
        await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg.message_id);
      } catch {
        /* ghim lỗi — tin đã gửi */
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      meta.errors.push(`${dealerName}: ${detail.slice(0, 120)}`);
    }
    await pause();
  }

  await saveMeta(env, meta);

  const nextOffset = offset + meta.chunkSize;
  if (nextOffset < meta.selectedDealers.length) {
    await scheduleNextChunk(env, meta, nextOffset);
  }
}
