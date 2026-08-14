export type SecretCategory = "private_key" | "access_token" | "credential_assignment" | "high_entropy_secret";

export interface SecretScanFinding {
  readonly category: SecretCategory;
  readonly field: string;
}

export interface SecretScanResult {
  readonly safe: boolean;
  readonly findings: readonly SecretScanFinding[];
}

export class KnowledgeGraphSecurityError extends Error {
  readonly code = "secret_detected" as const;
  readonly findings: readonly SecretScanFinding[];

  constructor(findings: readonly SecretScanFinding[]) {
    super("Evidence contains a secret-like value and was not persisted.");
    this.name = "KnowledgeGraphSecurityError";
    this.findings = findings;
  }
}

const MAX_FINDINGS = 8;
const SECRET_PATTERNS: readonly [SecretCategory, RegExp][] = [
  ["private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u],
  ["access_token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/u],
  ["credential_assignment", /\b(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/_=-]{12,}/iu],
  ["high_entropy_secret", /\b(?:token|secret|credential)\b.{0,24}\b[A-Za-z0-9+/=_-]{32,}\b/iu],
];

export function scanSensitiveText(entries: readonly { readonly field: string; readonly text: string }[]): SecretScanResult {
  const findings: SecretScanFinding[] = [];
  for (const entry of entries) {
    for (const [category, pattern] of SECRET_PATTERNS) {
      if (!pattern.test(entry.text)) continue;
      findings.push({ category, field: entry.field });
      if (findings.length >= MAX_FINDINGS) return { safe: false, findings };
      break;
    }
  }
  return { safe: findings.length === 0, findings };
}

export function assertNoSecrets(entries: readonly { readonly field: string; readonly text: string }[]): void {
  const result = scanSensitiveText(entries);
  if (!result.safe) throw new KnowledgeGraphSecurityError(result.findings);
}
