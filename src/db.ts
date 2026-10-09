import { DatabaseSync } from "node:sqlite";
import type { TouchType } from "./link.ts";

export type Db = DatabaseSync;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      first_open_at TEXT NOT NULL
    );
    -- Um registro por (dispositivo, click_id): o primeiro a chegar é o canônico.
    CREATE TABLE IF NOT EXISTS touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      click_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref TEXT NOT NULL,
      touched_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT '',
      late INTEGER NOT NULL DEFAULT 0, -- 1 = recebido depois do cadastro
      UNIQUE (device_id, click_id)
    );
    -- Repetições do mesmo click_id: guardadas só para a auditoria mostrar "duplicate".
    CREATE TABLE IF NOT EXISTS duplicate_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      click_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref TEXT NOT NULL,
      touched_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT '',
      late INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS signups (
      user_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      signed_up_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL,
      ref TEXT,
      click_id TEXT,
      reason TEXT NOT NULL,
      audit_json TEXT NOT NULL
    );
  `);
  // Bancos criados antes do campo received_at/late.
  for (const table of ["touches", "duplicate_touches"]) {
    for (const col of ["received_at TEXT NOT NULL DEFAULT ''", "late INTEGER NOT NULL DEFAULT 0"]) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* já existe */ }
    }
  }
  return db;
}

export interface StoredTouch {
  clickId: string;
  type: TouchType;
  ref: string;
  touchedAt: string;
}

export interface StoredSignup {
  user_id: string;
  device_id: string;
  signed_up_at: string;
  recorded_at: string;
  source: string;
  ref: string | null;
  click_id: string | null;
  reason: string;
  audit_json: string;
}

export function getFirstOpen(db: Db, deviceId: string): string | null {
  const row = db.prepare("SELECT first_open_at FROM devices WHERE device_id = ?").get(deviceId) as { first_open_at: string } | undefined;
  return row?.first_open_at ?? null;
}

export function insertDevice(db: Db, deviceId: string, firstOpenAt: string): void {
  db.prepare("INSERT INTO devices (device_id, first_open_at) VALUES (?, ?)").run(deviceId, firstOpenAt);
}

/**
 * Devolve true se o toque é novo, false se o click_id já existia (guardado como duplicado).
 * `late` marca toque recebido depois do cadastro do dispositivo (não entra na decisão).
 */
export function recordTouch(db: Db, deviceId: string, t: StoredTouch, receivedAt: string, late: boolean): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO touches (device_id, click_id, type, ref, touched_at, received_at, late) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(deviceId, t.clickId, t.type, t.ref, t.touchedAt, receivedAt, late ? 1 : 0);
  if (Number(res.changes) === 1) return true;
  db.prepare("INSERT INTO duplicate_touches (device_id, click_id, type, ref, touched_at, received_at, late) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(deviceId, t.clickId, t.type, t.ref, t.touchedAt, receivedAt, late ? 1 : 0);
  return false;
}

export interface LateTouch extends StoredTouch {
  receivedAt: string;
  duplicate: boolean;
}

interface TouchRow { click_id: string; type: TouchType; ref: string; touched_at: string; received_at: string }
const toStored = (r: TouchRow): StoredTouch => ({ clickId: r.click_id, type: r.type, ref: r.ref, touchedAt: r.touched_at });

/** Toques usados na decisão: só os recebidos antes do cadastro. */
export function listTouches(db: Db, deviceId: string): { canonical: StoredTouch[]; duplicates: StoredTouch[] } {
  const q = (t: string) => db.prepare(`SELECT click_id, type, ref, touched_at, received_at FROM ${t} WHERE device_id = ? AND late = 0 ORDER BY id`).all(deviceId) as unknown as TouchRow[];
  return { canonical: q("touches").map(toStored), duplicates: q("duplicate_touches").map(toStored) };
}

/** Toques recebidos depois do cadastro (novos e repetições), na ordem de recebimento. */
export function listLateTouches(db: Db, deviceId: string): LateTouch[] {
  const q = (t: string, duplicate: boolean) =>
    (db.prepare(`SELECT id, click_id, type, ref, touched_at, received_at FROM ${t} WHERE device_id = ? AND late = 1 ORDER BY id`).all(deviceId) as unknown as (TouchRow & { id: number })[])
      .map((r) => ({ ...toStored(r), receivedAt: r.received_at, duplicate, id: r.id }));
  return [...q("touches", false), ...q("duplicate_touches", true)]
    .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id - b.id))
    .map(({ id: _id, ...rest }) => rest);
}

export function getSignup(db: Db, userId: string): StoredSignup | null {
  return (db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as unknown as StoredSignup | undefined) ?? null;
}

export function getSignupByDevice(db: Db, deviceId: string): StoredSignup | null {
  return (db.prepare("SELECT * FROM signups WHERE device_id = ?").get(deviceId) as unknown as StoredSignup | undefined) ?? null;
}

export function insertSignup(db: Db, s: StoredSignup): void {
  db.prepare(
    "INSERT INTO signups (user_id, device_id, signed_up_at, recorded_at, source, ref, click_id, reason, audit_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(s.user_id, s.device_id, s.signed_up_at, s.recorded_at, s.source, s.ref, s.click_id, s.reason, s.audit_json);
}
