import type { TouchType } from "./link.ts";
import { DAY_MS } from "./time.ts";

export type Outcome =
  | "winner"
  | "lost_to_later_touch"
  | "lost_tie_break"
  | "outside_window"
  | "after_signup"
  | "before_first_open"
  | "duplicate";

export type OrganicReason =
  | "no_touches"
  | "all_outside_window"
  | "all_after_signup"
  | "all_before_first_open"
  | "no_valid_touches"
  | "no_app_open";

export interface TouchInput {
  clickId: string;
  type: TouchType;
  ref: string;
  touchedAt: number; // epoch ms
  duplicate: boolean; // repetição de um click_id já registrado
}

export interface TouchAudit extends TouchInput {
  outcome: Outcome;
  reason: string;
}

export interface Decision {
  source: TouchType | "organic";
  ref: string | null;
  clickId: string | null;
  reason: string;
  windowEndsAt: number | null; // first_open + janela
  validUntil: number | null; // min(signup, first_open + janela)
  touches: TouchAudit[];
}

export interface DecideInput {
  firstOpenAt: number | null;
  signedUpAt: number;
  windowDays: number;
  touches: TouchInput[];
}

// Prioridade no desempate de horário idêntico: maior vence.
const TYPE_RANK: Record<TouchType, number> = { referral: 2, campaign: 1 };

/** Motivo de um duplicado; cita se type/ref divergiram do registro canônico. */
export function duplicateReason(clickId: string, canonical: { type: string; ref: string } | undefined, t: { type: string; ref: string }): string {
  const base = `click_id ${clickId} repetido; só o registro de touched_at mais antigo conta`;
  if (canonical && (canonical.type !== t.type || canonical.ref !== t.ref)) {
    return `${base}; type/ref divergiu do canônico (${t.type}/${t.ref} em vez de ${canonical.type}/${canonical.ref})`;
  }
  return base;
}

const iso = (ms: number) => new Date(ms).toISOString();

// Ordem de preferência entre toques válidos: mais recente, depois tipo, depois click_id menor.
function compareValid(a: TouchInput, b: TouchInput): number {
  if (a.touchedAt !== b.touchedAt) return b.touchedAt - a.touchedAt;
  if (a.type !== b.type) return TYPE_RANK[b.type] - TYPE_RANK[a.type];
  return a.clickId < b.clickId ? -1 : a.clickId > b.clickId ? 1 : 0;
}

export function decideAttribution(input: DecideInput): Decision {
  const { firstOpenAt, signedUpAt, windowDays } = input;
  const ordered = [...input.touches].sort((a, b) => a.touchedAt - b.touchedAt || (a.clickId < b.clickId ? -1 : 1));

  if (firstOpenAt === null) {
    return {
      source: "organic", ref: null, clickId: null, reason: "no_app_open",
      windowEndsAt: null, validUntil: null,
      touches: ordered.map((t) => ({
        ...t, outcome: t.duplicate ? "duplicate" : "before_first_open",
        reason: t.duplicate ? "click_id repetido; só o registro de touched_at mais antigo conta" : "dispositivo sem primeira abertura registrada",
      })),
    };
  }

  const windowEndsAt = firstOpenAt + windowDays * DAY_MS;
  const validUntil = Math.min(signedUpAt, windowEndsAt);

  const audited: TouchAudit[] = ordered.map((t) => {
    if (t.duplicate) {
      const canonical = input.touches.find((c) => !c.duplicate && c.clickId === t.clickId);
      return { ...t, outcome: "duplicate", reason: duplicateReason(t.clickId, canonical, t) };
    }
    if (t.touchedAt < firstOpenAt) {
      return { ...t, outcome: "before_first_open", reason: `toque ${iso(t.touchedAt)} anterior à primeira abertura ${iso(firstOpenAt)}` };
    }
    if (t.touchedAt > signedUpAt) {
      return { ...t, outcome: "after_signup", reason: `toque ${iso(t.touchedAt)} posterior ao cadastro ${iso(signedUpAt)}` };
    }
    if (t.touchedAt > windowEndsAt) {
      return { ...t, outcome: "outside_window", reason: `toque ${iso(t.touchedAt)} depois do fim da janela de ${windowDays} dias (${iso(windowEndsAt)})` };
    }
    return { ...t, outcome: "winner", reason: "" }; // provisório; resolvido abaixo
  });

  const valid = audited.filter((t) => t.outcome === "winner").sort(compareValid);
  const winner = valid[0];

  for (const t of valid.slice(1)) {
    if (t.touchedAt < winner.touchedAt) {
      t.outcome = "lost_to_later_touch";
      t.reason = `válido, mas o toque ${winner.clickId} é mais recente (${iso(winner.touchedAt)})`;
    } else {
      t.outcome = "lost_tie_break";
      t.reason = t.type !== winner.type
        ? `mesmo horário que ${winner.clickId}; ${winner.type} vence ${t.type}`
        : `mesmo horário e tipo que ${winner.clickId}; vence o click_id menor`;
    }
  }

  if (!winner) {
    const real = audited.filter((t) => t.outcome !== "duplicate");
    return {
      source: "organic", ref: null, clickId: null, reason: organicReason(real),
      windowEndsAt, validUntil, touches: audited,
    };
  }

  winner.reason = valid.length === 1
    ? "único toque válido na janela"
    : `toque válido mais recente (${iso(winner.touchedAt)})${valid.some((t) => t !== winner && t.outcome === "lost_tie_break") ? ", após desempate" : ""}`;
  return {
    source: winner.type, ref: winner.ref, clickId: winner.clickId,
    reason: winner.reason, windowEndsAt, validUntil, touches: audited,
  };
}

function organicReason(real: TouchAudit[]): OrganicReason {
  if (real.length === 0) return "no_touches";
  const kinds = new Set(real.map((t) => t.outcome));
  if (kinds.size > 1) return "no_valid_touches";
  const only = [...kinds][0];
  if (only === "outside_window") return "all_outside_window";
  if (only === "after_signup") return "all_after_signup";
  return "all_before_first_open";
}
