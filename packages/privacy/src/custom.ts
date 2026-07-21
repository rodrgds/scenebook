import safeRegex from 'safe-regex2';

import type { PrivacyCategory, PrivacySeverity } from '@scenebook/schema';

import type { PrivacyRule } from './types.js';

export interface PrivacyRuleConfiguration {
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly category: PrivacyCategory;
  readonly severity: PrivacySeverity;
  readonly minConfidence: number;
}

/** Compile project rules once, rejecting patterns with unsafe repetition structure. */
export function compilePrivacyRuleConfigurations(
  configurations: readonly PrivacyRuleConfiguration[],
): PrivacyRule[] {
  return configurations.map((configuration) => {
    if (!safeRegex(configuration.pattern)) {
      throw new TypeError(
        `Privacy rule ${configuration.id} is potentially unsafe and was not compiled`,
      );
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(configuration.pattern, configuration.flags);
    } catch (error) {
      throw new TypeError(`Privacy rule ${configuration.id} is not a valid regular expression`, {
        cause: error,
      });
    }
    return {
      id: configuration.id,
      category: configuration.category,
      severity: configuration.severity,
      confidence: configuration.minConfidence,
      pattern,
      message: `Custom privacy rule ${configuration.id} matched`,
    };
  });
}
