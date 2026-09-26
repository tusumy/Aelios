import type { Env } from "../types";
import type { Protocol } from "./config";

export const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SKEW_SECONDS = 60;
const CACHE_ID = "codex";

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

type CacheRow = CodexCredentials & { exp: number };

let memory: CacheRow | null = null;

function parseAuthJson(raw: string): Partial<CodexCredentials> {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); }
  catch { return {}; }
  const tokens = (data.tokens && typeof data.tokens === "object"
    ? data.tokens as Record<string, unknown>
    : data) as Record<string, unknown>;
  return {
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    accountId: typeof tokens.account_id === "string" ? tokens.account_id
      : typeof data.account_id === "string" ? data.account_id : ""
  };
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = atob(padded);
    const data = JSON.parse(json);
    return data && typeof data === "object" ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jwtExp(token: string): number {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : 0;
}

function accountFromJwt(token: string): string {
  const payload = jwtPayload(token);
  if (!payload) return "";
  const auth = payload["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string") return id;
  }
  return typeof payload.chatgpt_account_id === "string" ? payload.chatgpt_account_id : "";
}

function stillFresh(exp: number): boolean {
  return exp - SKEW_SECONDS > Date.now() / 1000;
}

export function hasCodexOauth(env: Env): boolean {
  return Boolean(seedFromSecrets(env).refreshToken);
}

/** Prefixless /v1/responses with ChatGPT OAuth: Codex, not CF BYOK. */
export function wantsCodexOauth(env: Env, protocol: Protocol, model: string): boolean {
  return protocol === "responses" && hasCodexOauth(env) && !model.includes("/");
}

function seedFromSecrets(env: Env): Partial<CodexCredentials> {
  const authJson = typeof env.CODEX_AUTH_JSON === "string" ? env.CODEX_AUTH_JSON.trim() : "";
  const refresh = typeof env.CODEX_REFRESH_TOKEN === "string" ? env.CODEX_REFRESH_TOKEN.trim() : "";
  const account = typeof env.CODEX_ACCOUNT_ID === "string" ? env.CODEX_ACCOUNT_ID.trim() : "";
  const fromJson = parseAuthJson(authJson);
  return {
    refreshToken: refresh || fromJson.refreshToken || "",
    accountId: account || fromJson.accountId || ""
  };
}

async function ensureCacheTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS oauth_token_cache (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
}

async function loadCached(env: Env): Promise<CacheRow | null> {
  if (!env.DB) return null;
  try {
    await ensureCacheTable(env.DB);
    const row = await env.DB.prepare("SELECT payload_json FROM oauth_token_cache WHERE id = ?")
      .bind(CACHE_ID).first<{ payload_json: string }>();
    if (!row?.payload_json) return null;
    const data = JSON.parse(row.payload_json) as CacheRow;
    if (!data?.accessToken) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveCached(env: Env, row: CacheRow): Promise<void> {
  if (!env.DB) return;
  try {
    await ensureCacheTable(env.DB);
    await env.DB.prepare(`INSERT INTO oauth_token_cache (id, payload_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .bind(CACHE_ID, JSON.stringify(row), new Date().toISOString()).run();
  } catch (error) {
    console.error("codex oauth cache persist failed", error);
  }
}

async function refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex OAuth refresh failed (${response.status})`);
  }
  const data = JSON.parse(text) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("Codex OAuth refresh returned no access_token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken
  };
}

export async function getCodexCredentials(env: Env, forceRefresh = false): Promise<CodexCredentials> {
  const seed = seedFromSecrets(env);
  if (!forceRefresh && memory && stillFresh(memory.exp)) {
    return { accessToken: memory.accessToken, refreshToken: memory.refreshToken, accountId: memory.accountId };
  }
  if (!forceRefresh) {
    const cached = memory ?? await loadCached(env);
    if (cached && stillFresh(cached.exp)) {
      memory = cached;
      return { accessToken: cached.accessToken, refreshToken: cached.refreshToken, accountId: cached.accountId };
    }
    if (cached) memory = cached;
  }

  const current = memory;
  const refreshToken = current?.refreshToken || seed.refreshToken;
  if (!refreshToken) {
    throw new Error("Missing Codex OAuth: set CODEX_REFRESH_TOKEN (jq -r .tokens.refresh_token ~/.codex/auth.json after `codex login`)");
  }
  const next = await refresh(refreshToken);
  const row: CacheRow = {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    accountId: seed.accountId || accountFromJwt(next.accessToken) || current?.accountId || "",
    exp: jwtExp(next.accessToken) || Date.now() / 1000 + 3600
  };
  memory = row;
  await saveCached(env, row);
  return row;
}

/** Tests only: drop the isolate cache between cases. */
export function resetCodexOauthMemory(): void {
  memory = null;
}

export function codexOauthHeaders(original: Request, creds: CodexCredentials): Headers {
  const session = original.headers.get("session_id")
    || original.headers.get("session-id")
    || original.headers.get("x-client-request-id")
    || crypto.randomUUID();
  const headers = new Headers({
    authorization: `Bearer ${creds.accessToken}`,
    "content-type": "application/json",
    accept: original.headers.get("accept") || "text/event-stream",
    originator: original.headers.get("originator") || "codex_cli_rs",
    "openai-beta": original.headers.get("openai-beta") || "responses=experimental",
    "chatgpt-account-id": creds.accountId,
    version: original.headers.get("version") || "0.0.0-aelios",
    "user-agent": original.headers.get("user-agent") || "codex_cli_rs/aelios",
    session_id: session,
    "x-client-request-id": session
  });
  return headers;
}
