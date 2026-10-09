import { Hono } from "hono";
import { decideAttribution, type Decision, type TouchInput } from "./attribution.ts";
import {
  getFirstOpen, getSignup, getSignupByDevice, insertDevice, insertSignup, listTouches, recordTouch,
  type Db, type StoredTouch,
} from "./db.ts";
import { parseLink, type ParsedLink } from "./link.ts";
import { parseInstant, toIso } from "./time.ts";

export interface AppDeps {
  db: Db;
  clock: () => number; // epoch ms; só carimba recorded_at, nunca entra na regra
  windowDays: number;
}

class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, message: string) {
    super(message);
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, `Campo '${key}' é obrigatório (texto).`);
  return v;
}

function instant(body: Record<string, unknown>, key: string): number {
  const ms = parseInstant(body[key]);
  if (ms === null) throw new HttpError(400, `Campo '${key}' deve ser data/hora ISO 8601 com fuso explícito (ex.: 2026-03-01T12:00:00Z).`);
  return ms;
}

function optionalLink(body: Record<string, unknown>, required: boolean): ParsedLink | null {
  if (body.link === undefined || body.link === null) {
    if (required) throw new HttpError(400, "Campo 'link' é obrigatório.");
    return null;
  }
  const link = parseLink(body.link);
  if (!link) throw new HttpError(400, "Link inválido. Formato: https://app.conty.example/o?t=<campaign|referral>&ref=<código>&cid=<click_id>.");
  return link;
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Corpo da requisição deve ser um JSON válido.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Corpo da requisição deve ser um objeto JSON.");
  return body as Record<string, unknown>;
}

const storedTouch = (l: ParsedLink, touchedAt: number): StoredTouch => ({
  clickId: l.clickId, type: l.type, ref: l.ref, touchedAt: toIso(touchedAt),
});

function summary(row: { user_id: string; device_id: string; signed_up_at: string; source: string; ref: string | null; click_id: string | null; reason: string }) {
  return {
    user_id: row.user_id, device_id: row.device_id, signed_up_at: row.signed_up_at,
    source: row.source, ref: row.ref, click_id: row.click_id, reason: row.reason,
  };
}

function auditTouches(d: Decision) {
  return d.touches.map((t) => ({
    click_id: t.clickId, type: t.type, ref: t.ref, touched_at: toIso(t.touchedAt),
    outcome: t.outcome, reason: t.reason,
  }));
}

export function createApp({ db, clock, windowDays }: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: "Erro interno." }, 500);
  });

  app.post("/app-opens", async (c) => {
    const body = await readBody(c);
    const deviceId = str(body, "device_id");
    const openedAt = instant(body, "opened_at");
    const link = optionalLink(body, false);
    const existing = getFirstOpen(db, deviceId);
    if (link && getSignupByDevice(db, deviceId)) throw new HttpError(409, "Dispositivo já tem cadastro; a origem não muda mais.");
    if (existing === null) insertDevice(db, deviceId, toIso(openedAt));
    // O clique que abriu o app vale como toque no horário da abertura.
    if (link) recordTouch(db, deviceId, storedTouch(link, openedAt));
    return c.json({ device_id: deviceId, first_open_at: existing ?? toIso(openedAt) }, existing === null ? 201 : 200);
  });

  app.post("/touches", async (c) => {
    const body = await readBody(c);
    const deviceId = str(body, "device_id");
    const touchedAt = instant(body, "touched_at");
    const link = optionalLink(body, true)!;
    if (getFirstOpen(db, deviceId) === null) throw new HttpError(404, "Dispositivo sem primeira abertura registrada.");
    if (getSignupByDevice(db, deviceId)) throw new HttpError(409, "Dispositivo já tem cadastro; a origem não muda mais.");
    const isNew = recordTouch(db, deviceId, storedTouch(link, touchedAt));
    return c.json({ device_id: deviceId, click_id: link.clickId, duplicate: !isNew }, isNew ? 201 : 200);
  });

  app.post("/signups", async (c) => {
    const body = await readBody(c);
    const deviceId = str(body, "device_id");
    const userId = str(body, "user_id");
    const signedUpAt = instant(body, "signed_up_at");

    const byUser = getSignup(db, userId);
    if (byUser) {
      if (byUser.device_id !== deviceId || byUser.signed_up_at !== toIso(signedUpAt)) {
        throw new HttpError(409, "Cadastro já existe para este user_id com outros dados.");
      }
      return c.json(summary(byUser), 200);
    }
    if (getSignupByDevice(db, deviceId)) throw new HttpError(409, "Este dispositivo já foi usado no cadastro de outro usuário.");

    const firstOpen = getFirstOpen(db, deviceId);
    const firstOpenAt = firstOpen === null ? null : Date.parse(firstOpen);
    if (firstOpenAt !== null && signedUpAt < firstOpenAt) {
      throw new HttpError(422, "Cadastro anterior à primeira abertura do app.");
    }

    const { canonical, duplicates } = listTouches(db, deviceId);
    const toInput = (t: StoredTouch, duplicate: boolean): TouchInput => ({
      clickId: t.clickId, type: t.type, ref: t.ref, touchedAt: Date.parse(t.touchedAt), duplicate,
    });
    const decision = decideAttribution({
      firstOpenAt, signedUpAt, windowDays,
      touches: [...canonical.map((t) => toInput(t, false)), ...duplicates.map((t) => toInput(t, true))],
    });

    const audit = {
      window: {
        days: windowDays,
        first_open_at: firstOpen,
        ends_at: decision.windowEndsAt === null ? null : toIso(decision.windowEndsAt),
        valid_until: decision.validUntil === null ? null : toIso(decision.validUntil),
      },
      touches: auditTouches(decision),
    };
    const row = {
      user_id: userId, device_id: deviceId, signed_up_at: toIso(signedUpAt), recorded_at: toIso(clock()),
      source: decision.source, ref: decision.ref, click_id: decision.clickId, reason: decision.reason,
      audit_json: JSON.stringify(audit),
    };
    insertSignup(db, row);
    return c.json(summary(row), 201);
  });

  app.get("/signups/:user_id/attribution", (c) => {
    const row = getSignup(db, c.req.param("user_id"));
    if (!row) throw new HttpError(404, "Cadastro não encontrado.");
    const audit = JSON.parse(row.audit_json) as { window: unknown; touches: unknown };
    return c.json({
      user_id: row.user_id, device_id: row.device_id, signed_up_at: row.signed_up_at, recorded_at: row.recorded_at,
      attribution: { source: row.source, ref: row.ref, click_id: row.click_id, reason: row.reason },
      window: audit.window,
      touches: audit.touches,
    });
  });

  return app;
}
