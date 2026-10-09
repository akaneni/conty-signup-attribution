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
      UNIQUE (device_id, click_id)
    );
    -- Repetições do mesmo click_id: guardadas só para a auditoria mostrar "duplicate".
    CREATE TABLE IF NOT EXISTS duplicate_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      click_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref TEXT NOT NULL,
      touched_at TEXT NOT NULL
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

/** Devolve true se o toque é novo, false se o click_id já existia (guardado como duplicado). */
export function recordTouch(db: Db, deviceId: string, t: StoredTouch): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO touches (device_id, click_id, type, ref, touched_at) VALUES (?, ?, ?, ?, ?)")
    .run(deviceId, t.clickId, t.type, t.ref, t.touchedAt);
  if (Number(res.changes) === 1) return true;
  db.prepare("INSERT INTO duplicate_touches (device_id, click_id, type, ref, touched_at) VALUES (?, ?, ?, ?, ?)")
    .run(deviceId, t.clickId, t.type, t.ref, t.touchedAt);
  return false;
}

interface TouchRow { click_id: string; type: TouchType; ref: string; touched_at: string }
const toStored = (r: TouchRow): StoredTouch => ({ clickId: r.click_id, type: r.type, ref: r.ref, touchedAt: r.touched_at });

export function listTouches(db: Db, deviceId: string): { canonical: StoredTouch[]; duplicates: StoredTouch[] } {
  const canonical = db.prepare("SELECT click_id, type, ref, touched_at FROM touches WHERE device_id = ? ORDER BY id").all(deviceId) as unknown as TouchRow[];
  const duplicates = db.prepare("SELECT click_id, type, ref, touched_at FROM duplicate_touches WHERE device_id = ? ORDER BY id").all(deviceId) as unknown as TouchRow[];
  return { canonical: canonical.map(toStored), duplicates: duplicates.map(toStored) };
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
