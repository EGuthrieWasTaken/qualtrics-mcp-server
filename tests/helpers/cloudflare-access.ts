import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const TEAM = "myteam.cloudflareaccess.com";
export const AUD = "0123456789abcdef-test-audience";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey, publicKey, jwk };
}

export function encodeSegment(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/** Mint a Cloudflare-Access-shaped RS256 token. A claim set to undefined is omitted. */
export function mintJwt(
  key: TestKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const body = {
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: issuedAt,
    exp: issuedAt + 3600,
    email: "someone@example.com",
    ...claims,
  };
  const head = { alg: "RS256", kid: key.kid, typ: "JWT", ...header };
  const signingInput = `${encodeSegment(head)}.${encodeSegment(body)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Stands in for the team's `/cdn-cgi/access/certs` endpoint. */
export function stubJwks(initial: TestKey[]) {
  let keys = initial;
  let failing = false;
  const urls: string[] = [];
  return {
    urls,
    get calls() {
      return urls.length;
    },
    setKeys(next: TestKey[]) {
      keys = next;
    },
    setFailing(value: boolean) {
      failing = value;
    },
    fetchJwks: async (url: string): Promise<unknown> => {
      urls.push(url);
      if (failing) throw new Error("network down");
      return { keys: keys.map((key) => key.jwk) };
    },
  };
}
