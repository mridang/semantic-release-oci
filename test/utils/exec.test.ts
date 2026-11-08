import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { execFileSync } from 'node:child_process';

const execFileSyncMock = jest.fn<typeof execFileSync>();

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { ExecError, run } = await import('../../src/utils/exec.js');

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue('out');
});

describe('run', () => {
  it('runs the program with the args as an argv array and returns stdout', () => {
    expect(run('docker', ['build', 'a b; c'])).toBe('out');
    expect(execFileSyncMock.mock.calls[0][0]).toBe('docker');
    expect(execFileSyncMock.mock.calls[0][1]).toEqual(['build', 'a b; c']);
    expect(execFileSyncMock.mock.calls[0][2]).not.toHaveProperty('shell');
  });

  it('passes the working directory, environment, input and timeout', () => {
    run('docker', ['login'], {
      cwd: '/work',
      env: { A: 'b' },
      input: 'secret',
      timeout: 1234,
    });

    expect(execFileSyncMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        cwd: '/work',
        env: { A: 'b' },
        input: 'secret',
        timeout: 1234,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('allows far more output than the default 1 MiB buffer', () => {
    run('docker', ['build']);

    expect(execFileSyncMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 }),
    );
  });

  it('returns an empty string when the output is not text', () => {
    execFileSyncMock.mockReturnValue(Buffer.from('binary'));

    expect(run('docker', ['build'])).toBe('');
  });

  it('rethrows a failure as an ExecError that keeps code, status and signal', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: docker pull'), {
        code: 'EFAIL',
        status: 3,
        signal: 'SIGTERM',
        stderr: 'denied for https://user:pw0rd@host/x',
      });
    });

    expect(() => run('docker', ['pull'])).toThrow(
      expect.objectContaining({
        name: 'ExecError',
        code: 'EFAIL',
        status: 3,
        signal: 'SIGTERM',
        stderr: 'denied for https://***@host/x',
      }),
    );
  });

  it('redacts credentials in the message of the error', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command failed: git clone https://user:pw0rd@host/x');
    });

    expect(() => run('git', ['clone'])).toThrow(
      'Command failed: git clone https://***@host/x',
    );
  });

  it('describes a thrown value that is not an error', () => {
    execFileSyncMock.mockImplementation(() => {
      throw 'plain';
    });

    const thrown = (() => {
      try {
        return run('docker', ['pull']);
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(ExecError);
    expect(thrown).toEqual(
      expect.objectContaining({
        message: 'plain',
        code: undefined,
        stderr: undefined,
      }),
    );
  });
});
