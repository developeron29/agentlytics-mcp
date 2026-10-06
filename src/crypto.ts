const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(input)));
}

export function randomKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
