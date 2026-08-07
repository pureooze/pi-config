import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "pi-kg-sqlite-spike-"));
const databasePath = join(root, "knowledge.sqlite");
const backupPath = join(root, "knowledge-backup.sqlite");
const childPath = join(root, "concurrency-child.mjs");

writeFileSync(
  childPath,
  `import { DatabaseSync } from "node:sqlite";
const databasePath = process.argv[2];
const mode = process.argv[3];
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout=250");
try {
  db.prepare("INSERT INTO concurrent(value) VALUES (?)").run(mode);
  db.close();
  process.stdout.write("write-ok\\n");
} catch (error) {
  db.close();
  process.stderr.write(String(error?.code ?? "") + ":" + String(error?.message ?? error) + "\\n");
  process.exitCode = 42;
}
`,
);

const results = [];
const record = (name, details = "ok") => results.push({ name, details });
let db;
try {
  db = new DatabaseSync(databasePath);
  record("node:sqlite import and DatabaseSync open", `sqlite=${process.versions.sqlite}`);

  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get();
  const journalMode = db.prepare("PRAGMA journal_mode").get();
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get();
  assert.equal(foreignKeys.foreign_keys, 1);
  assert.equal(journalMode.journal_mode, "wal");
  assert.equal(busyTimeout.timeout, 1000);
  record("foreign keys, WAL, and busy timeout", `journal=${journalMode.journal_mode}, timeout=${busyTimeout.timeout}ms`);

  db.exec(`
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id));
    CREATE TABLE transactions(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE concurrent(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE search_index USING fts5(title, body, tokenize='unicode61');
  `);
  record("schema and FTS5 virtual table creation");

  db.prepare("INSERT INTO search_index(title, body) VALUES (?, ?)").run(
    "Persistent memory",
    "Pi knowledge graph evidence",
  );
  const ftsRows = db
    .prepare("SELECT rowid, title, body FROM search_index WHERE search_index MATCH ? ORDER BY rank")
    .all("knowledge");
  assert.equal(ftsRows.length, 1);
  assert.equal(ftsRows[0].title, "Persistent memory");
  record("FTS5 insert and MATCH query", `rows=${ftsRows.length}`);

  db.exec("BEGIN; INSERT INTO transactions(value) VALUES ('rolled back'); ROLLBACK;");
  const transactionCount = db.prepare("SELECT COUNT(*) AS count FROM transactions").get();
  assert.equal(transactionCount.count, 0);
  record("transaction rollback", `rows=${transactionCount.count}`);

  db.prepare("INSERT INTO parent DEFAULT VALUES").run();
  db.prepare("INSERT INTO child(parent_id) VALUES (?)").run(1);
  let foreignKeyRejected = false;
  try {
    db.prepare("INSERT INTO child(parent_id) VALUES (?)").run(999);
  } catch (error) {
    foreignKeyRejected = true;
    assert.match(String(error?.message ?? error), /FOREIGN KEY/i);
  }
  assert.equal(foreignKeyRejected, true);
  record("foreign-key violation rejection");

  db.prepare("INSERT INTO concurrent(value) VALUES (?)").run("parent");
  db.exec("VACUUM INTO '" + backupPath.replaceAll("'", "''") + "'");
  const backup = new DatabaseSync(backupPath);
  const backupCount = backup.prepare("SELECT COUNT(*) AS count FROM concurrent").get();
  const backupFts = backup.prepare("SELECT COUNT(*) AS count FROM search_index WHERE search_index MATCH ?").get("knowledge");
  assert.equal(backupCount.count, 1);
  assert.equal(backupFts.count, 1);
  backup.close();
  record("VACUUM INTO backup and reopen", `rows=${backupCount.count}, fts=${backupFts.count}`);

  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO concurrent(value) VALUES (?)").run("held-by-parent");
  const blocked = spawnSync(process.execPath, [childPath, databasePath, "blocked"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(blocked.status, 42, `expected busy child status 42, got ${blocked.status}; stdout=${blocked.stdout}; stderr=${blocked.stderr}`);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /SQLITE_BUSY|database is locked|database table is locked|ERR_SQLITE_ERROR/i);
  db.exec("ROLLBACK");
  const released = spawnSync(process.execPath, [childPath, databasePath, "after-release"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(released.status, 0, `expected post-release child success; stdout=${released.stdout}; stderr=${released.stderr}`);
  const concurrentCount = db.prepare("SELECT COUNT(*) AS count FROM concurrent").get();
  assert.equal(concurrentCount.count, 2);
  record("two-process write contention and recovery", `rows=${concurrentCount.count}`);

  const integrity = db.prepare("PRAGMA integrity_check").get();
  assert.equal(integrity.integrity_check, "ok");
  record("integrity check", integrity.integrity_check);

  console.log(JSON.stringify({
    status: "pass",
    node: process.version,
    sqlite: process.versions.sqlite,
    databasePath: "temporary",
    checks: results,
  }, null, 2));
} finally {
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
