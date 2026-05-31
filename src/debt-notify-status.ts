import type { Env } from "./worker-lib";

const KV_LATEST_RUN = "debt_notify:latest_run_id";
const KV_RUN_PREFIX = "debt_notify:run:";

export type DebtNotifyRunMode = "none" | "queue" | "inline";

export interface DebtNotifyRunState {
  runId: string;
  mode: DebtNotifyRunMode;
  startedAt: string;
  finishedAt: string | null;
  totalQueued: number;
  /** Thứ tự MÃ ĐL đưa vào đợt gửi (đủ tab + Chat ID) */
  expectedMaDl: string[];
  sentOk: string[];
  errors: { maDl: string; detail: string }[];
  complete: boolean;
}

export async function persistDebtRunStart(env: Env, state: DebtNotifyRunState): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(KV_LATEST_RUN, state.runId);
  await env.STORE.put(`${KV_RUN_PREFIX}${state.runId}`, JSON.stringify(state));
}

async function loadRun(env: Env, runId: string): Promise<DebtNotifyRunState | null> {
  if (!env.STORE) return null;
  const raw = await env.STORE.get(`${KV_RUN_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DebtNotifyRunState;
  } catch {
    return null;
  }
}

async function saveRun(env: Env, state: DebtNotifyRunState): Promise<void> {
  if (!env.STORE) return;
  await env.STORE.put(`${KV_RUN_PREFIX}${state.runId}`, JSON.stringify(state));
}

function markCompleteIfDone(s: DebtNotifyRunState): void {
  if (s.totalQueued <= 0) {
    s.complete = true;
    if (!s.finishedAt) s.finishedAt = new Date().toISOString();
    return;
  }
  const terminal = s.sentOk.length + s.errors.length;
  if (terminal >= s.totalQueued) {
    s.complete = true;
    if (!s.finishedAt) s.finishedAt = new Date().toISOString();
  }
}

export async function recordDebtSentOk(env: Env, runId: string, maDl: string): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.sentOk.push(maDl);
  markCompleteIfDone(s);
  await saveRun(env, s);
}

export async function recordDebtSentError(
  env: Env,
  runId: string,
  maDl: string,
  detail: string
): Promise<void> {
  const s = await loadRun(env, runId);
  if (!s || s.runId !== runId) return;
  s.errors.push({ maDl, detail: detail.slice(0, 500) });
  markCompleteIfDone(s);
  await saveRun(env, s);
}

/** Đọc lần chạy mới nhất (để hiển thị panel). */
export async function getLatestDebtNotifyRun(env: Env): Promise<DebtNotifyRunState | null> {
  if (!env.STORE) return null;
  const runId = await env.STORE.get(KV_LATEST_RUN);
  if (!runId) return null;
  return loadRun(env, runId.trim());
}
