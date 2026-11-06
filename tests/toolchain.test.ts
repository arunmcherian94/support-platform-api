import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

// Guards the runtime floor declared in package.json "engines" (ADR-0001):
// node:sqlite and the MCP SDK v2 both need Node >= 24.
describe('toolchain', () => {
  it('runs on the Node major declared in engines', () => {
    const floor = Number(/>=(\d+)/.exec(pkg.engines.node)?.[1]);
    const major = Number(process.versions.node.split('.')[0]);
    expect(floor).toBe(24);
    expect(major).toBeGreaterThanOrEqual(floor);
  });
});
