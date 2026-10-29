import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createCloudflareAccessVerifier,
  normalizeTeamDomain,
} from "../src/cloudflare-access.js";
import { AUD, TEAM, encodeSegment, makeKey, mintJwt, stubJwks } from "./helpers/cloudflare-access.js";

const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

function setup(t: test.TestContext, keys = [makeKey("kid-1")]) {
  t.mock.method(console, "error", () => undefined);
  const jwks = stubJwks(keys);
  const clock = { now: Date.now() };
  const verify = createCloudflareAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    fetchJwks: jwks.fetchJwks,
    now: () => clock.now,
  });
  return { keys, jwks, clock, verify };
}

test("accepts a validly signed token and loads keys from the team's certs URL", async (t) => {
  const { keys, jwks, verify } = setup(t);
  assert.equal(await verify(mintJwt(keys[0])), true);
  assert.equal(await verify(mintJwt(keys[0], { aud: AUD })), true, "aud may be a plain string");
  assert.equal(
    await verify(mintJwt(keys[0], { aud: ["other", AUD], email: undefined, common_name: "client-id" })),
    true,
    "service tokens carry common_name instead of email"
  );
  assert.deepEqual(jwks.urls, [CERTS_URL], "keys are fetched once and cached");
});

test("rejects the wrong audience, issuer, or time window", async (t) => {
  const { keys, verify } = setup(t);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = keys[0];

  assert.equal(await verify(mintJwt(key, { aud: ["someone-elses-app"] })), false);
  assert.equal(await verify(mintJwt(key, { aud: undefined })), false);
  assert.equal(await verify(mintJwt(key, { iss: "https://evil.cloudflareaccess.com" })), false);
  assert.equal(await verify(mintJwt(key, { iss: undefined })), false);
  assert.equal(await verify(mintJwt(key, { exp: nowSeconds - 1 })), false, "expired");
  assert.equal(await verify(mintJwt(key, { exp: undefined })), false, "a token that never expires");
  assert.equal(await verify(mintJwt(key, { exp: "9999999999" })), false, "non-numeric exp");
  assert.equal(await verify(mintJwt(key, { nbf: nowSeconds + 600 })), false, "not yet valid");
  assert.equal(await verify(mintJwt(key, { nbf: nowSeconds + 30 })), true, "small clock skew is tolerated");
});

test("rejects forged signatures and tampered claims", async (t) => {
  const { keys, verify } = setup(t);
  const attacker = makeKey("kid-1"); // same kid, different private key

  assert.equal(await verify(mintJwt(attacker)), false, "signed by someone else");

  const [header, , signature] = mintJwt(keys[0], { aud: ["someone-elses-app"] }).split(".");
  const forgedPayload = encodeSegment({
    iss: `https://${TEAM}`,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(await verify(`${header}.${forgedPayload}.${signature}`), false, "payload swapped");
});

test("rejects algorithm confusion and unsigned tokens", async (t) => {
  const { keys, verify } = setup(t);
  const claims = {
    iss: `https://${TEAM}`,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const none = `${encodeSegment({ alg: "none", kid: "kid-1" })}.${encodeSegment(claims)}.`;
  assert.equal(await verify(none), false, "alg none");

  // Classic attack: sign with HMAC, using the public key as the shared secret.
  const hmacHeader = encodeSegment({ alg: "HS256", kid: "kid-1" });
  const hmacInput = `${hmacHeader}.${encodeSegment(claims)}`;
  const publicPem = keys[0].publicKey.export({ type: "spki", format: "pem" }).toString();
  const hmac = createHmac("sha256", publicPem).update(hmacInput).digest("base64url");
  assert.equal(await verify(`${hmacInput}.${hmac}`), false, "HS256 with the public key as secret");

  assert.equal(
    await verify(mintJwt(keys[0], {}, { alg: "RS384" })),
    false,
    "only RS256 is accepted, whatever the signature"
  );
  assert.equal(await verify(mintJwt(keys[0], {}, { kid: undefined })), false, "no kid");
});

test("malformed tokens are rejected without throwing", async (t) => {
  const { verify } = setup(t);
  for (const token of [
    "",
    "abc",
    "a.b",
    "a.b.c",
    "!!.@@.##",
    "W10.W10.AAAA", // header and payload are JSON arrays
    "bnVsbA.bnVsbA.AAAA", // header and payload are JSON null
    `${encodeSegment("not json")}.${encodeSegment("not json")}.AAAA`,
  ]) {
    assert.equal(await verify(token), false, JSON.stringify(token));
  }
});

test("an unknown kid triggers at most one key refresh per cooldown, and rotation is picked up", async (t) => {
  const { jwks, clock, verify, keys } = setup(t);
  const rotated = makeKey("kid-2");

  assert.equal(await verify(mintJwt(keys[0])), true);
  assert.equal(jwks.calls, 1);

  // A key Cloudflare has not published yet must not cause a download per request.
  assert.equal(await verify(mintJwt(rotated)), false);
  assert.equal(await verify(mintJwt(rotated)), false);
  assert.equal(jwks.calls, 1, "refresh is rate-limited");

  jwks.setKeys([keys[0], rotated]);
  clock.now += 31_000;
  assert.equal(await verify(mintJwt(rotated)), true, "new key accepted after the cooldown");
  assert.equal(await verify(mintJwt(keys[0])), true, "the previous key still works");
  assert.equal(jwks.calls, 2);
});

test("concurrent first requests share a single key download", async (t) => {
  const { keys, jwks, verify } = setup(t);
  const token = mintJwt(keys[0]);
  const results = await Promise.all(Array.from({ length: 5 }, () => verify(token)));
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(jwks.calls, 1);
});

test("fails closed without keys, and keeps using cached keys if a refresh fails", async (t) => {
  const { keys, jwks, clock, verify } = setup(t);
  const token = mintJwt(keys[0], { exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 });

  jwks.setFailing(true);
  assert.equal(await verify(token), false, "no keys loaded and the download failed");
  assert.equal(jwks.calls, 1);

  jwks.setFailing(false);
  assert.equal(await verify(token), false, "still cooling down after the failure");
  assert.equal(jwks.calls, 1);

  clock.now += 31_000;
  assert.equal(await verify(token), true, "recovers once the endpoint is reachable");

  // Past the cache lifetime a failed refresh falls back to the keys already loaded.
  jwks.setFailing(true);
  clock.now += 2 * 3600 * 1000;
  assert.equal(await verify(token), true);
  assert.equal(jwks.calls, 3);
});

test("team domains are normalized and anything off cloudflareaccess.com is rejected", () => {
  assert.equal(normalizeTeamDomain("myteam"), "myteam.cloudflareaccess.com");
  assert.equal(normalizeTeamDomain(" MyTeam.cloudflareaccess.com "), "myteam.cloudflareaccess.com");
  assert.equal(normalizeTeamDomain("https://myteam.cloudflareaccess.com/"), "myteam.cloudflareaccess.com");

  for (const bad of [
    "",
    "evil.com",
    "myteam.cloudflareaccess.com.evil.com",
    "my team",
    "-bad.cloudflareaccess.com",
    "http://myteam.cloudflareaccess.com",
    "myteam.cloudflareaccess.com/path",
  ]) {
    assert.throws(() => normalizeTeamDomain(bad), /CF_ACCESS_TEAM_DOMAIN/, JSON.stringify(bad));
  }
  assert.throws(
    () => createCloudflareAccessVerifier({ teamDomain: TEAM, audience: "" }),
    /CF_ACCESS_AUD/
  );
});
