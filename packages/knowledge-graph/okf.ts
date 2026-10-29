import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { ensurePrivateDirectory } from "./config.ts";
import { KnowledgeGraphMaintenanceError, type KnowledgeGraphSnapshot } from "./maintenance.ts";
import { KnowledgeGraphAgentMaintenanceService, type AgentClaimMaintenanceInput, type AgentMaintenanceProvenance } from "./agent-maintenance.ts";
import { KnowledgeGraphRepositories, type EntityRecord } from "./repository.ts";
import { assertNoSecrets } from "./security.ts";
import type { DatabaseSync } from "node:sqlite";

const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_CONCEPTS = 1000;
const text = (max: number) => z.string().refine((value) => value.trim().length > 0 && [...value].length <= max);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entity = z.object({
  label: text(256),
  type: z.enum(["person", "project", "repository", "service", "tool", "organization", "location", "preference", "concept", "other"]),
  aliases: z.array(text(256)).max(8).optional(),
}).strict();
const object = z.discriminatedUnion("kind", [
  entity.extend({ kind: z.literal("entity") }),
  z.object({ kind: z.literal("text"), value: text(2048) }).strict(),
  z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("date"), value: z.string().refine((v) => v.endsWith("Z") && Number.isFinite(Date.parse(v)) && Date.parse(v) >= 0) }).strict(),
  z.object({ kind: z.literal("url"), value: z.string().max(1024).url().refine((v) => /^https?:\/\//u.test(v)) }).strict(),
]);
const claim = z.object({
  predicate: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
  object,
  validFrom: timestamp.optional(),
  validTo: timestamp.optional(),
  evidence: z.array(z.object({
    sourceKind: z.enum(["user_statement", "pi_session", "file", "command", "url", "other"]),
    locator: text(2048).optional(),
    excerpt: text(4000),
    sourceObservedAt: timestamp.optional(),
  }).strict()).min(1).max(5),
}).strict().refine((value) => value.validFrom === undefined || value.validTo === undefined || value.validTo > value.validFrom);
const extension = z.object({ version: z.literal(1), subject: entity, claims: z.array(claim).max(1000) }).strict();

function fail(message: string): never {
  throw new KnowledgeGraphMaintenanceError("invalid_snapshot", message);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function descriptor(snapshot: KnowledgeGraphSnapshot, item: EntityRecord) {
  return { label: item.label, type: item.type, aliases: snapshot.aliases.filter((a) => a.entityId === item.entityId && a.status === "accepted").map((a) => a.alias) };
}

/** A portable current-knowledge view, not a database backup. */
export function exportOkfBundle(snapshot: KnowledgeGraphSnapshot, exportDirectory: string, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/u.test(name) || name === "." || name === "..") fail("Use a simple OKF bundle directory name.");
  ensurePrivateDirectory(exportDirectory);
  const target = join(exportDirectory, name);
  const staging = join(exportDirectory, `.okf-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16)}`);
  // Reserve the destination first: never replace an existing bundle or symlink.
  mkdirSync(target, { mode: 0o700 });
  try {
    mkdirSync(staging, { mode: 0o700 });
    const index: string[] = ["---", "okf_version: '0.2'", "---", "", "# Shared knowledge", ""];
    const entities = new Map(snapshot.entities.filter((e) => e.status === "accepted").map((e) => [e.entityId, e]));
    let exportedBytes = 0;
    for (const item of entities.values()) {
      if (!/^ent_[a-zA-Z0-9-]+$/u.test(item.entityId)) fail("Invalid entity ID in export.");
      const claims = snapshot.claims.filter((c) => c.subjectEntityId === item.entityId && c.status === "accepted").map((c) => {
        const linked = snapshot.claimEvidence.filter((link) => link.claimId === c.claimId);
        const evidence = linked.map((link) => snapshot.evidence.find((e) => e.evidenceId === link.evidenceId)).filter((e) => e !== undefined);
        const obj = c.object;
        const related = obj.kind === "entity" ? entities.get(obj.entityId) : undefined;
        if (obj.kind === "entity" && !related) fail("Accepted claim references an unavailable entity.");
        return {
          predicate: c.predicate,
          object: obj.kind === "entity" && related ? { kind: "entity" as const, ...descriptor(snapshot, related) } : obj,
          validFrom: c.validFrom, validTo: c.validTo,
          evidence: evidence.map((e) => ({ sourceKind: e.sourceKind, locator: e.locator, excerpt: e.excerpt, sourceObservedAt: e.sourceObservedAt })),
        };
      });
      const portable = extension.parse({ version: 1, subject: descriptor(snapshot, item), claims });
      const sources = portable.claims.flatMap((c, ci) => c.evidence.map((e, ei) => ({ id: `c${ci}-e${ei}`, resource: e.locator ?? `urn:pi-knowledge:evidence:${item.entityId}:${ci}:${ei}`, title: e.excerpt })));
      const body = portable.claims.map((c, ci) => {
        const obj = c.object;
        const value = obj.kind === "entity" ? `[${obj.label}](${[...entities.values()].find((e) => e.label === obj.label && e.type === obj.type)?.entityId ?? "missing"}.md)` : String(obj.value);
        return `- **${c.predicate}**: ${value}${c.evidence.map((_e, ei) => `[^c${ci}-e${ei}]`).join("")}`;
      }).join("\n");
      const metadata = { type: item.type, title: item.label, status: "stable", sources, "x-pi-knowledge": portable };
      const content = `---\n${stringify(metadata)}---\n\n# ${item.label}\n\n${body}\n\n${sources.map((s) => `[^${s.id}]: ${s.title.replace(/\n/gu, " ")}`).join("\n")}\n`;
      const bytes = Buffer.byteLength(content);
      exportedBytes += bytes;
      if (bytes > MAX_FILE || exportedBytes > MAX_TOTAL - MAX_FILE) fail("Export exceeds OKF import size limits; use JSON export.");
      writeFileSync(join(staging, `${item.entityId}.md`), content, { mode: 0o600, flag: "wx" });
      index.push(`- [${item.label.replace(/[\[\]\n\r]/gu, " ")}](${item.entityId}.md)`);
    }
    if (entities.size > MAX_CONCEPTS) fail("Too many concepts for an OKF bundle; use JSON export.");
    writeFileSync(join(staging, "index.md"), `${index.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    // The reserved destination is empty and owned by this operation.
    renameSync(staging, target);
    return target;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export interface OkfPreview {
  readonly concepts: number;
  readonly candidates: readonly AgentClaimMaintenanceInput[];
  readonly warnings: readonly string[];
  readonly digest: string;
}

/** Read local files only. Links, sources, executors and attesters are never followed. */
export function previewOkfImport(directory: string): OkfPreview {
  const requested = resolve(directory);
  if (lstatSync(requested).isSymbolicLink()) fail("OKF input must not contain symlinks.");
  // Canonicalize ancestors (e.g. macOS /var -> /private/var). All bundle
  // entries themselves must be regular files/directories, never symlinks.
  const root = realpathSync(requested);
  if (!lstatSync(root).isDirectory()) fail("OKF input must be a directory.");
  const candidates: AgentClaimMaintenanceInput[] = [];
  const warnings = new Set<string>(["Imported content is untrusted. Verification, executors and attesters are never applied or run."]);
  const hash = createHash("sha256");
  let total = 0;
  let entries = 0;
  let concepts = 0;
  const visit = (dir: string, depth: number) => {
    if (depth > 16) fail("OKF directory nesting exceeds 16 levels.");
    for (const name of readdirSync(dir).sort()) {
      if (++entries > 4000) fail("OKF bundle contains too many entries.");
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail("OKF input must not contain symlinks.");
      if (stat.isDirectory()) { visit(path, depth + 1); continue; }
      if (!stat.isFile()) fail("OKF input contains a non-regular file.");
      if (!name.endsWith(".md")) { warnings.add("Non-Markdown assets were not imported."); continue; }
      if (stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL) fail("OKF bundle exceeds size limits (256 KiB/file, 16 MiB total).");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: string;
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_FILE) fail("OKF input changed while reading.");
        if (!realpathSync(path).startsWith(`${root}${sep}`)) fail("OKF file escapes the bundle.");
        const buffer = Buffer.alloc(MAX_FILE + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length > MAX_FILE || length !== stat.size) fail("OKF input changed while reading.");
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
        catch { fail("OKF documents must be valid UTF-8."); }
      } finally { closeSync(fd); }
      const id = relative(root, path).split(sep).join("/");
      hash.update(id).update("\0").update(content).update("\0");
      if (name === "index.md" || name === "log.md") continue;
      if (++concepts > MAX_CONCEPTS) fail("OKF bundle exceeds 1000 concepts.");
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
      if (!match) fail(`Missing YAML frontmatter: ${id}.`);
      let metadata: unknown;
      try {
        const doc = parseDocument(match[1], { uniqueKeys: true, schema: "core", version: "1.2" });
        if (doc.errors.length || doc.warnings.length) fail("Invalid or unsupported YAML.");
        metadata = doc.toJS({ maxAliasCount: 0 });
      } catch { fail(`Invalid or unsafe YAML frontmatter: ${id}.`); }
      if (!record(metadata) || typeof metadata.type !== "string" || !metadata.type.trim()) fail(`Concept requires a type: ${id}.`);
      assertNoSecrets([{ field: "OKF document", text: content }]);
      if (metadata.status !== undefined && !["draft", "stable", "deprecated"].includes(String(metadata.status))) fail(`Invalid lifecycle status: ${id}.`);
      if (metadata.status === "deprecated" || metadata.status === "draft") { warnings.add("Draft/deprecated concepts were skipped."); continue; }
      if (metadata.stale_after !== undefined) {
        if (typeof metadata.stale_after !== "string" || !Number.isFinite(Date.parse(metadata.stale_after))) fail(`Invalid stale_after: ${id}.`);
        if (Date.now() >= Date.parse(metadata.stale_after)) { warnings.add("Stale concepts were skipped."); continue; }
      }
      if (metadata["x-pi-knowledge"] !== undefined) {
        const parsed = extension.safeParse(metadata["x-pi-knowledge"]);
        if (!parsed.success) fail(`Invalid x-pi-knowledge extension: ${id}.`);
        for (const c of parsed.data.claims) {
          candidates.push({ operation: "insert", subject: parsed.data.subject, ...c,
            // Imported attestations do not become local user/agent evidence.
            evidence: c.evidence.map((e) => ({ ...e, sourceKind: "file", locator: path })),
          });
        }
        warnings.add("Pi extension claims are authoritative for import; Markdown edits do not change those structured claims. IDs/history/audit records and claimless entities are not restored. Evidence is reattributed to the imported file, not its asserted original source.");
      } else {
        const label = typeof metadata.title === "string" ? metadata.title : basename(name, ".md");
        const subject = entity.safeParse({ label, type: "concept" });
        if (!subject.success) fail(`Concept title is empty or exceeds 256 characters: ${id}.`);
        // Keep the entire document as untrusted text chunks, including unknown metadata.
        const chars = [...content];
        for (let offset = 0; offset < chars.length; offset += 1800) {
          const value = chars.slice(offset, offset + 1800).join("");
          if (!value.trim()) continue;
          candidates.push({ operation: "insert", subject: subject.data, predicate: "okf_content", object: { kind: "text", value }, evidence: [{ sourceKind: "file", locator: path, excerpt: value }] });
        }
        warnings.add("External concepts are imported as okf_content text chunks, preserving frontmatter and links as text, not inferring typed relationships.");
      }
      if (candidates.length > 10000) fail("OKF bundle exceeds 10000 claims.");
    }
  };
  visit(root, 0);
  return { concepts, candidates, warnings: [...warnings], digest: hash.digest("hex") };
}

/** All or nothing, through the existing validation, secret scanning and audit path. */
export function applyOkfImport(database: DatabaseSync, repositories: KnowledgeGraphRepositories, scopeId: string, preview: OkfPreview, provenance: AgentMaintenanceProvenance): number {
  const service = new KnowledgeGraphAgentMaintenanceService(database, repositories);
  return repositories.transaction(() => {
    let inserted = 0;
    for (const candidate of preview.candidates) {
      const result = service.execute(scopeId, candidate, provenance);
      if (result.status === "accepted") inserted++;
    }
    return inserted;
  });
}
