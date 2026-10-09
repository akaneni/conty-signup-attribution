export type TouchType = "campaign" | "referral";

export interface ParsedLink {
  type: TouchType;
  ref: string;
  clickId: string;
}

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

// Contrato: https://app.conty.example/o?t=<campaign|referral>&ref=<código>&cid=<click_id>
// O host não é verificado (sem assinatura de link; ver README).
export function parseLink(value: unknown): ParsedLink | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname !== "/o") return null;
  const t = url.searchParams.get("t");
  const ref = url.searchParams.get("ref");
  const cid = url.searchParams.get("cid");
  if (t !== "campaign" && t !== "referral") return null;
  if (!ref || !cid || !TOKEN.test(ref) || !TOKEN.test(cid)) return null;
  return { type: t, ref, clickId: cid };
}
