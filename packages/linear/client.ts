import { readAuth, refreshTokens, writeAuth, type StoredAuth } from "./oauth.ts";

/**
 * Coalesced GraphQL client.
 *
 * - A single endpoint, single Authorization header, Bearer token.
 * - 401 → single transparent refresh + one retry; subsequent failures bubble.
 * - Concurrent refreshes share one network round-trip via `refreshInFlight`.
 */
export interface OAuthClientConfig { clientId: string; clientSecret?: string }

export interface LinearClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  refreshLeewayMs?: number;
}

let refreshInFlight: Promise<StoredAuth> | undefined;
let clientConfig: OAuthClientConfig | undefined;

export function configureClient(cfg: OAuthClientConfig): void {
  clientConfig = cfg;
  // Reset any pending refresh when the configured client changes.
  refreshInFlight = undefined;
}

export class LinearClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly refreshLeewayMs: number;

  constructor(opts: LinearClientOptions = {}) {
    this.endpoint = opts.endpoint ?? "https://api.linear.app/graphql";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.refreshLeewayMs = opts.refreshLeewayMs ?? 60_000;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const auth = await this.token();
    const first = await this.request<T>(auth.access_token, query, variables);
    if (first.data !== undefined) return first.data;
    // Either an HTTP 401 or a GraphQL response carrying errors (we already
    // mapped errors into `errorBody`). One transparent refresh+retry.
    const refreshed = await this.forceRefresh();
    const second = await this.request<T>(refreshed.access_token, query, variables);
    if (second.data === undefined) {
      throw new Error(`Linear request failed: ${second.errorBody ?? "unknown error"}`);
    }
    return second.data;
  }

  private async token(): Promise<StoredAuth> {
    const existing = readAuth();
    if (!existing) throw new Error("Linear: not signed in. Run /linear-login.");
    if (!clientConfig) throw new Error("Linear: client_id is not configured. Run /linear-login.");
    if (Date.now() >= existing.expires_at - this.refreshLeewayMs) {
      return this.refreshShared();
    }
    return existing;
  }

  private async forceRefresh(): Promise<StoredAuth> {
    return this.refreshShared();
  }

  private refreshShared(): Promise<StoredAuth> {
    if (refreshInFlight) return refreshInFlight;
    const inflight = (async (): Promise<StoredAuth> => {
      const auth = readAuth();
      if (!auth) throw new Error("Linear: not signed in. Run /linear-login.");
      if (!clientConfig) throw new Error("Linear: client_id is not configured. Run /linear-login.");
      const next = await refreshTokens(auth.refresh_token || auth.access_token, clientConfig);
      // Preserve the existing client_id/secret when the new token response
      // omits them; refresh responses from public-PKCE clients won't carry a
      // refresh token unless one was previously issued.
      const merged: StoredAuth = { ...auth, ...next };
      writeAuth(merged);
      return merged;
    })();
    refreshInFlight = inflight;
    inflight.finally(() => {
      if (refreshInFlight === inflight) refreshInFlight = undefined;
    });
    return inflight;
  }

  private async request<T>(token: string, query: string, variables: Record<string, unknown>): Promise<{ status: number; data?: T; errorBody?: string }> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) {
      const body = await res.text();
      try {
        const parsed = JSON.parse(body);
        if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          return { status: 200, errorBody: parsed.errors.map((e: { message?: string }) => e.message ?? "GraphQL error").join("; ") };
        }
        return { status: 200, data: parsed.data as T };
      } catch {
        return { status: 200, errorBody: "Linear returned non-JSON body" };
      }
    }
    if (res.status === 401) return { status: 401, errorBody: "unauthorized" };
    return { status: res.status, errorBody: await res.text() };
  }
}
