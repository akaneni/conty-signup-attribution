import { describe, expect, it } from "vitest";
import { parseInstant } from "../src/time.ts";
import { parseLink } from "../src/link.ts";

describe("parseInstant", () => {
  it("aceita Z e deslocamento explícito e normaliza para UTC", () => {
    expect(parseInstant("2026-03-01T12:00:00Z")).toBe(Date.UTC(2026, 2, 1, 12));
    expect(parseInstant("2026-03-01T09:00:00-03:00")).toBe(Date.UTC(2026, 2, 1, 12));
    expect(parseInstant("2026-03-01T12:00:00.123Z")).toBe(Date.UTC(2026, 2, 1, 12, 0, 0, 123));
  });

  it("rejeita horário sem fuso, data inexistente e lixo", () => {
    expect(parseInstant("2026-03-01T12:00:00")).toBeNull();
    expect(parseInstant("2026-03-01")).toBeNull();
    expect(parseInstant("2026-02-31T00:00:00Z")).toBeNull();
    expect(parseInstant("ontem")).toBeNull();
    expect(parseInstant(42)).toBeNull();
  });
});

describe("parseLink", () => {
  it("lê link de campanha e de indicação", () => {
    expect(parseLink("https://app.conty.example/o?t=campaign&ref=verao26&cid=clk_01H")).toEqual({
      type: "campaign", ref: "verao26", clickId: "clk_01H",
    });
    expect(parseLink("https://app.conty.example/o?t=referral&ref=ana_k3&cid=clk_01J")).toEqual({
      type: "referral", ref: "ana_k3", clickId: "clk_01J",
    });
  });

  it("rejeita tipo desconhecido, parâmetro faltando, caminho errado e não-URL", () => {
    expect(parseLink("https://app.conty.example/o?t=outro&ref=a&cid=b")).toBeNull();
    expect(parseLink("https://app.conty.example/o?t=campaign&ref=a")).toBeNull();
    expect(parseLink("https://app.conty.example/x?t=campaign&ref=a&cid=b")).toBeNull();
    expect(parseLink("https://app.conty.example/o?t=campaign&ref=a b&cid=b")).toBeNull();
    expect(parseLink("nao é url")).toBeNull();
    expect(parseLink(null)).toBeNull();
  });
});
