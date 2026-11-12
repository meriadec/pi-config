/** Remove secrets and personal data before any text leaves the machine for an LLM call. */
const RULES: [RegExp, string][] = [
  [/\b(authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <redacted>"],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|PIN)[A-Z0-9_]*)\s*[=:]\s*\S+/g,
    "$1=<redacted>",
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<redacted-key>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-gh-token>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-slack-token>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1<redacted>@"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "<hex>"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "<long-token>"],
];

export function redact(text: string): string {
  return RULES.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
