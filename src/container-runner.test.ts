import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_API_KEY: '',
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('checkPersonaReadable (persona guard)', () => {
  // Uses real fs (only specific fns are stubbed in the module mock above);
  // access(R_OK) is a no-op for root, so these tests require a non-root uid.
  const asNonRoot = it.skipIf(process.getuid?.() === 0);
  let realFs: typeof import('fs');
  let tmp: string;

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('fs')>('fs');
    tmp = realFs.mkdtempSync('/tmp/persona-guard-test-');
  });

  afterEach(() => {
    realFs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when no CLAUDE.md is wired', async () => {
    const { checkPersonaReadable } = await import('./container-runner.js');
    expect(checkPersonaReadable(tmp, [])).toBeNull();
  });

  it('returns null for a readable regular CLAUDE.md', async () => {
    const { checkPersonaReadable } = await import('./container-runner.js');
    realFs.writeFileSync(`${tmp}/CLAUDE.md`, '# persona');
    expect(checkPersonaReadable(tmp, [])).toBeNull();
  });

  it('translates /workspace symlinks through the mount table', async () => {
    const { checkPersonaReadable } = await import('./container-runner.js');
    realFs.mkdirSync(`${tmp}/repo/agents/kim`, { recursive: true });
    realFs.writeFileSync(`${tmp}/repo/agents/kim/CLAUDE.md`, '# persona');
    realFs.mkdirSync(`${tmp}/group`);
    realFs.symlinkSync(
      '/workspace/extra/patchbox/agents/kim/CLAUDE.md',
      `${tmp}/group/CLAUDE.md`,
    );
    const mounts = [
      {
        hostPath: `${tmp}/repo`,
        containerPath: '/workspace/extra/patchbox',
        readonly: false,
      },
    ];
    expect(checkPersonaReadable(`${tmp}/group`, mounts)).toBeNull();
  });

  asNonRoot(
    'reports an unreadable persona target (the 2026-07 incident class)',
    async () => {
      const { checkPersonaReadable } = await import('./container-runner.js');
      realFs.mkdirSync(`${tmp}/repo`);
      realFs.writeFileSync(`${tmp}/repo/CLAUDE.md`, '# persona');
      realFs.chmodSync(`${tmp}/repo/CLAUDE.md`, 0o000);
      realFs.mkdirSync(`${tmp}/group`);
      realFs.symlinkSync(
        '/workspace/extra/patchbox/CLAUDE.md',
        `${tmp}/group/CLAUDE.md`,
      );
      const mounts = [
        {
          hostPath: `${tmp}/repo`,
          containerPath: '/workspace/extra/patchbox',
          readonly: false,
        },
      ];
      const issue = checkPersonaReadable(`${tmp}/group`, mounts);
      expect(issue).toContain('not readable');
      expect(issue).toContain('EACCES');
    },
  );

  it('reports a symlink with no matching mount (would dangle)', async () => {
    const { checkPersonaReadable } = await import('./container-runner.js');
    realFs.mkdirSync(`${tmp}/group`);
    realFs.symlinkSync(
      '/workspace/extra/unmounted/CLAUDE.md',
      `${tmp}/group/CLAUDE.md`,
    );
    const issue = checkPersonaReadable(`${tmp}/group`, []);
    expect(issue).toContain('matches no configured mount');
  });
});
