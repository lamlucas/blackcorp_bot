import { SignJWT, importPKCS8 } from "jose";

export type ServiceAccountJson = {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
};

export async function getSheetsAccessToken(sa: ServiceAccountJson): Promise<string> {
  const key = await importPKCS8(sa.private_key, "RS256");
  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/spreadsheets",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || "Không lấy được access_token Google");
  }
  return data.access_token;
}

export async function sheetsGet<T>(
  accessToken: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets API ${res.status}: ${errText}`);
  }
  return res.json() as Promise<T>;
}

/** Ghi một vùng (vd H2). Service account cần quyền Editor trên spreadsheet. */
/** Nối dòng cuối bảng (INSERT_ROWS) — giữ định dạng ngày/số đã cài trên Sheet. */
export async function sheetsValuesAppend(
  accessToken: string,
  spreadsheetId: string,
  rangeA1: string,
  values: (string | number)[][],
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED"
): Promise<void> {
  const encoded = encodeURIComponent(rangeA1);
  const q = new URLSearchParams({
    valueInputOption,
    insertDataOption: "INSERT_ROWS",
  });
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}:append?${q}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets APPEND ${res.status}: ${errText}`);
  }
}

export async function sheetsPutValues(
  accessToken: string,
  spreadsheetId: string,
  rangeA1: string,
  values: (string | number)[][],
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED"
): Promise<void> {
  const encoded = encodeURIComponent(rangeA1);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}?valueInputOption=${valueInputOption}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets PUT ${res.status}: ${errText}`);
  }
}

export async function sheetsValuesClear(
  accessToken: string,
  spreadsheetId: string,
  rangeA1: string
): Promise<void> {
  const encoded = encodeURIComponent(rangeA1);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}:clear`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets CLEAR ${res.status}: ${errText}`);
  }
}

export async function sheetsBatchUpdate(
  accessToken: string,
  spreadsheetId: string,
  requests: unknown[]
): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets batchUpdate ${res.status}: ${errText}`);
  }
}

export type SheetGrid = {
  sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
};

export type ValueRange = { range?: string; values?: string[][] };

export type BatchGetResponse = { valueRanges?: ValueRange[] };

export function parseServiceAccountJson(raw: string): ServiceAccountJson {
  const sa = JSON.parse(raw) as ServiceAccountJson;
  if (!sa.private_key || !sa.client_email) {
    throw new Error("JSON service account không hợp lệ");
  }
  return sa;
}
