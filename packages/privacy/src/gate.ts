import type {
  AssetPrivacyAssessment,
  PrivacyScanResult,
  PublicationPrivacyDecision,
  PublicationPrivacyGate,
  PublicationPrivacyInput,
} from './types.js';

export class PrivacyBlockedError extends Error {
  readonly gate: PublicationPrivacyGate;

  constructor(message: string, gate: PublicationPrivacyGate) {
    super(message);
    this.name = 'PrivacyBlockedError';
    this.gate = gate;
  }
}

export function assessAssetPrivacy(
  assetHash: string,
  result?: PrivacyScanResult,
  method: AssetPrivacyAssessment['method'] = result ? 'ocr' : 'none',
): AssetPrivacyAssessment {
  if (!result) return { assetHash, status: 'unknown', method: 'none', findings: [] };
  return {
    assetHash,
    status: result.status,
    method,
    scannedAt: result.scannedAt,
    scannerVersion: result.scannerVersion,
    findings: result.findings,
  };
}

export function evaluatePublicationPrivacy(input: PublicationPrivacyInput): PublicationPrivacyGate {
  const unscannedAssetHashes = input.assets
    .filter((asset) => asset.status === 'unknown' || asset.method === 'none')
    .map((asset) => asset.assetHash)
    .sort();
  const blockedAssetHashes = input.assets
    .filter((asset) => asset.status === 'blocked')
    .map((asset) => asset.assetHash)
    .sort();
  const findings = [
    ...input.structured.findings,
    ...input.assets.flatMap((asset) => asset.findings),
  ];
  const status =
    input.structured.status === 'blocked' || blockedAssetHashes.length > 0
      ? 'blocked'
      : unscannedAssetHashes.length > 0
        ? 'unknown'
        : input.structured.status === 'warning' ||
            input.assets.some((asset) => asset.status === 'warning')
          ? 'warning'
          : 'clear';
  return { status, findings, unscannedAssetHashes, blockedAssetHashes };
}

export function assertPublicationPrivacySafe(
  gate: PublicationPrivacyGate,
  options: { readonly allowUnscannedPrivacy?: boolean } = {},
): PublicationPrivacyDecision {
  if (gate.status === 'blocked')
    throw new PrivacyBlockedError('Publication contains blocked privacy findings', gate);
  const overrideUsed = gate.status === 'unknown' && options.allowUnscannedPrivacy === true;
  if (gate.status === 'unknown' && !overrideUsed) {
    throw new PrivacyBlockedError(
      'Publication contains pixel-bearing assets whose privacy status is unknown',
      gate,
    );
  }
  return { ...gate, overrideUsed };
}

export function assertPrivacySafe(result: PrivacyScanResult): PrivacyScanResult {
  if (result.status === 'blocked') {
    throw new PrivacyBlockedError('Structured source contains blocked privacy findings', {
      status: 'blocked',
      findings: result.findings,
      unscannedAssetHashes: [],
      blockedAssetHashes: [],
    });
  }
  return result;
}
