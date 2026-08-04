// app/models/offline-token-retry.server.ts
//
// Shared helper for a Shopify library footgun that shows up at multiple
// call sites in this app (and in StocklerReferral): with
// future.expiringOfflineAccessTokens on, both the OAuth refresh-token path
// (ensureValidOfflineSession — used by authenticate.webhook() and
// unauthenticated.admin()) and the token-exchange path (TokenExchangeStrategy
// — used by authenticate.admin() here, since unstable_newEmbeddedAuthStrategy
// is on) throw a bare, bodyless `Response(undefined, { status: 500 })`
// whenever the underlying refresh/exchange call to Shopify fails for ANY
// reason other than a couple of specifically-recognized dead-token errors —
// including a one-off transient network/API blip, not just a genuinely
// revoked token.
//
// First-hand evidence this is worth retrying rather than just logging: in
// production, one shop's unauthenticated.admin() call failed with exactly
// this signature while a different shop's call succeeded moments later in
// the same sync run — a genuinely dead token wouldn't explain that; a
// one-off blip during the refresh call would.
//
// Used today by jobs.sync-all.tsx. The same primitive is meant to wrap the
// other authenticate.webhook() / unauthenticated.admin() / authenticate.admin()
// call sites across both apps as a follow-up — this file exists so that
// doesn't mean re-deriving the retry logic from scratch at each one.

export function isOfflineTokenRefreshFailure(error: unknown): error is Response {
  return (
    error instanceof Response &&
    error.status === 500 &&
    error.statusText === "Internal Server Error"
  );
}

/**
 * Retries `fn` exactly once if it throws the bare-500 refresh/exchange
 * failure described above. Any other error, or a second failure of the same
 * kind, propagates unchanged — callers keep their own handling for
 * everything else (including a second bare 500, which at that point is
 * treated as a real failure rather than assumed transient).
 */
export async function withOfflineTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isOfflineTokenRefreshFailure(error)) {
      throw error;
    }
    return await fn();
  }
}
