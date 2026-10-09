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

describe("parseInstant: validação estrita de componentes", () => {
  it.each([
    "2026-03-01T24:00:00Z", "2026-03-01T25:00:00Z", "2026-03-01T12:60:00Z", "2026-03-01T12:00:60Z",
    "2026-13-01T12:00:00Z", "2026-00-10T12:00:00Z", "2026-03-00T12:00:00Z", "2027-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z", "2026-03-01T12:00:00+24:00", "2026-03-01T12:00:00+03:60", "2026-03-01T12:00:00-23:60",
  ])("rejeita %s", (v) => expect(parseInstant(v)).toBeNull());

  it.each([
    ["2028-02-29T12:00:00Z", Date.UTC(2028, 1, 29, 12)],
    ["2026-03-01T12:00:00-03:00", Date.UTC(2026, 2, 1, 15)],
    ["2026-03-01T12:00:00+0530", Date.UTC(2026, 2, 1, 6, 30)],
    ["2026-03-01T12:00:00+23:59", Date.UTC(2026, 1, 28, 12, 1)],
    ["2026-03-01T23:59:59.999Z", Date.UTC(2026, 2, 1, 23, 59, 59, 999)],
    ["2026-03-01T12:30Z", Date.UTC(2026, 2, 1, 12, 30)],
    ["2000-02-29T00:00:00Z", Date.UTC(2000, 1, 29)],
  ])("aceita %s", (v, ms) => expect(parseInstant(v)).toBe(ms));

  it("rejeita ano bissexto de século não divisível por 400", () => {
    expect(parseInstant("1900-02-29T00:00:00Z")).toBeNull();
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
