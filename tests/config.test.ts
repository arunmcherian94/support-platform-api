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
      requestBudgetMs: 10_000,
      entitlementRefreshSeconds: 900,
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
    [{ MOCKS_URL: 'nope' }, /MOCKS_URL must be an http\(s\) URL/],
    [{ NOW: 'yesterday' }, /NOW must be an RFC 3339 timestamp/],
    [{ REQUEST_BUDGET_MS: '50' }, /REQUEST_BUDGET_MS must be between/],
    [{ ENTITLEMENT_REFRESH_SECONDS: '0' }, /ENTITLEMENT_REFRESH_SECONDS must be between/],
    [{ NODE_ENV: 'production' }, /ISSUER_URL is required when NODE_ENV=production/],
    [{ NODE_ENV: 'production', ISSUER_URL: 'https://idp.example' }, /AUDIENCE is required/],
  ])('rejects %j naming the variable', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('refuses the dev issuer in production (S2-12)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_ISSUER: 'true' })).toThrow(
      /DEV_ISSUER must not be true when NODE_ENV=production/,
    );
    expect(
      loadConfig({ NODE_ENV: 'production', ISSUER_URL: 'https://idp.example', AUDIENCE: 'api' })
        .devIssuer,
    ).toBe(false);
  });
});
