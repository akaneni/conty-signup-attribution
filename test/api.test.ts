import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { DAY_MS, toIso } from "../src/time.ts";

const OPEN = Date.UTC(2026, 2, 1, 12, 0, 0);
const at = (ms: number) => toIso(ms);
const camp = (cid: string, ref = "verao26") => `https://app.conty.example/o?t=campaign&ref=${ref}&cid=${cid}`;
const indic = (cid: string, ref = "ana_k3") => `https://app.conty.example/o?t=referral&ref=${ref}&cid=${cid}`;

let app: ReturnType<typeof createApp>;
let now: number; // relógio controlado: só alimenta recorded_at

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const openApp = (device_id: string, opened_at: number, link?: string) =>
  call("POST", "/app-opens", { device_id, opened_at: at(opened_at), link });
const touch = (device_id: string, touched_at: number, link: string) =>
  call("POST", "/touches", { device_id, touched_at: at(touched_at), link });
const signup = (device_id: string, user_id: string, signed_up_at: number) =>
  call("POST", "/signups", { device_id, user_id, signed_up_at: at(signed_up_at) });
const audit = (user_id: string) => call("GET", `/signups/${user_id}/attribution`);

beforeEach(() => {
  now = Date.UTC(2026, 5, 1);
  app = createApp({ db: openDb(":memory:"), clock: () => now, windowDays: 7 });
});

describe("POST /app-opens", () => {
  it("grava a primeira abertura e o toque do link no próprio first_open", async () => {
    const r = await openApp("d1", OPEN, camp("c1"));
    expect(r.status).toBe(201);
    expect(r.body.first_open_at).toBe(at(OPEN));
    await signup("d1", "u1", OPEN + DAY_MS);
    const a = await audit("u1");
    expect(a.body.touches).toHaveLength(1);
    expect(a.body.touches[0]).toMatchObject({ click_id: "c1", touched_at: at(OPEN), outcome: "winner" });
  });

  it("repetir a abertura mantém o first_open_at original", async () => {
    await openApp("d1", OPEN);
    const r = await openApp("d1", OPEN + DAY_MS);
    expect(r.status).toBe(200);
    expect(r.body.first_open_at).toBe(at(OPEN));
  });

  it("abertura orgânica sem link é aceita", async () => {
    expect((await openApp("d1", OPEN)).status).toBe(201);
  });

  it("rejeita horário sem fuso, link malformado e corpo sem device_id com 400", async () => {
    expect((await call("POST", "/app-opens", { device_id: "d1", opened_at: "2026-03-01T12:00:00" })).status).toBe(400);
    expect((await call("POST", "/app-opens", { device_id: "d1", opened_at: at(OPEN), link: "https://x.test/o?t=zzz" })).status).toBe(400);
    expect((await call("POST", "/app-opens", { opened_at: at(OPEN) })).status).toBe(400);
  });
});

describe("POST /touches", () => {
  it("dispositivo sem abertura registrada dá 404", async () => {
    expect((await touch("fantasma", OPEN, camp("c1"))).status).toBe(404);
  });

  it("clique repetido responde 200 duplicate e não cria segunda origem", async () => {
    await openApp("d1", OPEN);
    expect((await touch("d1", OPEN + DAY_MS, camp("c1"))).status).toBe(201);
    const dup = await touch("d1", OPEN + 2 * DAY_MS, camp("c1"));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    await signup("d1", "u1", OPEN + 3 * DAY_MS);
    const a = await audit("u1");
    expect(a.body.attribution).toMatchObject({ source: "campaign", click_id: "c1" });
    expect(a.body.touches.map((t: any) => t.outcome).sort()).toEqual(["duplicate", "winner"]);
  });

  it("o mesmo click_id em dispositivos diferentes não colide", async () => {
    await openApp("d1", OPEN, camp("c1"));
    await openApp("d2", OPEN, camp("c1"));
    await signup("d1", "u1", OPEN + 1);
    await signup("d2", "u2", OPEN + 1);
    expect((await audit("u1")).body.attribution.source).toBe("campaign");
    expect((await audit("u2")).body.attribution.source).toBe("campaign");
  });

  it("depois do cadastro do dispositivo dá 409", async () => {
    await openApp("d1", OPEN);
    await signup("d1", "u1", OPEN + DAY_MS);
    expect((await touch("d1", OPEN + 2 * DAY_MS, camp("c1"))).status).toBe(409);
  });
});

describe("POST /signups e GET /signups/:user_id/attribution", () => {
  it("dois links: vence o último e o outro aparece como lost_to_later_touch", async () => {
    await openApp("d1", OPEN, camp("c1"));
    await touch("d1", OPEN + DAY_MS, indic("r1"));
    const s = await signup("d1", "u1", OPEN + 2 * DAY_MS);
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ source: "referral", ref: "ana_k3", click_id: "r1" });
    const a = await audit("u1");
    expect(a.body.touches.map((t: any) => [t.click_id, t.outcome])).toEqual([
      ["c1", "lost_to_later_touch"],
      ["r1", "winner"],
    ]);
    expect(a.body.touches.every((t: any) => typeof t.reason === "string" && t.reason.length > 0)).toBe(true);
  });

  it("empate de horário: referral vence campaign e o outro é lost_tie_break", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + DAY_MS, camp("c1"));
    await touch("d1", OPEN + DAY_MS, indic("r1"));
    await signup("d1", "u1", OPEN + 2 * DAY_MS);
    const a = await audit("u1");
    expect(a.body.attribution.click_id).toBe("r1");
    expect(a.body.touches.map((t: any) => [t.click_id, t.outcome])).toEqual([
      ["c1", "lost_tie_break"],
      ["r1", "winner"],
    ]);
  });

  it("empate de horário e de tipo: vence o click_id menor, em qualquer ordem de chegada", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + DAY_MS, camp("clk_b"));
    await touch("d1", OPEN + DAY_MS, camp("clk_a"));
    await signup("d1", "u1", OPEN + 2 * DAY_MS);
    expect((await audit("u1")).body.attribution.click_id).toBe("clk_a");
  });

  it("toque posterior ao cadastro (horário do toque) não vence e aparece como after_signup", async () => {
    await openApp("d1", OPEN, camp("c1"));
    await touch("d1", OPEN + 3 * DAY_MS, indic("r1"));
    await signup("d1", "u1", OPEN + 2 * DAY_MS);
    const a = await audit("u1");
    expect(a.body.attribution.click_id).toBe("c1");
    expect(a.body.touches.find((t: any) => t.click_id === "r1").outcome).toBe("after_signup");
  });

  it("janela: toque em first_open + 7d vence; +7d + 1 ms fica fora", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + 7 * DAY_MS, camp("dentro"));
    await signup("d1", "u1", OPEN + 20 * DAY_MS);
    expect((await audit("u1")).body.attribution).toMatchObject({ source: "campaign", click_id: "dentro" });

    await openApp("d2", OPEN);
    await touch("d2", OPEN + 7 * DAY_MS + 1, camp("fora"));
    await signup("d2", "u2", OPEN + 20 * DAY_MS);
    const a = await audit("u2");
    expect(a.body.attribution).toMatchObject({ source: "organic", reason: "all_outside_window" });
    expect(a.body.touches[0].outcome).toBe("outside_window");
  });

  it("a auditoria declara a janela usada", async () => {
    await openApp("d1", OPEN);
    await signup("d1", "u1", OPEN + DAY_MS);
    const a = await audit("u1");
    expect(a.body.window).toEqual({
      days: 7,
      first_open_at: at(OPEN),
      ends_at: at(OPEN + 7 * DAY_MS),
      valid_until: at(OPEN + DAY_MS),
    });
  });

  it("sem toque: organic com reason gravado e auditoria sem toques", async () => {
    await openApp("d1", OPEN);
    const s = await signup("d1", "u1", OPEN + DAY_MS);
    expect(s.body).toMatchObject({ source: "organic", ref: null, click_id: null, reason: "no_touches" });
    expect((await audit("u1")).body.touches).toEqual([]);
  });

  it("dispositivo nunca visto: organic com reason no_app_open, nunca dado faltando", async () => {
    const s = await signup("novo", "u1", OPEN);
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ source: "organic", reason: "no_app_open" });
  });

  it("cadastro idempotente: repetir devolve 200 e o mesmo resultado, mesmo com toque novo no ar", async () => {
    await openApp("d1", OPEN, camp("c1"));
    const first = await signup("d1", "u1", OPEN + DAY_MS);
    const again = await signup("d1", "u1", OPEN + DAY_MS);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    now += DAY_MS; // o relógio anda; a decisão não
    const a1 = await audit("u1");
    expect((await signup("d1", "u1", OPEN + DAY_MS)).body).toEqual(first.body);
    expect((await audit("u1")).body).toEqual(a1.body);
  });

  it("mesmo user_id com dados diferentes, ou dispositivo de outro usuário, dá 409", async () => {
    await openApp("d1", OPEN);
    await signup("d1", "u1", OPEN + DAY_MS);
    expect((await signup("d1", "u1", OPEN + 2 * DAY_MS)).status).toBe(409);
    expect((await signup("d2", "u1", OPEN + DAY_MS)).status).toBe(409);
    expect((await signup("d1", "u2", OPEN + DAY_MS)).status).toBe(409);
  });

  it("cadastro antes da primeira abertura dá 422", async () => {
    await openApp("d1", OPEN);
    expect((await signup("d1", "u1", OPEN - 1)).status).toBe(422);
  });

  it("horário sem fuso no cadastro dá 400; cadastro inexistente na auditoria dá 404", async () => {
    expect((await call("POST", "/signups", { device_id: "d1", user_id: "u1", signed_up_at: "2026-03-01T12:00:00" })).status).toBe(400);
    expect((await audit("nao-existe")).status).toBe(404);
  });

  it("a decisão grava recorded_at do relógio injetado", async () => {
    await openApp("d1", OPEN);
    await signup("d1", "u1", OPEN + DAY_MS);
    expect((await audit("u1")).body.recorded_at).toBe(at(now));
  });
});
