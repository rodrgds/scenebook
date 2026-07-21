import { createHmac, randomBytes } from 'node:crypto';

export class RunnerTokenService {
  constructor(private readonly secret: string) {
    if (secret.length < 32)
      throw new Error('Runner-token secret must contain at least 32 characters');
  }

  private digest(value: string): string {
    return createHmac('sha256', this.secret)
      .update('verification-runner-token')
      .update('\0')
      .update(value)
      .digest('hex');
  }

  create(id: string): { readonly token: string; readonly tokenHash: string } {
    const token = `sbk_runner.${id}.${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: this.digest(token) };
  }

  id(token: string): string | undefined {
    const match = /^sbk_runner\.([A-Za-z0-9][A-Za-z0-9_-]{0,199})\.[A-Za-z0-9_-]{43}$/u.exec(token);
    return match?.[1];
  }

  hash(token: string): string {
    return this.digest(token);
  }
}
