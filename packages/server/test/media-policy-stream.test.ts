import { describe, expect, it } from 'vitest';

import { MAX_BUFFERED_TEXT_OBJECT_BYTES, ObjectMediaStreamValidator } from '../src/media-policy.js';

describe('incremental object media validation', () => {
  it('keeps large binary validation memory bounded independently of object size', () => {
    const length = 32 * 1024 * 1024;
    const validator = new ObjectMediaStreamValidator('application/zip', length);
    validator.write(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]));
    const chunk = new Uint8Array(64 * 1024);
    for (let written = 4; written < length;) {
      const size = Math.min(chunk.byteLength, length - written);
      validator.write(chunk.subarray(0, size));
      written += size;
      expect(validator.bufferedByteLength).toBeLessThanOrEqual(5_120);
    }
    validator.finish();
  });

  it('places an explicit hard bound on buffered structured text', () => {
    expect(
      () => new ObjectMediaStreamValidator('application/json', MAX_BUFFERED_TEXT_OBJECT_BYTES + 1),
    ).toThrow(`may not exceed ${MAX_BUFFERED_TEXT_OBJECT_BYTES} bytes`);
  });

  it('rejects MIME-spoofed content across chunk boundaries', () => {
    const bytes = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const validator = new ObjectMediaStreamValidator('text/plain', bytes.byteLength);
    validator.write(bytes.subarray(0, 7));
    validator.write(bytes.subarray(7));
    expect(() => validator.finish()).toThrow('do not match the declared safe media type');
  });

  it('keeps active publication formats outside the object allowlist', () => {
    for (const mediaType of [
      'text/html',
      'text/css',
      'text/javascript',
      'application/javascript',
      'image/svg+xml',
    ]) {
      expect(() => new ObjectMediaStreamValidator(mediaType, 1)).toThrow(
        `Object media type is not allowed: ${mediaType}`,
      );
    }
  });
});
