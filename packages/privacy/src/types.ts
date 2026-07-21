import type {
  NormalizedRect,
  PrivacyCategory,
  PrivacyFinding,
  PrivacySeverity,
  Scene,
} from '@scenebook/schema';

export interface PrivacyRule {
  readonly id: string;
  readonly category: PrivacyCategory;
  readonly severity: PrivacySeverity;
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly validate?: (match: string) => boolean;
  readonly message: string;
}

export interface PrivacyScanOptions {
  readonly blockAt?: 'medium' | 'high' | 'blocking';
  readonly customRules?: readonly PrivacyRule[];
  readonly now?: () => Date;
  readonly path?: string;
  readonly source?: PrivacyFinding['source'];
  readonly maxDepth?: number;
  readonly maxFindings?: number;
}

export interface PrivacyFindingCounts {
  info: number;
  low: number;
  medium: number;
  high: number;
  blocking: number;
}

export interface PrivacyScanResult {
  readonly status: 'clear' | 'warning' | 'blocked';
  readonly scannedAt: string;
  readonly scannerVersion: string;
  readonly counts: PrivacyFindingCounts;
  readonly findings: readonly PrivacyFinding[];
}

export interface OcrSegment {
  readonly text: string;
  readonly assetHash: string;
  readonly bounds?: NormalizedRect;
  readonly page?: number;
}

export interface AssetPrivacyAssessment {
  readonly assetHash: string;
  readonly status: 'unknown' | 'clear' | 'warning' | 'blocked';
  readonly method: 'none' | 'ocr' | 'manual';
  readonly scannedAt?: string;
  readonly scannerVersion?: string;
  readonly policyDigest?: string;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly findings: readonly PrivacyFinding[];
}

export interface PublicationPrivacyInput {
  readonly structured: PrivacyScanResult;
  readonly assets: readonly AssetPrivacyAssessment[];
}

export interface PublicationPrivacyGate {
  readonly status: 'unknown' | 'clear' | 'warning' | 'blocked';
  readonly findings: readonly PrivacyFinding[];
  readonly unscannedAssetHashes: readonly string[];
  readonly blockedAssetHashes: readonly string[];
}

export interface PublicationPrivacyDecision extends PublicationPrivacyGate {
  readonly overrideUsed: boolean;
}

export interface PixelMask {
  readonly rect: NormalizedRect;
  readonly mode: 'opaque';
  readonly color?: readonly [number, number, number, number];
}

export type { PrivacyCategory, PrivacyFinding, PrivacySeverity, Scene };
