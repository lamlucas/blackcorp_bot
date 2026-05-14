import type { Env } from "../env";
import { verifySession } from "../lib/session";

function timingSafeEqual(a: string, b: string | undefined): boolean {
  if (typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const user = await verifySession(env, request.headers.get("Cookie"));
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { password?: string };
  try {
    body = (await request.json()) as { password?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const p = body.password ?? "";
  if (!p) return Response.json({ error: "Thiếu mật khẩu" }, { status: 400 });
  if (!env.BALANCE_REVEAL_PASSWORD) {
    return Response.json(
      { error: "Cấu hình server thiếu BALANCE_REVEAL_PASSWORD (Secret trên Cloudflare Pages)." },
      { status: 503 },
    );
  }
  if (!timingSafeEqual(p, env.BALANCE_REVEAL_PASSWORD)) {
    return Response.json({ error: "Sai mật khẩu" }, { status: 401 });
  }

  return Response.json({ ok: true });
};

