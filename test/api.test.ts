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

  it("rejeita horário com componente fora da faixa (T24:00:00Z, +24:00) com 400", async () => {
    for (const opened_at of ["2026-03-01T24:00:00Z", "2026-03-01T12:00:00+24:00", "2027-02-29T12:00:00Z"]) {
      const r = await call("POST", "/app-opens", { device_id: "d1", opened_at });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/fuso explícito/);
    }
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

describe("toques recebidos depois do cadastro", () => {
  async function cadastrado() {
    await openApp("d1", OPEN, camp("c1"));
    const s = await signup("d1", "u1", OPEN + 2 * DAY_MS);
    const antes = (await audit("u1")).body;
    return { s, antes };
  }
  const tardios = async () =>
    (await audit("u1")).body.touches.filter((t: any) => t.outcome === "received_after_signup" || t.received_at);

  it("tipo (a): touched_at posterior ao cadastro é aceito (201), registrado e não conta", async () => {
    const { antes } = await cadastrado();
    now = Date.UTC(2026, 5, 2);
    const r = await touch("d1", OPEN + 3 * DAY_MS, indic("r1"));
    expect(r.status).toBe(201);
    const a = (await audit("u1")).body;
    const late = a.touches.find((t: any) => t.click_id === "r1");
    expect(late).toMatchObject({
      outcome: "received_after_signup", touched_at: at(OPEN + 3 * DAY_MS), received_at: at(now),
    });
    expect(late.reason).toMatch(/depois do cadastro/);
    expect(late.reason).not.toMatch(/offline/);
    expect(a.attribution).toEqual(antes.attribution);
  });

  it("tipo (b): touched_at anterior ao cadastro, recebido depois, tem motivo próprio e não reavalia", async () => {
    const { antes } = await cadastrado();
    now = Date.UTC(2026, 5, 3);
    const r = await touch("d1", OPEN + DAY_MS, indic("r1"));
    expect(r.status).toBe(201);
    const a = (await audit("u1")).body;
    const late = a.touches.find((t: any) => t.click_id === "r1");
    expect(late).toMatchObject({
      outcome: "received_after_signup", touched_at: at(OPEN + DAY_MS), received_at: at(now),
    });
    expect(late.reason).toMatch(/recebido depois/);
    expect(late.reason).toMatch(/não foi reavaliada/);
    expect(a.attribution).toEqual(antes.attribution);
  });

  it("decisão imutável: toque tardio mais recente e de prioridade maior não troca o vencedor", async () => {
    const { s, antes } = await cadastrado();
    await touch("d1", OPEN + 2 * DAY_MS, indic("r1")); // mesmo instante do cadastro, referral
    await touch("d1", OPEN + 5 * DAY_MS, indic("r2"));
    expect(s.body).toMatchObject({ source: "campaign", click_id: "c1" });
    const a = (await audit("u1")).body;
    expect(a.attribution).toEqual(antes.attribution);
    expect(a.window).toEqual(antes.window);
    expect(a.touches.slice(0, antes.touches.length)).toEqual(antes.touches);
    expect(a.touches).toHaveLength(antes.touches.length + 2);
    expect((await signup("d1", "u1", OPEN + 2 * DAY_MS)).body).toEqual(s.body);
  });

  it("clique repetido depois do cadastro continua deduplicado e aparece como duplicate", async () => {
    await cadastrado();
    now = Date.UTC(2026, 5, 4);
    const dupDoAntigo = await touch("d1", OPEN + 3 * DAY_MS, camp("c1"));
    expect(dupDoAntigo.status).toBe(200);
    expect(dupDoAntigo.body.duplicate).toBe(true);
    await touch("d1", OPEN + 3 * DAY_MS, indic("r1"));
    expect((await touch("d1", OPEN + 4 * DAY_MS, indic("r1"))).status).toBe(200);
    const a = (await audit("u1")).body;
    const dups = a.touches.filter((t: any) => t.outcome === "duplicate" && t.received_at);
    expect(dups.map((t: any) => t.click_id).sort()).toEqual(["c1", "r1"]);
    expect(a.touches.filter((t: any) => t.outcome === "received_after_signup")).toHaveLength(1);
    expect(a.attribution.click_id).toBe("c1");
  });

  it("abertura do app com link depois do cadastro: 200, toque registrado, first_open e decisão intactos", async () => {
    const { antes } = await cadastrado();
    now = Date.UTC(2026, 5, 5);
    const r = await openApp("d1", OPEN + 4 * DAY_MS, indic("r1"));
    expect(r.status).toBe(200);
    expect(r.body.first_open_at).toBe(at(OPEN));
    const a = (await audit("u1")).body;
    expect(a.attribution).toEqual(antes.attribution);
    expect(a.touches.find((t: any) => t.click_id === "r1")).toMatchObject({
      outcome: "received_after_signup", received_at: at(now), touched_at: at(OPEN + 4 * DAY_MS),
    });
  });

  it("os toques considerados na decisão original não ganham received_after_signup", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + 3 * DAY_MS, indic("r1")); // enviado antes, touched_at pós-cadastro
    await signup("d1", "u1", OPEN + 2 * DAY_MS);
    const a = (await audit("u1")).body;
    expect(a.touches.find((t: any) => t.click_id === "r1").outcome).toBe("after_signup");
    expect(await tardios()).toEqual([]);
  });
});

describe("clique repetido: vale o touched_at mais antigo", () => {
  const X = (ref = "verao26") => camp("x", ref);
  const eventos = [
    { id: "X5", at: OPEN + 4 * DAY_MS, link: camp("x") },
    { id: "X2", at: OPEN + 1 * DAY_MS, link: camp("x") },
    { id: "Y4", at: OPEN + 3 * DAY_MS, link: indic("y") },
  ];

  async function rodar(ordem: string[]) {
    app = createApp({ db: openDb(":memory:"), clock: () => now, windowDays: 7 });
    await openApp("d1", OPEN);
    for (const id of ordem) {
      const e = eventos.find((x) => x.id === id)!;
      await touch("d1", e.at, e.link);
    }
    await signup("d1", "u1", OPEN + 5 * DAY_MS);
    return (await audit("u1")).body;
  }

  it("as mesmas três chegadas em ordens diferentes dão o mesmo vencedor e a mesma auditoria", async () => {
    const a = await rodar(["X5", "X2", "Y4"]);
    const b = await rodar(["X2", "X5", "Y4"]);
    const c = await rodar(["Y4", "X5", "X2"]);
    for (const r of [a, b, c]) {
      expect(r.attribution).toMatchObject({ source: "referral", click_id: "y" });
      expect(r.touches.map((t: any) => [t.click_id, t.touched_at, t.outcome])).toEqual([
        ["x", at(OPEN + DAY_MS), "lost_to_later_touch"],
        ["y", at(OPEN + 3 * DAY_MS), "winner"],
        ["x", at(OPEN + 4 * DAY_MS), "duplicate"],
      ]);
    }
  });

  it("duplicado mais antigo que chega depois vira o canônico (200, duplicate false)", async () => {
    await openApp("d1", OPEN);
    expect((await touch("d1", OPEN + 4 * DAY_MS, X())).status).toBe(201);
    const r = await touch("d1", OPEN + DAY_MS, X());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ duplicate: false, replaced_canonical: true });
    const mais_novo = await touch("d1", OPEN + 6 * DAY_MS, X());
    expect(mais_novo.body).toMatchObject({ duplicate: true });
  });

  it("depois do cadastro o repetido mais antigo não troca a decisão gravada", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + 4 * DAY_MS, X());
    await signup("d1", "u1", OPEN + 5 * DAY_MS);
    const antes = (await audit("u1")).body;
    const r = await touch("d1", OPEN + DAY_MS, X());
    expect(r.body.duplicate).toBe(true);
    const depois = (await audit("u1")).body;
    expect(depois.attribution).toEqual(antes.attribution);
    expect(depois.touches.slice(0, 1)).toEqual(antes.touches);
    expect(depois.touches[1]).toMatchObject({ outcome: "duplicate", touched_at: at(OPEN + DAY_MS) });
  });

  it("repetição com type ou ref diferentes continua duplicate e o reason cita a divergência", async () => {
    await openApp("d1", OPEN);
    await touch("d1", OPEN + DAY_MS, camp("x", "verao26"));
    await touch("d1", OPEN + 2 * DAY_MS, indic("x", "ana_k3"));
    await touch("d1", OPEN + 3 * DAY_MS, camp("x", "outra"));
    await touch("d1", OPEN + 4 * DAY_MS, camp("x", "verao26")); // igual ao canônico
    await signup("d1", "u1", OPEN + 5 * DAY_MS);
    const dups = (await audit("u1")).body.touches.filter((t: any) => t.outcome === "duplicate");
    expect(dups).toHaveLength(3);
    expect(dups[0].reason).toMatch(/type\/ref divergiu/);
    expect(dups[1].reason).toMatch(/type\/ref divergiu/);
    expect(dups[2].reason).not.toMatch(/divergiu/);
  });

  it("repetição divergente depois do cadastro também cita a divergência", async () => {
    await openApp("d1", OPEN, camp("x", "verao26"));
    await signup("d1", "u1", OPEN + DAY_MS);
    await touch("d1", OPEN + 2 * DAY_MS, indic("x", "ana_k3"));
    const t = (await audit("u1")).body.touches.find((x: any) => x.outcome === "duplicate");
    expect(t.reason).toMatch(/type\/ref divergiu/);
  });
});

describe("abertura atrasada recua o first_open_at", () => {
  it("antes do cadastro: vale o menor opened_at, a janela acompanha e o toque antes inválido passa a valer", async () => {
    await openApp("d1", OPEN + DAY_MS);
    await touch("d1", OPEN, camp("c1"));          // era before_first_open
    await touch("d1", OPEN + 8 * DAY_MS, indic("r1")); // valeria na janela antiga (fim OPEN+8d)
    const r = await openApp("d1", OPEN);
    expect(r.status).toBe(200);
    expect(r.body.first_open_at).toBe(at(OPEN));
    await signup("d1", "u1", OPEN + 20 * DAY_MS);
    const a = (await audit("u1")).body;
    expect(a.window).toMatchObject({ first_open_at: at(OPEN), ends_at: at(OPEN + 7 * DAY_MS) });
    expect(a.touches.map((t: any) => [t.click_id, t.outcome])).toEqual([
      ["c1", "winner"],
      ["r1", "outside_window"],
    ]);
  });

  it("abertura posterior ao first_open_at não o avança", async () => {
    await openApp("d1", OPEN);
    const r = await openApp("d1", OPEN + DAY_MS);
    expect(r.body.first_open_at).toBe(at(OPEN));
  });

  it("depois do cadastro a decisão e a janela gravadas não mudam", async () => {
    await openApp("d1", OPEN + DAY_MS, camp("c1"));
    await signup("d1", "u1", OPEN + 2 * DAY_MS);
    const antes = (await audit("u1")).body;
    const r = await openApp("d1", OPEN);
    expect(r.body.first_open_at).toBe(at(OPEN + DAY_MS));
    const depois = (await audit("u1")).body;
    expect(depois.window).toEqual(antes.window);
    expect(depois.attribution).toEqual(antes.attribution);
  });
});

describe("repetições empatadas no mesmo touched_at (desempate total)", () => {
  type Ev = { link: string };
  const permutacoes = <T>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  async function rodarTodas(eventos: Ev[]) {
    const saidas: any[] = [];
    for (const ordem of permutacoes(eventos)) {
      app = createApp({ db: openDb(":memory:"), clock: () => now, windowDays: 7 });
      await openApp("d1", OPEN);
      for (const e of ordem) await touch("d1", OPEN + DAY_MS, e.link);
      await signup("d1", "u1", OPEN + 2 * DAY_MS);
      saidas.push((await audit("u1")).body);
    }
    return saidas;
  }
  const mesmo = (saidas: any[]) => { for (const s of saidas) expect(s).toEqual(saidas[0]); };

  it("mesmo click_id como referral/r1 e campaign/r2: vence referral em qualquer ordem", async () => {
    const saidas = await rodarTodas([{ link: indic("b", "r1") }, { link: camp("b", "r2") }]);
    mesmo(saidas);
    expect(saidas[0].attribution).toMatchObject({ source: "referral", ref: "r1", click_id: "b" });
    const dup = saidas[0].touches.find((t: any) => t.outcome === "duplicate");
    expect(dup).toMatchObject({ type: "campaign", ref: "r2" });
    expect(dup.reason).toMatch(/divergiu/);
  });

  it("mesmo type e refs diferentes: vence o ref lexicograficamente menor em qualquer ordem", async () => {
    const saidas = await rodarTodas([{ link: camp("b", "zeta") }, { link: camp("b", "alfa") }]);
    mesmo(saidas);
    expect(saidas[0].attribution).toMatchObject({ ref: "alfa" });
  });

  it("três repetições empatadas, em todas as 6 ordens, dão a mesma decisão e a mesma auditoria", async () => {
    const saidas = await rodarTodas([
      { link: camp("b", "m") }, { link: indic("b", "z") }, { link: indic("b", "k") },
    ]);
    expect(saidas).toHaveLength(6);
    mesmo(saidas);
    expect(saidas[0].attribution).toMatchObject({ source: "referral", ref: "k" });
    expect(saidas[0].touches.filter((t: any) => t.outcome === "duplicate")).toHaveLength(2);
  });
});

describe("ordem dos toques tardios na auditoria", () => {
  it("segue a ordem de recebimento, não o touched_at nem o id invertido", async () => {
    await openApp("d1", OPEN);
    await signup("d1", "u1", OPEN + DAY_MS);
    now = Date.UTC(2026, 5, 10, 1);
    await touch("d1", OPEN + 9 * DAY_MS, camp("t1"));
    now = Date.UTC(2026, 5, 10, 2);
    await touch("d1", OPEN + 5 * DAY_MS, camp("t2"));
    now = Date.UTC(2026, 5, 10, 3);
    await touch("d1", OPEN + 7 * DAY_MS, camp("t3"));
    now = Date.UTC(2026, 5, 10, 4);
    await touch("d1", OPEN + 10 * DAY_MS, camp("t1")); // repetição também entra na ordem de recebimento
    const late = (await audit("u1")).body.touches.filter((t: any) => t.received_at);
    expect(late.map((t: any) => [t.click_id, t.outcome])).toEqual([
      ["t1", "received_after_signup"], ["t2", "received_after_signup"], ["t3", "received_after_signup"], ["t1", "duplicate"],
    ]);
  });
});
