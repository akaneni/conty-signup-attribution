import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function colunas(db: DatabaseSync, tabela: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[]).map((c) => c.name);
}

describe("migração", () => {
  it("banco antigo sem received_at/late ganha as colunas, mantém as linhas e reabrir é seguro", () => {
    dir = mkdtempSync(join(tmpdir(), "attr-"));
    const path = join(dir, "antigo.sqlite");
    const antigo = new DatabaseSync(path);
    antigo.exec(`
      CREATE TABLE touches (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, click_id TEXT NOT NULL,
        type TEXT NOT NULL, ref TEXT NOT NULL, touched_at TEXT NOT NULL, UNIQUE (device_id, click_id));
      CREATE TABLE duplicate_touches (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, click_id TEXT NOT NULL,
        type TEXT NOT NULL, ref TEXT NOT NULL, touched_at TEXT NOT NULL);
      INSERT INTO touches (device_id, click_id, type, ref, touched_at) VALUES ('d', 'c', 'campaign', 'x', '2026-03-01T00:00:00.000Z');
    `);
    antigo.close();

    const db = openDb(path);
    for (const t of ["touches", "duplicate_touches"]) {
      expect(colunas(db, t)).toEqual(expect.arrayContaining(["received_at", "late"]));
    }
    expect(db.prepare("SELECT click_id, late FROM touches").all()).toEqual([{ click_id: "c", late: 0 }]);
    db.close();
    openDb(path).close(); // idempotente
  });
});
