import { sha256 } from '@scenebook/core';

import type {
  VerificationFreshness,
  VerificationJobRecord,
  VerificationScheduleRecord,
} from './domain.js';

export function scheduledJobIdentity(
  scheduleId: string,
  dueAt: string,
): Pick<VerificationJobRecord, 'id' | 'idempotencyKey'> & { readonly expectedBuildId: string } {
  const digest = sha256(`scheduled-verification\0${scheduleId}\0${dueAt}`);
  return {
    id: `job-${digest.slice(0, 40)}`,
    idempotencyKey: `due:${dueAt}`,
    expectedBuildId: `build-${digest.slice(0, 40)}`,
  };
}

export function manualJobIdentity(
  scheduleId: string,
  idempotencyKey: string,
): Pick<VerificationJobRecord, 'id'> & { readonly expectedBuildId: string } {
  const digest = sha256(`manual-verification\0${scheduleId}\0${idempotencyKey}`);
  return {
    id: `job-${digest.slice(0, 40)}`,
    expectedBuildId: `build-${digest.slice(0, 40)}`,
  };
}

export function scheduleFreshness(
  schedule: VerificationScheduleRecord,
  now: Date,
): VerificationFreshness {
  const last = schedule.lastSuccessfulAt ? new Date(schedule.lastSuccessfulAt) : undefined;
  const staleAt = new Date(
    (last?.getTime() ?? new Date(schedule.createdAt).getTime()) +
      schedule.freshnessTargetSeconds * 1_000,
  );
  let status: VerificationFreshness['status'];
  if (!last) status = 'never-verified';
  else if (now.getTime() >= staleAt.getTime()) status = 'stale';
  else {
    const warningAt = staleAt.getTime() - Math.min(schedule.intervalSeconds * 1_000, 86_400_000);
    status = now.getTime() >= warningAt ? 'due-soon' : 'fresh';
  }
  const result: VerificationFreshness = {
    status,
    targetSeconds: schedule.freshnessTargetSeconds,
    staleAt: staleAt.toISOString(),
  };
  if (last) return { ...result, lastSuccessfulAt: last.toISOString() };
  return result;
}

export function nextScheduleOccurrence(
  previousDueAt: string,
  now: string,
  intervalSeconds: number,
): string {
  return new Date(
    Math.max(new Date(previousDueAt).getTime(), new Date(now).getTime()) + intervalSeconds * 1_000,
  ).toISOString();
}
