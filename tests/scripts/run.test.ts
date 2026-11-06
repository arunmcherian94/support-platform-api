import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHttp } from '../../scripts/run.js';

describe('waitForHttp', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('resolves true once the endpoint answers', async () => {
    const listening = createServer((_req, res) => res.end('{}'));
    server = listening;
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    const { port } = listening.address() as AddressInfo;
    expect(await waitForHttp(`http://127.0.0.1:${port}/`, { attempts: 5, intervalMs: 10 })).toBe(
      true,
    );
  });

  it('gives up after the attempt limit when nothing listens', async () => {
    expect(await waitForHttp('http://127.0.0.1:1/', { attempts: 3, intervalMs: 5 })).toBe(false);
  });
});
