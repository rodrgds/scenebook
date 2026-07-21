export interface UploadConcurrencyLimits {
  readonly maxConcurrentObjectsPerTenant: number;
  readonly maxConcurrentObjectsGlobal: number;
  readonly maxConcurrentBytesPerTenant: number;
  readonly maxConcurrentBytesGlobal: number;
}

export interface UploadAdmissionSnapshot {
  readonly globalObjects: number;
  readonly globalBytes: number;
  readonly tenantObjects: number;
  readonly tenantBytes: number;
}

export class UploadAdmissionError extends Error {
  constructor(
    readonly scope: 'tenant' | 'global',
    readonly resource: 'objects' | 'bytes',
  ) {
    super(`${scope} concurrent upload ${resource} quota is exhausted`);
    this.name = 'UploadAdmissionError';
  }
}

interface ActiveTenant {
  objects: number;
  bytes: number;
}

export class UploadAdmissionController {
  private globalObjects = 0;
  private globalBytes = 0;
  private readonly tenants = new Map<string, ActiveTenant>();

  constructor(readonly limits: UploadConcurrencyLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  acquire(
    tenantId: string,
    bytes: number,
  ): { readonly snapshot: UploadAdmissionSnapshot; release(): UploadAdmissionSnapshot } {
    if (!tenantId || tenantId.length > 200) throw new TypeError('Invalid upload tenant ID');
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new RangeError('Upload byte reservation must be a positive safe integer');
    const tenant = this.tenants.get(tenantId) ?? { objects: 0, bytes: 0 };
    if (tenant.objects + 1 > this.limits.maxConcurrentObjectsPerTenant) {
      throw new UploadAdmissionError('tenant', 'objects');
    }
    if (tenant.bytes + bytes > this.limits.maxConcurrentBytesPerTenant) {
      throw new UploadAdmissionError('tenant', 'bytes');
    }
    if (this.globalObjects + 1 > this.limits.maxConcurrentObjectsGlobal) {
      throw new UploadAdmissionError('global', 'objects');
    }
    if (this.globalBytes + bytes > this.limits.maxConcurrentBytesGlobal) {
      throw new UploadAdmissionError('global', 'bytes');
    }
    tenant.objects += 1;
    tenant.bytes += bytes;
    this.globalObjects += 1;
    this.globalBytes += bytes;
    this.tenants.set(tenantId, tenant);
    let released = false;
    return {
      snapshot: this.snapshot(tenantId),
      release: () => {
        if (released) return this.snapshot(tenantId);
        released = true;
        tenant.objects -= 1;
        tenant.bytes -= bytes;
        this.globalObjects -= 1;
        this.globalBytes -= bytes;
        if (tenant.objects === 0) this.tenants.delete(tenantId);
        return this.snapshot(tenantId);
      },
    };
  }

  snapshot(tenantId: string): UploadAdmissionSnapshot {
    const tenant = this.tenants.get(tenantId) ?? { objects: 0, bytes: 0 };
    return {
      globalObjects: this.globalObjects,
      globalBytes: this.globalBytes,
      tenantObjects: tenant.objects,
      tenantBytes: tenant.bytes,
    };
  }
}
