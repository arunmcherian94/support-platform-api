/**
 * One command for reviewers: starts the mock upstreams, waits until they
 * answer, then starts the API, both at the fixture clock (S2 §2 item 9).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls `url` until it answers 2xx. Bounded by attempts, not by reading the clock. */
export async function waitForHttp(
  url: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const { attempts = 100, intervalMs = 100 } = options;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(intervalMs);
  }
  return false;
}

function start(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [tsx, script], { cwd: root, env, stdio: 'inherit' });
}

function main(): void {
  const env: NodeJS.ProcessEnv = {
    NOW: '2026-11-06T12:00:00Z',
    DEV_ISSUER: 'true',
    ...process.env,
  };
  const mockPort = env.MOCK_PORT ?? '8081';
  const children: ChildProcess[] = [];
  let stopping = false;

  const stopAll = (signal: NodeJS.Signals): void => {
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };
  const watch = (child: ChildProcess): void => {
    child.once('exit', (code, signal) => {
      // The first exit decides the code; the rest are our own shutdown.
      if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
      stopAll('SIGTERM');
      if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit();
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Children get the terminal's SIGINT too; forward SIGTERM so each drains once
      // instead of being killed by a second SIGINT.
      stopAll('SIGTERM');
    });
  }

  const mocks = start('mocks/server.ts', env);
  children.push(mocks);
  watch(mocks);

  void waitForHttp(`http://127.0.0.1:${mockPort}/__admin/faults`).then((ready) => {
    if (stopping) return;
    if (!ready) {
      console.error(`mocks did not answer on :${mockPort} in time`);
      process.exitCode = 1;
      stopAll('SIGTERM');
      return;
    }
    const api = start('src/server.ts', env);
    children.push(api);
    watch(api);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
