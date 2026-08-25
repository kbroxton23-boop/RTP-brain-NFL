const BASE = "https://api.balldontlie.io/nfl/v1";

function addArrayParam(url, key, values) {
  for (const value of values || []) url.searchParams.append(`${key}[]`, String(value));
}

export async function bdlFetchPage(env, path, params = {}) {
  if (!env.BDL_API_KEY) throw new Error("missing_BDL_API_KEY");
  const url = new URL(`${BASE}/${path.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) addArrayParam(url, key, value);
    else url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: env.BDL_API_KEY,
      Accept: "application/json",
      "User-Agent": "RTP-NFL-SSOT/1.0",
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`bdl_invalid_json:${response.status}`);
  }

  if (!response.ok) {
    const detail = body?.error || body?.message || response.statusText || "unknown";
    throw new Error(`bdl_http_${response.status}:${detail}`);
  }

  const data = Array.isArray(body?.data) ? body.data : [];
  const nextCursor = body?.meta?.next_cursor ?? null;
  return {
    data,
    meta: body?.meta || {},
    next_cursor: nextCursor,
    request_url: url.toString().replace(env.BDL_API_KEY || "", "[REDACTED]"),
    raw_text: text,
  };
}
