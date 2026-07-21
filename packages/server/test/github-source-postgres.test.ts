import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { GitHubSourceChangeRecord } from '../src/domain.js';
import { PostgresControlPlaneRepository } from '../src/postgres.js';

const databaseUrl = process.env.SCENEBOOK_TEST_POSTGRES_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgreSQL GitHub App source integration', () => {
  const repository = new PostgresControlPlaneRepository(databaseUrl!);

  afterAll(async () => repository.close());

  it('binds one active installation and serializes idempotent source-change leases', async () => {
    const now = '2026-07-21T09:00:00.000Z';
    const suffix = randomUUID().slice(0, 8);
    const workspaceId = `workspace-github-${suffix}`;
    const projectId = `project-github-${suffix}`;
    const repositoryBindingId = `repository-github-${suffix}`;
    const installationBindingId = `installation-github-${suffix}`;
    const changeId = `github-change-${suffix}`;
    await repository.createWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'GitHub source',
      now,
    });
    await repository.createProject({
      id: projectId,
      workspaceId,
      slug: projectId,
      name: 'GitHub source',
      now,
    });
    await repository.bindRepository({
      id: repositoryBindingId,
      workspaceId,
      projectId,
      repository: 'acme/product',
      workflowRefPattern: '*',
      createdAt: now,
    });
    const installation = await repository.putGitHubInstallationBinding({
      id: installationBindingId,
      workspaceId,
      projectId,
      repositoryBindingId,
      installationId: '123456',
      githubRepositoryId: '987654',
      defaultBranch: 'main',
      createdBy: 'owner-1',
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    let activeChecks = 0;
    let maximumActiveChecks = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        repository.withGitHubCheckRunLock(
          `${installation.id}\0acme/product\0${'a'.repeat(40)}\0build`,
          async () => {
            activeChecks += 1;
            maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
            await new Promise((resolve) => setTimeout(resolve, 10));
            activeChecks -= 1;
          },
        ),
      ),
    );
    expect(maximumActiveChecks).toBe(1);
    const record: GitHubSourceChangeRecord = {
      id: changeId,
      workspaceId,
      projectId,
      installationBindingId: installation.id,
      idempotencyKey: changeId,
      requestHash: 'a'.repeat(64),
      status: 'pending',
      path: 'scenes/invite/scene.yaml',
      baseCommitSha: 'b'.repeat(40),
      baseBlobSha: 'c'.repeat(40),
      patchHash: 'd'.repeat(64),
      branch: `scenebook/${changeId}`,
      title: 'Repair invite locator',
      createReviewIssue: true,
      evidenceBinding: {},
      createdBy: 'owner-1',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    const claims = await Promise.all([
      repository.claimGitHubSourceChange({
        record,
        leaseId: 'lease-github-source-a',
        leaseDurationMs: 5_000,
      }),
      repository.claimGitHubSourceChange({
        record,
        leaseId: 'lease-github-source-b',
        leaseDurationMs: 5_000,
      }),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const winner = claims.find((claim) => claim.claimed)!;
    await expect(
      repository.renewGitHubSourceChangeLease({
        workspaceId,
        projectId,
        changeId,
        leaseId: 'not-the-winning-lease',
        leaseDurationMs: 5_000,
      }),
    ).rejects.toThrow(/lease was lost/u);
    await expect(
      repository.renewGitHubSourceChangeLease({
        workspaceId,
        projectId,
        changeId,
        leaseId: winner.record.leaseId!,
        leaseDurationMs: 5_000,
      }),
    ).resolves.toMatchObject({ leaseId: winner.record.leaseId });
    const completed = await repository.completeGitHubSourceChange({
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      changeId: record.id,
      leaseId: winner.record.leaseId!,
      result: {
        headCommitSha: 'e'.repeat(40),
        headBlobSha: 'f'.repeat(40),
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/acme/product/pull/42',
        issueNumber: 43,
        issueUrl: 'https://github.com/acme/product/issues/43',
      },
    });
    expect(completed).toMatchObject({ status: 'succeeded', attempts: 1, pullRequestNumber: 42 });
    await expect(
      repository.claimGitHubSourceChange({
        record: { ...record, requestHash: '9'.repeat(64) },
        leaseId: 'lease-github-source-conflict',
        leaseDurationMs: 5_000,
      }),
    ).rejects.toThrow(/idempotency conflict/u);

    const expiringRecord: GitHubSourceChangeRecord = {
      ...record,
      id: `${changeId}-expiry`,
      idempotencyKey: `${changeId}-expiry`,
      branch: `scenebook/${changeId}-expiry`,
    };
    const expiringClaim = await repository.claimGitHubSourceChange({
      record: expiringRecord,
      leaseId: 'lease-github-source-expired',
      leaseDurationMs: 40,
    });
    expect(expiringClaim.claimed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(
      repository.renewGitHubSourceChangeLease({
        workspaceId,
        projectId,
        changeId: expiringRecord.id,
        leaseId: 'lease-github-source-expired',
        leaseDurationMs: 5_000,
      }),
    ).rejects.toThrow(/lease was lost/u);
    const completedResult = {
      headCommitSha: '1'.repeat(40),
      headBlobSha: '2'.repeat(40),
      pullRequestNumber: 44,
      pullRequestUrl: 'https://github.com/acme/product/pull/44',
    } as const;
    await expect(
      repository.completeGitHubSourceChange({
        workspaceId,
        projectId,
        changeId: expiringRecord.id,
        leaseId: 'lease-github-source-expired',
        result: completedResult,
      }),
    ).rejects.toThrow(/lease was lost/u);
    const reclaims = await Promise.all([
      repository.claimGitHubSourceChange({
        record: expiringRecord,
        leaseId: 'lease-github-source-reclaimer-a',
        leaseDurationMs: 5_000,
      }),
      repository.claimGitHubSourceChange({
        record: expiringRecord,
        leaseId: 'lease-github-source-reclaimer-b',
        leaseDurationMs: 5_000,
      }),
    ]);
    expect(reclaims.filter((claim) => claim.claimed)).toHaveLength(1);
    const reclaimer = reclaims.find((claim) => claim.claimed)!;
    await expect(
      repository.completeGitHubSourceChange({
        workspaceId,
        projectId,
        changeId: expiringRecord.id,
        leaseId: reclaimer.record.leaseId!,
        result: completedResult,
      }),
    ).resolves.toMatchObject({ status: 'succeeded', attempts: 2 });

    await expect(
      repository.revokeGitHubInstallationBinding({
        workspaceId: installation.workspaceId,
        projectId: installation.projectId,
        bindingId: installation.id,
        expectedVersion: 99,
        now: '2026-07-21T09:05:00.000Z',
      }),
    ).rejects.toThrow(/version conflict/u);
    await expect(
      repository.revokeGitHubInstallationBinding({
        workspaceId: installation.workspaceId,
        projectId: installation.projectId,
        bindingId: installation.id,
        expectedVersion: 1,
        now: '2026-07-21T09:05:00.000Z',
      }),
    ).resolves.toMatchObject({ version: 2, revokedAt: '2026-07-21T09:05:00.000Z' });
  });
});
