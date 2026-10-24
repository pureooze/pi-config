import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Minimal OAuth helpers for Linear.
 *
 * No external deps; uses Node's built-in fetch, http, net, and crypto.
 *
 * Client-ID storage layout (mode 0o600, no secrets):
 *   $PI_CODING_AGENT_DIR/linear/config.json
 *   { "clientId": "..." }
 *
 * Token storage layout (mode 0o600):
 *   $PI_CODING_AGENT_DIR/linear/auth.json
 *   {
 *     "access_token":  "...",
 *     "refresh_token": "...",
 *     "expires_at":    1730000000000,
 *     "scope":         "...",
 *     "token_type":    "Bearer",
 *     "client_id":     "...",
 *     "client_secret": "..."
 *   }
 */
export interface StoredAuth {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  token_type: string;
  client_id: string;
  client_secret?: string;
}

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REQUIRED_SCOPES = ["read", "write", "issues:create"] as const;

/** Fixed redirect URI. Must match the Linear OAuth app configuration exactly. */
export const REDIRECT_URI = "http://localhost:3000/oauth/callback";
const REDIRECT_PORT = 3000;
const REDIRECT_PATH = "/oauth/callback";

export function authDir(): string {
  return join(getAgentDir(), "linear");
}

export function authPath(): string {
  return join(authDir(), "auth.json");
}

export function readAuth(): StoredAuth | undefined {
  const path = authPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed && typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string") {
      return parsed as StoredAuth;
    }
  } catch { /* corrupt auth: treat as missing */ }
  return undefined;
}

export function writeAuth(auth: StoredAuth): void {
  const dir = authDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = authPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function configPath(): string {
  return join(authDir(), "config.json");
}

export interface StoredConfig {
  clientId: string;
}

/** Read the persisted non-secret client ID. Malformed or missing -> undefined. */
export function readConfig(): StoredConfig | undefined {
  const path = configPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed && typeof parsed.clientId === "string" && parsed.clientId.length > 0) {
      return { clientId: parsed.clientId };
    }
  } catch { /* corrupt config: treat as missing */ }
  return undefined;
}

export function writeConfig(config: StoredConfig): void {
  const dir = authDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function clearAuth(): void {
  const path = authPath();
  if (existsSync(path)) {
    try { renameSync(path, `${path}.deleted-${process.pid}`); } catch { /* best effort */ }
  }
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret?: string;
}

/** Generate a PKCE code verifier (43–128 chars from the unreserved set) and S256 challenge. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url").slice(0, 64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Run the authorization-code + PKCE dance.
 * Spins up a one-shot HTTP server on 127.0.0.1:3000 (loopback only) that
 * serves the fixed redirect URI, opens the user's browser to the authorize
 * URL, captures the code, exchanges for tokens.
 */
export async function authorizeInteractive(cfg: OAuthClientConfig, openBrowser: (url: string) => Promise<void>): Promise<StoredAuth> {
  if (!cfg.clientId) throw new Error("Linear OAuth client_id is required");
  const redirectUri = REDIRECT_URI;
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", cfg.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", REQUIRED_SCOPES.join(","));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 404; res.end(); return;
    }
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== REDIRECT_PATH) {
      res.statusCode = 404; res.end(); return;
    }
    if (url.searchParams.get("state") !== state) {
      res.statusCode = 400; res.end("state mismatch"); rejectCode?.(new Error("OAuth state mismatch")); return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.statusCode = 400; res.end(`Linear denied the request: ${error}`); rejectCode?.(new Error(`Linear OAuth: ${error}`)); return;
    }
    const code = url.searchParams.get("code");
    if (!code) { res.statusCode = 400; res.end("missing code"); rejectCode?.(new Error("missing OAuth code")); return; }
    res.statusCode = 200; res.setHeader("Content-Type", "text/html"); res.end("<h1>Linear connected. You can close this tab.</h1>");
    resolveCode?.(code);
  });
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const listenPromise = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });

  try {
    await listenPromise;
    await openBrowser(authorizeUrl.toString());
    const code = await codePromise;
    return await exchangeCode({ code, codeVerifier: verifier, redirectUri, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
  } finally {
    server.close();
  }
}

async function exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret?: string }): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Linear token exchange failed: ${res.status}`);
  return parseTokenResponse(await res.text(), params.clientId, params.clientSecret);
}

export async function refreshTokens(refreshToken: string, cfg: OAuthClientConfig): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Linear refresh failed: ${res.status}`);
  const fresh = await parseTokenResponse(await res.text(), cfg.clientId, cfg.clientSecret);
  return { ...fresh, refresh_token: fresh.refresh_token || refreshToken };
}

async function parseTokenResponse(text: string, clientId: string, clientSecret: string | undefined): Promise<StoredAuth> {
  const json = JSON.parse(text);
  if (typeof json !== "object" || !json || typeof json.access_token !== "string") {
    throw new Error("Linear token response missing access_token");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : "",
    expires_at: Date.now() + Math.max(60_000, (expiresIn - 60) * 1000),
    scope: typeof json.scope === "string" ? json.scope : REQUIRED_SCOPES.join(","),
    token_type: typeof json.token_type === "string" ? json.token_type : "Bearer",
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
}

/**
 * Filter any sensitive auth surface out of a string before it leaves the
 * extension. Belt-and-suspenders; tokens should never appear in errors, but
 * providers occasionally quote raw response bodies.
 */
export function sanitize(text: string): string {
  return text
    .replace(/Bearer [A-Za-z0-9._\-]+/g, "Bearer <redacted>")
    .replace(/lin_api_[A-Za-z0-9]+/g, "lin_api_<redacted>")
    .replace(/access_token["']\s*:\s*["'][^"']+/g, "access_token\":\"<redacted>")
    .replace(/refresh_token["']\s*:\s*["'][^"']+/g, "refresh_token\":\"<redacted>")
    .replace(/Authorization:\s*\S+/g, "Authorization: <redacted>");
}
