import type { Env } from "../env";
import { clearSessionCookieHeader } from "../lib/session";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const secure = new URL(context.request.url).protocol === "https:";
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": clearSessionCookieHeader(secure) },
  });
};
