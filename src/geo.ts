// Country codes (ISO 3166 alpha-2, as reported by Cloudflare) and their English names.
const REGIONS = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

export function countryName(code: string): string {
  const c = code.toUpperCase();
  if (c === "XX") return "Unknown";
  if (c === "T1") return "Tor network";
  try {
    return REGIONS?.of(c) ?? c;
  } catch {
    return c;
  }
}

let byName: Map<string, string> | undefined;

// Accepts "US", "us" or "United States"; returns the stored code, or null if it can't be resolved.
export function countryCode(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (!REGIONS) return null;
  if (!byName) {
    byName = new Map();
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = countryName(code);
      if (name !== code) byName.set(name.toLowerCase(), code);
    }
    byName.set("unknown", "XX");
  }
  return byName.get(s.toLowerCase()) ?? null;
}
