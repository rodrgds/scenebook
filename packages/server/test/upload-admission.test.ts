import { describe, expect, it } from 'vitest';

import { UploadAdmissionController } from '../src/upload-admission.js';

describe('upload admission', () => {
  const limits = {
    maxConcurrentObjectsPerTenant: 2,
    maxConcurrentObjectsGlobal: 3,
    maxConcurrentBytesPerTenant: 10,
    maxConcurrentBytesGlobal: 15,
  };

  it('enforces tenant and global object concurrency with idempotent release', () => {
    const admission = new UploadAdmissionController(limits);
    const first = admission.acquire('tenant-a', 4);
    const second = admission.acquire('tenant-a', 4);
    expect(() => admission.acquire('tenant-a', 1)).toThrow('tenant concurrent upload objects');
    const third = admission.acquire('tenant-b', 4);
    expect(() => admission.acquire('tenant-c', 1)).toThrow('global concurrent upload objects');
    expect(first.release()).toMatchObject({ globalObjects: 2, globalBytes: 8 });
    expect(first.release()).toMatchObject({ globalObjects: 2, globalBytes: 8 });
    second.release();
    third.release();
    expect(admission.snapshot('tenant-a')).toEqual({
      globalObjects: 0,
      globalBytes: 0,
      tenantObjects: 0,
      tenantBytes: 0,
    });
  });

  it('reserves declared active bytes before accepting a stream', () => {
    const admission = new UploadAdmissionController(limits);
    const first = admission.acquire('tenant-a', 7);
    expect(() => admission.acquire('tenant-a', 4)).toThrow('tenant concurrent upload bytes');
    admission.acquire('tenant-b', 8);
    expect(() => admission.acquire('tenant-c', 1)).toThrow('global concurrent upload bytes');
    first.release();
  });
});
