import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const DATA_DIRECTORY_ENV = "PI_KNOWLEDGE_GRAPH_DIR";
const SEARCH_LIMIT_ENV = "PI_KNOWLEDGE_GRAPH_DEFAULT_SEARCH_LIMIT";
const SHOW_LOCATORS_ENV = "PI_KNOWLEDGE_GRAPH_SHOW_SOURCE_LOCATORS";
const GLOBAL_CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_RELATIVE_PATH = [".pi", "knowledge-graph.json"] as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;

type ConfigSource = "global" | "project";

interface SafePreferences {
  defaultSearchLimit?: number;
  showSourceLocators?: boolean;
}

export interface ConfigResolutionOptions {
  cwd: string;
  projectRoot?: string;
  projectTrusted: boolean;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface StoragePaths {
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly exportDirectory: string;
  readonly globalConfigPath: string;
}

export interface KnowledgeGraphConfig extends StoragePaths {
  readonly projectConfigPath: string | undefined;
  readonly defaultSearchLimit: number;
  readonly showSourceLocators: boolean;
  readonly warnings: readonly string[];
}

export type StoragePathErrorCode =
  | "not_absolute"
  | "symlink_not_allowed"
  | "not_directory"
  | "not_regular_file"
  | "insecure_permissions"
  | "wrong_owner";

export class StoragePathError extends Error {
  readonly code: StoragePathErrorCode;
  readonly targetPath: string;

  constructor(code: StoragePathErrorCode, targetPath: string, message: string) {
    super(message);
    this.name = "StoragePathError";
    this.code = code;
    this.targetPath = targetPath;
  }
}

export class KnowledgeGraphConfigError extends Error {
  readonly code = "invalid_storage_root" as const;

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeStoragePaths(rootDirectory: string): StoragePaths {
  const root = resolve(rootDirectory);
  return {
    rootDirectory: root,
    databasePath: join(root, "knowledge.sqlite"),
    backupDirectory: join(root, "backups"),
    exportDirectory: join(root, "exports"),
    globalConfigPath: join(root, GLOBAL_CONFIG_FILENAME),
  };
}

function ensureAbsolutePath(targetPath: string): string {
  if (!isAbsolute(targetPath)) {
    throw new StoragePathError("not_absolute", targetPath, "Storage paths must be absolute.");
  }
  return resolve(targetPath);
}

function assertOwnerAndMode(targetPath: string, mode: number, expectedMode: number): void {
  if (typeof process.getuid === "function") {
    const stat = lstatSync(targetPath);
    if (stat.uid !== process.getuid()) {
      throw new StoragePathError("wrong_owner", targetPath, "Storage path is not owned by the current user.");
    }
  }

  if (mode !== expectedMode) {
    throw new StoragePathError(
      "insecure_permissions",
      targetPath,
      "Storage permissions are not private.",
    );
  }
}

export function assertPrivateDirectory(directoryPath: string): void {
  const targetPath = ensureAbsolutePath(directoryPath);
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    throw new StoragePathError("not_directory", targetPath, "Storage directory does not exist.");
  }

  if (stat.isSymbolicLink()) {
    throw new StoragePathError("symlink_not_allowed", targetPath, "Storage directories cannot be symlinks.");
  }
  if (!stat.isDirectory()) {
    throw new StoragePathError("not_directory", targetPath, "Storage path is not a directory.");
  }
  assertOwnerAndMode(targetPath, stat.mode & 0o777, PRIVATE_DIRECTORY_MODE);
}

export function assertPrivateFile(filePath: string): void {
  const targetPath = ensureAbsolutePath(filePath);
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    throw new StoragePathError("not_regular_file", targetPath, "Storage file does not exist.");
  }

  if (stat.isSymbolicLink()) {
    throw new StoragePathError("symlink_not_allowed", targetPath, "Storage files cannot be symlinks.");
  }
  if (!stat.isFile()) {
    throw new StoragePathError("not_regular_file", targetPath, "Storage path is not a regular file.");
  }
  assertOwnerAndMode(targetPath, stat.mode & 0o777, PRIVATE_FILE_MODE);
}

export function ensurePrivateDirectory(directoryPath: string): void {
  const targetPath = ensureAbsolutePath(directoryPath);
  if (pathExists(targetPath)) {
    assertPrivateDirectory(targetPath);
    return;
  }

  mkdirSync(targetPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(targetPath, PRIVATE_DIRECTORY_MODE);
  assertPrivateDirectory(targetPath);
}

export function ensurePrivateFile(filePath: string): void {
  const targetPath = ensureAbsolutePath(filePath);
  ensurePrivateDirectory(dirname(targetPath));

  if (!pathExists(targetPath)) {
    const descriptor = openSync(targetPath, "wx", PRIVATE_FILE_MODE);
    closeSync(descriptor);
    chmodSync(targetPath, PRIVATE_FILE_MODE);
  }
  assertPrivateFile(targetPath);
}

export function prepareStoragePaths(paths: StoragePaths): void {
  ensurePrivateDirectory(paths.rootDirectory);
  ensurePrivateDirectory(paths.backupDirectory);
  ensurePrivateDirectory(paths.exportDirectory);
  ensurePrivateFile(paths.databasePath);
}

export function resolveKnowledgeGraphConfig(options: ConfigResolutionOptions): KnowledgeGraphConfig {
  const environment = options.env ?? process.env;
  const homeDirectory = ensureAbsolutePath(options.homeDirectory ?? homedir());
  const configuredRoot = environment[DATA_DIRECTORY_ENV]?.trim();
  if (configuredRoot && (!isAbsolute(configuredRoot) || configuredRoot.length > MAX_PATH_LENGTH)) {
    throw new KnowledgeGraphConfigError(`${DATA_DIRECTORY_ENV} must be an absolute path no longer than ${MAX_PATH_LENGTH} characters.`);
  }

  const storagePaths = makeStoragePaths(configuredRoot || join(homeDirectory, ".pi", "agent", "knowledge-graph"));
  const warnings: string[] = [];
  const globalPreferences = readPreferences(storagePaths.globalConfigPath, "global", true, warnings);
  const projectConfigPath = resolve(options.projectRoot ?? options.cwd, ...PROJECT_CONFIG_RELATIVE_PATH);
  const projectPreferences = options.projectTrusted
    ? readPreferences(projectConfigPath, "project", false, warnings)
    : {};

  let defaultSearchLimit = globalPreferences.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT;
  let showSourceLocators = globalPreferences.showSourceLocators ?? false;

  if (projectPreferences.defaultSearchLimit !== undefined) {
    defaultSearchLimit = projectPreferences.defaultSearchLimit;
  }
  if (projectPreferences.showSourceLocators !== undefined) {
    showSourceLocators = projectPreferences.showSourceLocators;
  }

  const environmentSearchLimit = parseEnvironmentSearchLimit(environment[SEARCH_LIMIT_ENV], warnings);
  if (environmentSearchLimit !== undefined) defaultSearchLimit = environmentSearchLimit;
  const environmentShowLocators = parseEnvironmentBoolean(environment[SHOW_LOCATORS_ENV], SHOW_LOCATORS_ENV, warnings);
  if (environmentShowLocators !== undefined) showSourceLocators = environmentShowLocators;

  return {
    ...storagePaths,
    projectConfigPath: options.projectTrusted ? projectConfigPath : undefined,
    defaultSearchLimit,
    showSourceLocators,
    warnings,
  };
}

function readPreferences(
  filePath: string,
  source: ConfigSource,
  requirePrivateFile: boolean,
  warnings: string[],
): SafePreferences {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    warnings.push(`${source}_config_unreadable`);
    return {};
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    warnings.push(`${source}_config_not_regular_file`);
    return {};
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    warnings.push(`${source}_config_too_large`);
    return {};
  }

  if (requirePrivateFile) {
    try {
      assertPrivateFile(filePath);
    } catch {
      warnings.push(`${source}_config_permissions_invalid`);
      return {};
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    warnings.push(`${source}_config_invalid_json`);
    return {};
  }

  if (!isRecord(parsed)) {
    warnings.push(`${source}_config_not_object`);
    return {};
  }

  const preferences: SafePreferences = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "defaultSearchLimit") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_LIMIT) {
        preferences.defaultSearchLimit = value;
      } else {
        warnings.push(`${source}_config_default_search_limit_invalid`);
      }
      continue;
    }
    if (key === "showSourceLocators") {
      if (typeof value === "boolean") {
        preferences.showSourceLocators = value;
      } else {
        warnings.push(`${source}_config_show_source_locators_invalid`);
      }
      continue;
    }
    warnings.push(`${source}_config_unknown_field_ignored`);
  }

  return preferences;
}

function parseEnvironmentSearchLimit(value: string | undefined, warnings: string[]): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SEARCH_LIMIT) return parsed;
  warnings.push(`${SEARCH_LIMIT_ENV}_invalid`);
  return undefined;
}

function parseEnvironmentBoolean(value: string | undefined, name: string, warnings: string[]): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  warnings.push(`${name}_invalid`);
  return undefined;
}

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
