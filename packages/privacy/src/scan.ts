import { createDeterministicId, sha256 } from '@scenebook/core';
import {
  SceneSchema,
  type PrivacyFinding,
  type PrivacySeverity,
  type Scene,
} from '@scenebook/schema';

import { BUILTIN_PRIVACY_RULES, SENSITIVE_KEY_PATTERN } from './rules.js';
import type {
  OcrSegment,
  PrivacyFindingCounts,
  PrivacyRule,
  PrivacyScanOptions,
  PrivacyScanResult,
} from './types.js';

export const PRIVACY_SCANNER_VERSION = '1.0.0';

const SEVERITY_RANK: Readonly<Record<PrivacySeverity, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  blocking: 4,
};

function emptyCounts(): PrivacyFindingCounts {
  return { info: 0, low: 0, medium: 0, high: 0, blocking: 0 };
}

function findingFor(
  rule: PrivacyRule,
  match: string,
  start: number,
  path: string,
  source: PrivacyFinding['source'],
): PrivacyFinding {
  const fingerprint = sha256(match);
  return {
    id: createDeterministicId(
      'privacy',
      `${rule.id}\u0000${path}\u0000${start}\u0000${fingerprint}`,
      20,
    ),
    category: rule.category,
    severity: rule.severity,
    confidence: rule.confidence,
    source,
    path,
    start,
    end: start + match.length,
    fingerprint,
    preview: `[REDACTED:${rule.category}]`,
    ruleId: rule.id,
    message: rule.message,
    disposition: 'open',
  };
}

function compileRule(rule: PrivacyRule): RegExp {
  const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const expression = new RegExp(rule.pattern.source, flags);
  expression.lastIndex = 0;
  if (expression.test('')) throw new TypeError(`Privacy rule ${rule.id} can match an empty string`);
  expression.lastIndex = 0;
  return expression;
}

function resultFromFindings(
  findings: readonly PrivacyFinding[],
  options: PrivacyScanOptions,
): PrivacyScanResult {
  const counts = emptyCounts();
  for (const finding of findings) counts[finding.severity] += 1;
  const blockAt = options.blockAt ?? 'high';
  const blocking = findings.some(
    (finding) =>
      finding.disposition === 'open' && SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockAt],
  );
  return {
    status: blocking ? 'blocked' : findings.length > 0 ? 'warning' : 'clear',
    scannedAt: (options.now ?? (() => new Date()))().toISOString(),
    scannerVersion: PRIVACY_SCANNER_VERSION,
    counts,
    findings,
  };
}

function scanString(text: string, options: PrivacyScanOptions): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const rules = [...BUILTIN_PRIVACY_RULES, ...(options.customRules ?? [])];
  const maxFindings = options.maxFindings ?? 10_000;
  for (const rule of rules) {
    const expression = compileRule(rule);
    for (const match of text.matchAll(expression)) {
      const value = match[0];
      if (!value || (rule.validate && !rule.validate(value))) continue;
      findings.push(
        findingFor(rule, value, match.index, options.path ?? '$', options.source ?? 'text'),
      );
      if (findings.length >= maxFindings) return findings;
    }
  }
  return findings.sort((left, right) => {
    const start = (left.start ?? 0) - (right.start ?? 0);
    if (start !== 0) return start;
    return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  });
}

export function scanText(text: string, options: PrivacyScanOptions = {}): PrivacyScanResult {
  return resultFromFindings(scanString(text, options), options);
}

function sensitiveKeyFinding(path: string, value: string): PrivacyFinding {
  const fingerprint = sha256(value);
  return {
    id: createDeterministicId('privacy', `sensitive-key\u0000${path}\u0000${fingerprint}`, 20),
    category: 'authentication',
    severity: 'blocking',
    confidence: 0.99,
    source: 'field',
    path,
    fingerprint,
    preview: '[REDACTED:authentication]',
    ruleId: 'sensitive-field-value',
    message: 'A sensitive field contains a persisted value',
    disposition: 'open',
  };
}

export function scanStructuredValue(
  value: unknown,
  options: PrivacyScanOptions = {},
): PrivacyScanResult {
  const findings: PrivacyFinding[] = [];
  const ancestors = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? 100;
  const maxFindings = options.maxFindings ?? 10_000;

  const visit = (candidate: unknown, path: string, depth: number, key?: string): void => {
    if (findings.length >= maxFindings) return;
    if (depth > maxDepth) throw new RangeError(`Privacy scan exceeded maximum depth at ${path}`);
    if (typeof candidate === 'string') {
      if (key && SENSITIVE_KEY_PATTERN.test(key) && candidate.length > 0)
        findings.push(sensitiveKeyFinding(path, candidate));
      findings.push(
        ...scanString(candidate, {
          ...options,
          path,
          source:
            options.source ??
            (path.toLowerCase().includes('url') || path.toLowerCase().includes('route')
              ? 'url'
              : 'text'),
          maxFindings: Math.max(0, maxFindings - findings.length),
        }),
      );
      return;
    }
    if (
      key &&
      SENSITIVE_KEY_PATTERN.test(key) &&
      (typeof candidate === 'number' || typeof candidate === 'boolean')
    ) {
      findings.push(sensitiveKeyFinding(path, String(candidate)));
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    if (ancestors.has(candidate))
      throw new TypeError(`Cannot privacy-scan a circular value at ${path}`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (const [index, entry] of candidate.entries())
          visit(entry, `${path}[${index}]`, depth + 1);
      } else {
        for (const [entryKey, entry] of Object.entries(candidate)) {
          const escaped = entryKey.replace(/~/gu, '~0').replace(/\//gu, '~1');
          visit(entry, `${path}/${escaped}`, depth + 1, entryKey);
        }
      }
    } finally {
      ancestors.delete(candidate);
    }
  };

  visit(value, options.path ?? '$', 0);
  const unique = new Map<string, PrivacyFinding>();
  for (const finding of findings)
    unique.set(`${finding.ruleId}\u0000${finding.path}\u0000${finding.fingerprint}`, finding);
  return resultFromFindings([...unique.values()], options);
}

export function scanScenePrivacy(
  scene: Scene,
  options: PrivacyScanOptions = {},
): PrivacyScanResult {
  return scanStructuredValue(SceneSchema.parse(scene), {
    ...options,
    path: options.path ?? '$scene',
  });
}

export function scanOcrSegments(
  segments: readonly OcrSegment[],
  options: PrivacyScanOptions = {},
): PrivacyScanResult {
  const findings: PrivacyFinding[] = [];
  for (const [index, segment] of segments.entries()) {
    const result = scanText(segment.text, {
      ...options,
      path: `$assets/${segment.assetHash}/ocr/${index}`,
      source: 'ocr',
      maxFindings: Math.max(0, (options.maxFindings ?? 10_000) - findings.length),
    });
    findings.push(
      ...result.findings.map((finding) => ({
        ...finding,
        ...(segment.bounds === undefined ? {} : { region: segment.bounds }),
      })),
    );
  }
  return resultFromFindings(findings, options);
}

export function combinePrivacyScanResults(
  results: readonly PrivacyScanResult[],
  options: PrivacyScanOptions = {},
): PrivacyScanResult {
  const findings = results.flatMap((result) => result.findings);
  return resultFromFindings(findings, options);
}
