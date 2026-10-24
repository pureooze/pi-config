import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TaskMemoryWriteInput {
  key: string;
  category?: string;
  content: string;
  evidence?: string[];
}

export interface TaskMemoryEntry {
  key: string;
  category?: string;
  content: string;
  evidence?: string[];
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  taskIdHash: string;
  createdAt: number;
  expiresAt: number;
  entries: TaskMemoryEntry[];
}

const MAX_ENTRIES = 64;
const MAX_KEY_LENGTH = 100;
const MAX_CONTENT_LENGTH = 1200;
const MAX_CATEGORY_LENGTH = 100;
const MAX_EVIDENCE_COUNT = 8;
const MAX_EVIDENCE_STRING = 300;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_RESULTS = 5;

export class TaskMemoryStore {
  readonly #filePath: string;
  readonly #taskIdHash: string;
  #state: StoreFile;

  constructor(rootDirectory: string, taskId: string) {
    if (typeof rootDirectory !== "string" || rootDirectory.length === 0) {
      throw new Error("rootDirectory must be a non-empty string");
    }
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("taskId must be a non-empty string");
    }
    const fileName = createHash("sha256").update(taskId, "utf8").digest("hex");
    mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    const root = lstatSync(rootDirectory);
    if (!root.isDirectory() || (typeof process.getuid === "function" && root.uid !== process.getuid())) {
      throw new Error("Task memory root must be an owned directory (not a symlink)");
    }
    // Early versions created this directory with the process umask (often 0755).
    // Repair only an owned, real directory; never chmod a symlink or foreign path.
    if ((root.mode & 0o077) !== 0) chmodSync(rootDirectory, 0o700);
    if ((lstatSync(rootDirectory).mode & 0o077) !== 0) throw new Error("Task memory root must be private");
    this.#filePath = join(rootDirectory, `${fileName}.task-memory.json`);
    this.#taskIdHash = fileName;
    this.#state = this.#load();
  }

  #load(): StoreFile {
    let state: StoreFile | null = null;
    try {
      if (!lstatSync(this.#filePath).isFile()) throw new Error("Invalid task memory file");
      const raw = readFileSync(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (this.#isValidStore(parsed)) {
        state = parsed;
      }
    } catch {
      state = null;
    }
    const now = Date.now();
    if (state && state.expiresAt > now && state.taskIdHash === this.#taskIdHash) {
      return state;
    }
    if (state && state.expiresAt <= now) unlinkSync(this.#filePath);
    const fresh: StoreFile = {
      version: 1,
      taskIdHash: this.#taskIdHash,
      createdAt: now,
      expiresAt: now + TTL_MS,
      entries: [],
    };
    return fresh;
  }

  #isValidStore(value: unknown): value is StoreFile {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (v.version !== 1) return false;
    if (v.taskIdHash !== this.#taskIdHash) return false;
    if (typeof v.createdAt !== "number") return false;
    if (typeof v.expiresAt !== "number") return false;
    if (!Array.isArray(v.entries) || v.entries.length > MAX_ENTRIES) return false;
    for (const entry of v.entries) {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.key !== "string" || e.key.length > MAX_KEY_LENGTH) return false;
      if (typeof e.content !== "string" || e.content.length > MAX_CONTENT_LENGTH) return false;
      if (typeof e.createdAt !== "number") return false;
      if (typeof e.updatedAt !== "number") return false;
    }
    return true;
  }

  #write(state: StoreFile): void {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.#filePath);
  }

  #persist(): void {
    this.#write(this.#state);
  }

  #validateWrite(input: TaskMemoryWriteInput): void {
    if (!input || typeof input !== "object") {
      throw new Error("input must be an object");
    }
    const { key, category, content, evidence } = input;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new Error(`key must be a non-empty string up to ${MAX_KEY_LENGTH} characters`);
    }
    if (typeof content !== "string" || content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`content must be a non-empty string up to ${MAX_CONTENT_LENGTH} characters`);
    }
    if (category !== undefined) {
      if (typeof category !== "string" || category.length === 0 || category.length > MAX_CATEGORY_LENGTH) {
        throw new Error(`category must be a non-empty string up to ${MAX_CATEGORY_LENGTH} characters`);
      }
    }
    if (evidence !== undefined) {
      if (!Array.isArray(evidence)) {
        throw new Error("evidence must be an array of strings");
      }
      if (evidence.length > MAX_EVIDENCE_COUNT) {
        throw new Error(`evidence must contain at most ${MAX_EVIDENCE_COUNT} items`);
      }
      for (const item of evidence) {
        if (typeof item !== "string" || item.length === 0 || item.length > MAX_EVIDENCE_STRING) {
          throw new Error(`evidence items must be non-empty strings up to ${MAX_EVIDENCE_STRING} characters`);
        }
      }
    }
  }

  write(input: TaskMemoryWriteInput): void {
    this.#validateWrite(input);
    this.#state = this.#load();
    const now = Date.now();
    if (now >= this.#state.expiresAt) {
      this.#state = {
        version: 1,
        taskIdHash: this.#taskIdHash,
        createdAt: now,
        expiresAt: now + TTL_MS,
        entries: [],
      };
    }
    const existingIndex = this.#state.entries.findIndex((e) => e.key === input.key);
    const entry: TaskMemoryEntry = {
      key: input.key,
      category: input.category,
      content: input.content,
      evidence: input.evidence ? [...input.evidence] : undefined,
      createdAt: existingIndex >= 0 ? this.#state.entries[existingIndex]!.createdAt : now,
      updatedAt: now,
    };
    if (existingIndex >= 0) {
      this.#state.entries[existingIndex] = entry;
    } else {
      if (this.#state.entries.length >= MAX_ENTRIES) {
        throw new Error(`memory store is full (max ${MAX_ENTRIES} entries)`);
      }
      this.#state.entries.push(entry);
    }
    this.#persist();
  }

  /** Explicitly finish this parent task. Workers do not receive this operation. */
  complete(): void {
    try { unlinkSync(this.#filePath); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const now = Date.now();
    this.#state = { version: 1, taskIdHash: this.#taskIdHash, createdAt: now, expiresAt: now + TTL_MS, entries: [] };
  }

  get(key: string): TaskMemoryEntry | undefined {
    if (typeof key !== "string" || key.length === 0) return undefined;
    this.#state = this.#load();
    return this.#state.entries.find((e) => e.key === key);
  }

  search(query: string, category?: string): TaskMemoryEntry[] {
    if (typeof query !== "string" || query.length === 0) return [];
    if (category !== undefined && (typeof category !== "string" || category.length === 0)) {
      return [];
    }
    this.#state = this.#load();
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const scored: { entry: TaskMemoryEntry; score: number }[] = [];
    for (const entry of this.#state.entries) {
      if (category !== undefined && entry.category !== category) continue;
      const haystack = `${entry.key} ${entry.content} ${entry.evidence ? entry.evidence.join(" ") : ""}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        const occurrences = haystack.split(token).length - 1;
        if (occurrences > 0) score += occurrences;
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.entry.updatedAt - a.entry.updatedAt;
    });
    return scored.slice(0, MAX_SEARCH_RESULTS).map((s) => s.entry);
  }
}