import type { Env } from "./worker-lib";

const KV_LATEST_RUN = "sheet_pay:latest_run_id";
const KV_RUN_PREFIX = "sheet_pay:run:";

export type SheetPayRunState = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  complete: boolean;
  /** Lỗi hiển thị panel (lệch chi tiêu, timeout, …) */
  errors: string[];
  warnings: string[];
  footersSent: string[];
  /** Số dòng chi phí trong lô */
  totalRowJobs?: number;
  rowsSent?: number;
  mode?: "chunked" | "inline";
};

export function newSheetPayRunId(): string {
  return `sp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function persistSheetPayRunStart(env: Env, state: SheetPayRunState): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(KV_LATEST_RUN, state.runId);
  await env.STORE.put(`${KV_RUN_PREFIX}${state.runId}`, JSON.stringify(state));
}

async function loadRun(env: Env, runId: string): Promise<SheetPayRunState | null> {
  if (!env.STORE) return null;
  const raw = await env.STORE.get(`${KV_RUN_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SheetPayRunState;
  } catch {
    return null;
  }
}

async function saveRun(env: Env, state: SheetPayRunState): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(`${KV_RUN_PREFIX}${state.runId}`, JSON.stringify(state));
}

export async function appendSheetPayRunError(
  env: Env,
  runId: string,
  message: string,
): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.errors.push(message.slice(0, 500));
  await saveRun(env, s);
}

export async function appendSheetPayRunWarning(
  env: Env,
  runId: string,
  message: string,
): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.warnings.push(message.slice(0, 500));
  await saveRun(env, s);
}

export async function recordSheetPayFooterSent(
  env: Env,
  runId: string,
  customerD: string,
): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.footersSent.push(customerD);
  await saveRun(env, s);
}

export async function finishSheetPayRun(
  env: Env,
  runId: string,
  opts?: { timedOut?: boolean },
): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.complete = true;
  s.finishedAt = new Date().toISOString();
  if (opts?.timedOut) {
    s.errors.push(
      "Worker timeout — bot có thể chưa gửi hết chi phí / TỔNG TIỀN + QR. Thử giảm số dòng hoặc tách lô gửi.",
    );
  }
  await saveRun(env, s);
}

export async function getSheetPayRun(env: Env, runId: string): Promise<SheetPayRunState | null> {
  return loadRun(env, runId);
}

export async function getLatestSheetPayRun(env: Env): Promise<SheetPayRunState | null> {
  if (!env.STORE) return null;
  const runId = await env.STORE.get(KV_LATEST_RUN);
  if (!runId) return null;
  return loadRun(env, runId.trim());
}
