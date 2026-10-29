/**
 * Validation of Cloudflare Access JWTs (the `Cf-Access-Jwt-Assertion` header).
 *
 * Cloudflare Access authenticates users (SSO) and service tokens at its edge and
 * forwards a signed RS256 JWT to the origin. An origin that merely trusts the
 * proxy accepts anything that can reach its port, so this checks the signature
 * against the team's published keys, plus the issuer, audience and expiry.
 *
 * Only RS256 is accepted and keys come solely from the team's JWKS endpoint, so
 * an attacker cannot pick the algorithm or supply their own key.
 */

import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export type CloudflareAccessVerifier = (jwt: string) => Promise<boolean>;

export interface CloudflareAccessOptions {
  /** Team name or domain: `myteam`, `myteam.cloudflareaccess.com`, or its https URL. */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  audience: string;
  /** Replaces the HTTPS request for the team's signing keys (tests). */
  fetchJwks?: (url: string) => Promise<unknown>;
  /** Replaces the clock, in milliseconds since the epoch (tests). */
  now?: () => number;
}

const TEAM_SUFFIX = ".cloudflareaccess.com";
const TEAM_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** How long a loaded key set is trusted before it is refreshed. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between key downloads, so unknown `kid` values cannot hammer Cloudflare. */
const JWKS_MIN_REFRESH_MS = 30 * 1000;
/** Tolerance for an origin clock that runs behind Cloudflare's; `exp` gets none. */
const NOT_BEFORE_LEEWAY_S = 60;

export function normalizeTeamDomain(value: string): string {
  let host = value.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!host.includes(".")) host += TEAM_SUFFIX;
  if (!TEAM_HOST.test(host)) {
    throw new Error(
      `CF_ACCESS_TEAM_DOMAIN must be a Cloudflare Access team domain such as "myteam.cloudflareaccess.com" (got "${value}")`
    );
  }
  return host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function fetchJson(url: string): Promise<unknown> {
  // No redirects: the keys must come from the team domain itself.
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createCloudflareAccessVerifier(
  options: CloudflareAccessOptions
): CloudflareAccessVerifier {
  const host = normalizeTeamDomain(options.teamDomain);
  const issuer = `https://${host}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const audience = options.audience;
  if (!audience) throw new Error("CF_ACCESS_AUD must not be empty");
  const fetchJwks = options.fetchJwks ?? fetchJson;
  const now = options.now ?? Date.now;

  let keys = new Map<string, KeyObject>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | undefined;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        const document = await fetchJwks(certsUrl);
        const listed = isRecord(document) && Array.isArray(document.keys) ? document.keys : [];
        const next = new Map<string, KeyObject>();
        for (const jwk of listed) {
          if (!isRecord(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
          } catch {
            // Skip a malformed key rather than rejecting the whole set.
          }
        }
        // Keep the previous keys if the response held none, so one bad
        // download cannot lock out everyone.
        if (next.size > 0) {
          keys = next;
          loadedAt = now();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Cloudflare Access: could not load signing keys from ${certsUrl}: ${message}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    const known = keys.get(kid);
    if (known && now() - loadedAt < JWKS_TTL_MS) return known;
    if (now() - lastAttempt >= JWKS_MIN_REFRESH_MS) await refresh();
    else if (inflight) await inflight;
    // A failed refresh falls back to the previously loaded key, if any.
    return keys.get(kid);
  }

  return async (jwt) => {
    try {
      const parts = jwt.split(".");
      if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) return false;

      const header = decodeSegment(parts[0]);
      const claims = decodeSegment(parts[1]);
      if (!isRecord(header) || !isRecord(claims)) return false;
      if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

      const key = await keyFor(header.kid);
      if (!key) return false;
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      if (!verify("RSA-SHA256", signed, key, Buffer.from(parts[2], "base64url"))) return false;

      if (claims.iss !== issuer) return false;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(audience)) return false;

      const nowSeconds = now() / 1000;
      if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return false;
      if (claims.nbf !== undefined) {
        if (typeof claims.nbf !== "number" || claims.nbf - NOT_BEFORE_LEEWAY_S > nowSeconds) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
}
