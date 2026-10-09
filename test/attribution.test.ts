import { describe, expect, it } from "vitest";
import { decideAttribution, type TouchInput } from "../src/attribution.ts";
import { DAY_MS } from "../src/time.ts";

const OPEN = Date.UTC(2026, 2, 1, 12, 0, 0);
const SIGNUP = OPEN + 30 * DAY_MS; // cadastro tardio: a janela é que limita
const WINDOW_END = OPEN + 7 * DAY_MS;

function touch(clickId: string, type: "campaign" | "referral", touchedAt: number, duplicate = false): TouchInput {
  return { clickId, type, ref: `ref_${clickId}`, touchedAt, duplicate };
}

function decide(touches: TouchInput[], signedUpAt = SIGNUP, firstOpenAt: number | null = OPEN) {
  return decideAttribution({ firstOpenAt, signedUpAt, windowDays: 7, touches });
}

function outcomes(result: ReturnType<typeof decide>) {
  return Object.fromEntries(result.touches.map((t) => [t.clickId, t.outcome]));
}

describe("decideAttribution", () => {
  it("dois links: vence o último toque válido e o outro perde para o toque posterior", () => {
    const r = decide([touch("a", "campaign", OPEN), touch("b", "referral", OPEN + DAY_MS)]);
    expect(r.source).toBe("referral");
    expect(r.clickId).toBe("b");
    expect(outcomes(r)).toEqual({ a: "lost_to_later_touch", b: "winner" });
  });

  it("a ordem de chegada dos toques não muda o vencedor", () => {
    const r = decide([touch("b", "campaign", OPEN + 2 * DAY_MS), touch("a", "referral", OPEN + DAY_MS)]);
    expect(r.clickId).toBe("b");
    expect(r.source).toBe("campaign");
  });

  it("empate de horário: referral vence campaign", () => {
    const t = OPEN + DAY_MS;
    const r = decide([touch("a", "campaign", t), touch("z", "referral", t)]);
    expect(r.clickId).toBe("z");
    expect(outcomes(r)).toEqual({ a: "lost_tie_break", z: "winner" });
    expect(r.touches.find((x) => x.clickId === "a")?.reason).toMatch(/referral/);
  });

  it("empate de horário e de tipo: vence o click_id menor", () => {
    const t = OPEN + DAY_MS;
    const r = decide([touch("clk_b", "campaign", t), touch("clk_a", "campaign", t), touch("clk_c", "campaign", t)]);
    expect(r.clickId).toBe("clk_a");
    expect(outcomes(r)).toEqual({ clk_a: "winner", clk_b: "lost_tie_break", clk_c: "lost_tie_break" });
  });

  it("empate só vale entre toques do mesmo instante: o mais antigo perde para o posterior, não no desempate", () => {
    const t = OPEN + DAY_MS;
    const r = decide([touch("old", "referral", t - 1), touch("a", "campaign", t), touch("b", "campaign", t)]);
    expect(outcomes(r)).toEqual({ old: "lost_to_later_touch", a: "winner", b: "lost_tie_break" });
  });

  it("clique repetido não cria outra origem e aparece como duplicate", () => {
    const r = decide([touch("a", "campaign", OPEN + DAY_MS), touch("a", "campaign", OPEN + 2 * DAY_MS, true)]);
    expect(r.clickId).toBe("a");
    expect(r.touches.map((x) => x.outcome).sort()).toEqual(["duplicate", "winner"]);
  });

  it("toque depois do cadastro não vence e aparece como after_signup", () => {
    const signup = OPEN + 2 * DAY_MS;
    const r = decide([touch("a", "campaign", OPEN), touch("b", "referral", signup + 1)], signup);
    expect(r.clickId).toBe("a");
    expect(outcomes(r)).toEqual({ a: "winner", b: "after_signup" });
  });

  it("toque exatamente no instante do cadastro vale (limite inclusivo)", () => {
    const signup = OPEN + 2 * DAY_MS;
    const r = decide([touch("a", "campaign", signup)], signup);
    expect(outcomes(r)).toEqual({ a: "winner" });
  });

  it("janela: first_open + 7d vale; +7d + 1 ms está fora", () => {
    const dentro = decide([touch("a", "campaign", WINDOW_END)]);
    expect(outcomes(dentro)).toEqual({ a: "winner" });

    const fora = decide([touch("a", "campaign", WINDOW_END + 1)]);
    expect(outcomes(fora)).toEqual({ a: "outside_window" });
    expect(fora.source).toBe("organic");
    expect(fora.reason).toBe("all_outside_window");
  });

  it("toque no próprio first_open vale; 1 ms antes é before_first_open", () => {
    expect(outcomes(decide([touch("a", "campaign", OPEN)]))).toEqual({ a: "winner" });
    const r = decide([touch("a", "campaign", OPEN - 1)]);
    expect(outcomes(r)).toEqual({ a: "before_first_open" });
    expect(r.reason).toBe("all_before_first_open");
  });

  it("toque fora da janela perde mesmo sendo o mais recente", () => {
    const r = decide([touch("a", "campaign", OPEN + DAY_MS), touch("b", "referral", WINDOW_END + 1)]);
    expect(r.clickId).toBe("a");
    expect(outcomes(r)).toEqual({ a: "winner", b: "outside_window" });
  });

  it("toque depois do cadastro E depois da janela é after_signup (cadastro é checado primeiro)", () => {
    const signup = OPEN + DAY_MS;
    const r = decide([touch("a", "campaign", WINDOW_END + DAY_MS)], signup);
    expect(outcomes(r)).toEqual({ a: "after_signup" });
  });

  it("a janela respeita windowDays configurado", () => {
    const r = decideAttribution({
      firstOpenAt: OPEN, signedUpAt: SIGNUP, windowDays: 1,
      touches: [touch("a", "campaign", OPEN + DAY_MS + 1)],
    });
    expect(outcomes(r)).toEqual({ a: "outside_window" });
    expect(r.windowEndsAt).toBe(OPEN + DAY_MS);
  });

  it("sem toque algum: organic com reason no_touches", () => {
    const r = decide([]);
    expect(r).toMatchObject({ source: "organic", ref: null, clickId: null, reason: "no_touches" });
  });

  it("toques inválidos de motivos diferentes: organic com no_valid_touches", () => {
    const r = decide([touch("a", "campaign", OPEN - 1), touch("b", "campaign", WINDOW_END + 1)]);
    expect(r.source).toBe("organic");
    expect(r.reason).toBe("no_valid_touches");
  });

  it("dispositivo sem abertura registrada: organic com reason no_app_open", () => {
    const r = decide([], SIGNUP, null);
    expect(r).toMatchObject({ source: "organic", reason: "no_app_open", windowEndsAt: null });
  });

  it("todo toque tem reason legível, vencedor ou não", () => {
    const r = decide([touch("a", "campaign", OPEN), touch("b", "referral", OPEN + 1)]);
    for (const t of r.touches) expect(t.reason.length).toBeGreaterThan(5);
  });
});
