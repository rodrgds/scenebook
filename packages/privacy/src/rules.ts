import type { PrivacyRule } from './types.js';

function luhn(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/gu, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const value = Number(digits[index]);
    let contribution = value;
    if (double) {
      contribution *= 2;
      if (contribution > 9) contribution -= 9;
    }
    sum += contribution;
    double = !double;
  }
  return sum % 10 === 0;
}

export const BUILTIN_PRIVACY_RULES: readonly PrivacyRule[] = Object.freeze([
  {
    id: 'private-key',
    category: 'private-key',
    severity: 'blocking',
    confidence: 1,
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
    message: 'Private key material detected',
  },
  {
    id: 'jwt-token',
    category: 'token',
    severity: 'blocking',
    confidence: 0.99,
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    message: 'JSON Web Token detected',
  },
  {
    id: 'provider-token',
    category: 'token',
    severity: 'blocking',
    confidence: 0.99,
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
    message: 'Provider access token detected',
  },
  {
    id: 'authorization-bearer',
    category: 'authentication',
    severity: 'blocking',
    confidence: 0.99,
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/giu,
    message: 'Bearer credential detected',
  },
  {
    id: 'password-assignment',
    category: 'password',
    severity: 'blocking',
    confidence: 0.98,
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]{4,}/giu,
    message: 'Password-like assignment detected',
  },
  {
    id: 'url-credentials',
    category: 'authentication',
    severity: 'blocking',
    confidence: 0.98,
    pattern: /https?:\/\/[^\s\/@:]+:[^\s\/@]+@[^\s/]+/giu,
    message: 'Credentials embedded in a URL detected',
  },
  {
    id: 'payment-card',
    category: 'payment',
    severity: 'blocking',
    confidence: 0.99,
    pattern: /\b(?:\d[ -]*?){13,19}\b/gu,
    validate: luhn,
    message: 'Payment-card number detected',
  },
  {
    id: 'email-address',
    category: 'email',
    severity: 'medium',
    confidence: 0.98,
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/giu,
    message: 'Email address detected',
  },
  {
    id: 'phone-number',
    category: 'phone',
    severity: 'low',
    confidence: 0.72,
    pattern: /(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)/gu,
    validate: (match) => {
      const count = match.replace(/\D/gu, '').length;
      return count >= 9 && count <= 15;
    },
    message: 'Phone-number-like value detected',
  },
]);

export const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|session|credit[-_]?card|card[-_]?number|cvv|cvc)/iu;
