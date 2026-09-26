import type { Env } from "../types";
import { authenticate } from "../auth/apiKey";
import { findIdentity, loadConfig, type GatewayConfig, type Protocol } from "./config";
import type { Body } from "./protocol";

/** Anthropic gates non-Haiku OAuth traffic behind this Claude Code system prefix. */
export const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
export const ANTHROPIC_API = "https://api.anthropic.com";
const BASE_BETAS = "claude-code-20250219,oauth-2025-04-20";
const PASSTHROUGH = new Set(["messages/count_tokens", "complete"]);

function passthroughError(message: string, status: number): Response {
  const type = status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return Response.json({ type: "error", error: { type, message } }, { status });
}

export function oauthToken(env: Env): string {
  return env.CLAUDE_OAUTH_TOKEN?.trim() || "";
}

export function cloakEnabled(env: Env): boolean {
  return (env.CLOAK ?? "").trim().toLowerCase() !== "false";
}

/** Prefixless /v1/messages with a setup-token: Claude Code, not CF BYOK. */
export function wantsOauthMessages(env: Env, protocol: Protocol, model: string): boolean {
  return protocol === "messages" && Boolean(oauthToken(env)) && !model.includes("/");
}

export function oauthPassthroughEndpoint(endpoint: string): boolean {
  return PASSTHROUGH.has(endpoint);
}

export function mergeBetas(incoming: string | null): string {
  const parts = new Set(
    `${BASE_BETAS},${incoming || ""}`.split(",").map((s) => s.trim()).filter(Boolean)
  );
  return [...parts].join(",");
}

export function cloakSystem(body: Body): void {
  const sys = body.system;
  if (typeof sys === "string") {
    if (!sys.startsWith(CLAUDE_CODE_PREFIX)) body.system = `${CLAUDE_CODE_PREFIX}\n\n${sys}`;
    return;
  }
  if (Array.isArray(sys)) {
    const first = sys[0];
    const already = first && typeof first === "object" && typeof first.text === "string"
      && first.text.startsWith(CLAUDE_CODE_PREFIX);
    if (!already) sys.unshift({ type: "text", text: CLAUDE_CODE_PREFIX });
    return;
  }
  body.system = CLAUDE_CODE_PREFIX;
}

export function anthropicOauthHeaders(original: Request, env: Env): Headers {
  const headers = new Headers({
    authorization: `Bearer ${oauthToken(env)}`,
    "anthropic-version": original.headers.get("anthropic-version") || "2023-06-01",
    "anthropic-beta": mergeBetas(original.headers.get("anthropic-beta")),
    accept: original.headers.get("accept") || "application/json"
  });
  const ua = original.headers.get("user-agent");
  headers.set("user-agent", ua || "claude-cli/2.0 (aelios)");
  for (const [name, value] of original.headers) {
    if (name.toLowerCase().startsWith("x-stainless-")) headers.set(name, value);
  }
  return headers;
}

function anthropicUrl(endpoint: string, search: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/v1/${endpoint}`;
  return `${ANTHROPIC_API}${path}${search}`;
}

/** Extra Claude Code routes (count_tokens, complete) with no memory injection. */
export async function handleOauthPassthrough(
  request: Request,
  env: Env,
  slug: string | null,
  endpoint: string
): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return passthroughError("Unauthorized", 401);
  if (!oauthToken(env)) return passthroughError("CLAUDE_OAUTH_TOKEN secret is not configured", 503);

  let config: GatewayConfig;
  try { config = await loadConfig(env); }
  catch { return passthroughError("Gateway configuration unavailable. Apply migrations and check /admin/gateway.", 503); }
  const identity = findIdentity(config, auth, slug);
  if (!identity) {
    return passthroughError(slug
      ? `No identity "${slug}" available for this key. Configure /admin/gateway, then use https://<host>/<identity>/v1.`
      : "This key has no identity. Configure one at /admin/gateway.", 403);
  }

  const headers = anthropicOauthHeaders(request, env);
  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers, redirect: "manual", signal: request.signal };
  if (method !== "GET" && method !== "HEAD") {
    const text = await request.text();
    if (text) {
      headers.set("content-type", request.headers.get("content-type") || "application/json");
      if (cloakEnabled(env)) {
        try {
          const body = JSON.parse(text) as Body;
          cloakSystem(body);
          init.body = JSON.stringify(body);
        } catch {
          init.body = text;
        }
      } else {
        init.body = text;
      }
    }
  }

  const upstream = await fetch(anthropicUrl(endpoint, new URL(request.url).search), init);
  const out = new Headers(upstream.headers);
  out.set("cache-control", "no-store");
  out.set("x-aelios-identity", identity.slug);
  out.set("x-aelios-memory", "off");
  out.set("x-aelios-provider", "anthropic");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export async function fetchAnthropicModels(request: Request, env: Env): Promise<Response | null> {
  const token = oauthToken(env);
  if (!token) return null;
  try {
    const upstream = await fetch(`${ANTHROPIC_API}/v1/models`, {
      headers: anthropicOauthHeaders(request, env),
      signal: request.signal
    });
    if (!upstream.ok) return null;
    return upstream;
  } catch {
    return null;
  }
}
