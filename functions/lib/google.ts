type ServiceAccount = {
  client_email: string;
  private_key: string;
};

let cachedToken: { token: string; exp: number } | null = null;

function parseSa(json: string): ServiceAccount {
  const o = JSON.parse(json) as ServiceAccount;
  if (!o.client_email || !o.private_key) throw new Error("Invalid service account JSON");
  return o;
}

/** PKCS#8 PEM → DER ArrayBuffer (Workers Web Crypto, không cần gói npm). */
function pkcs8PemToBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64urlJson(obj: object): string {
  const s = JSON.stringify(obj);
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlFromSignature(sig: ArrayBuffer): string {
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signServiceAccountJwt(sa: ServiceAccount, now: number): Promise<string> {
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const pkcs8 = pkcs8PemToBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const a = base64urlJson(header);
  const b = base64urlJson(payload);
  const unsigned = `${a}.${b}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64urlFromSignature(sig)}`;
}

export async function getSheetsAccessToken(serviceAccountJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const sa = parseSa(serviceAccountJson);
  const jwt = await signServiceAccountJwt(sa, now);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token error ${res.status}: ${t}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: now + (data.expires_in ?? 3500) };
  return data.access_token;
}

export async function sheetsBatchGet(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[],
  valueRenderOption: "UNFORMATTED_VALUE" | "FORMATTED_VALUE" = "UNFORMATTED_VALUE",
): Promise<Record<string, unknown[][]>> {
  const u = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`,
  );
  for (const r of ranges) u.searchParams.append("ranges", r);
  u.searchParams.set("valueRenderOption", valueRenderOption);
  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`batchGet ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    valueRanges?: { range?: string; values?: unknown[][] }[];
  };
  const out: Record<string, unknown[][]> = {};
  for (const vr of json.valueRanges ?? []) {
    const range = vr.range ?? "";
    const raw = range.split("!")[0] ?? "";
    const name = raw.replace(/^'+|'+$/g, "");
    out[name] = vr.values ?? [];
  }
  return out;
}

/** Mỗi range gọi riêng: một tab/sheet lỗi (thiếu quyền, sai tên) không làm hỏng các tab khác. */
export async function sheetsBatchGetMergeSafe(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[],
): Promise<Record<string, unknown[][]>> {
  const out: Record<string, unknown[][]> = {};
  await Promise.all(
    ranges.map(async (range) => {
      const raw = (range.split("!")[0] ?? "").replace(/^'+|'+$/g, "");
      if (!raw) return;
      try {
        const part = await sheetsBatchGet(accessToken, spreadsheetId, [range]);
        out[raw] = part[raw] ?? [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Sheets] ${spreadsheetId} ${range}: ${msg}`);
        out[raw] = [];
      }
    }),
  );
  return out;
}

export async function sheetsBatchUpdate(
  accessToken: string,
  spreadsheetId: string,
  data: { range: string; values: (string | number)[][] }[],
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED",
): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption,
        data: data.map((d) => ({ range: d.range, values: d.values })),
      }),
    },
  );
  if (!res.ok) throw new Error(`batchUpdate ${res.status}: ${await res.text()}`);
}

/** Chèn dòng mới cuối bảng (không ghi đè vùng cũ → giữ định dạng ô đã cài). */
export async function sheetsValuesAppend(
  accessToken: string,
  spreadsheetId: string,
  rangeA1: string,
  values: (string | number)[][],
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED",
): Promise<void> {
  const q = new URLSearchParams({
    valueInputOption,
    insertDataOption: "INSERT_ROWS",
  });
  const path = encodeURIComponent(rangeA1);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${path}:append?${q}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    },
  );
  if (!res.ok) throw new Error(`values.append ${res.status}: ${await res.text()}`);
}
