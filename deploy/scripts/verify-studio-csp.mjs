import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [htmlPath, nginxPath] = process.argv.slice(2);
if (!htmlPath || !nginxPath) {
  throw new Error('Usage: verify-studio-csp.mjs <built-index.html> <nginx.conf>');
}

const [html, nginx] = await Promise.all([readFile(htmlPath, 'utf8'), readFile(nginxPath, 'utf8')]);
const meta = html.match(/<meta\s+http-equiv="content-security-policy"\s+content="([^"]+)">/iu);
if (!meta?.[1]) throw new Error("Studio build is missing SvelteKit's hash-bound CSP meta policy");

const directives = new Map(
  meta[1]
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [name, ...sources] = value.split(/\s+/u);
      return [name, sources];
    }),
);
for (const required of [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'connect-src',
  'object-src',
  'base-uri',
  'form-action',
]) {
  if (!directives.has(required)) throw new Error(`Studio CSP is missing ${required}`);
}
const scriptSources = directives.get('script-src') ?? [];
if (scriptSources.includes("'unsafe-inline'")) {
  throw new Error("Studio CSP must not permit script-src 'unsafe-inline'");
}

const inlineScripts = Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/giu))
  .filter((match) => !/\bsrc\s*=/iu.test(match[1] ?? ''))
  .map((match) => match[2] ?? '');
if (inlineScripts.length === 0) throw new Error('Studio build has no inline bootstrap to verify');
for (const source of inlineScripts) {
  const digest = createHash('sha256').update(source).digest('base64');
  const expected = `'sha256-${digest}'`;
  if (!scriptSources.includes(expected)) {
    throw new Error(`Studio CSP does not authorize inline bootstrap ${expected}`);
  }
}

const nginxPolicies = Array.from(
  nginx.matchAll(/add_header\s+Content-Security-Policy\s+"([^"]+)"/giu),
  (match) => match[1],
);
if (nginxPolicies.length === 0)
  throw new Error('Studio nginx config has no frame embedding policy');
for (const policy of nginxPolicies) {
  if (policy !== "frame-ancestors 'self'") {
    throw new Error(`Studio nginx CSP must contain only frame-ancestors; found: ${policy}`);
  }
}

console.log(
  `verified Studio CSP: ${inlineScripts.length} hash-bound bootstrap script(s), ${nginxPolicies.length} frame policy header(s)`,
);
