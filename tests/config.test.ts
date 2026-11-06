import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config (S2-9)', () => {
  it('has working defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 8080,
      responseValidation: 'strict',
      devIssuer: false,
      issuerUrl: 'http://127.0.0.1:8080/dev',
      audience: 'support-platform-api',
      rateLimit: { clientPerMinute: 100, agentPerMinute: 30 },
    });
  });

  it.each([
    [{ PORT: 'eighty' }, /PORT must be an integer/],
    [{ PORT: '70000' }, /PORT must be between/],
    [{ ISSUER_URL: 'not a url' }, /ISSUER_URL must be an http\(s\) URL/],
    [{ CASES_URL: 'ftp://x' }, /CASES_URL must be an http\(s\) URL/],
    [{ RESPONSE_VALIDATION: 'maybe' }, /RESPONSE_VALIDATION must be one of strict, log/],
    [{ DEV_ISSUER: 'yes' }, /DEV_ISSUER must be true or false/],
    [{ LOG_LEVEL: 'loud' }, /LOG_LEVEL must be one of/],
  ])('rejects %j naming the variable', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('refuses the dev issuer in production (S2-12)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_ISSUER: 'true' })).toThrow(
      /DEV_ISSUER must not be true when NODE_ENV=production/,
    );
    expect(loadConfig({ NODE_ENV: 'production' }).devIssuer).toBe(false);
  });
});
