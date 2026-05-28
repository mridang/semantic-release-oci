import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { execSync } from 'child_process';

const execSyncMock = jest.fn<typeof execSync>();

jest.unstable_mockModule('child_process', () => ({
  execSync: execSyncMock,
}));

const { commandRunner } = await import('../../src/lib/command-runner.js');

function makeLogger() {
  return { log: jest.fn(), error: jest.fn() };
}

describe('commandRunner.exec', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('build output\n');
  });

  afterEach(() => {
    execSyncMock.mockReset();
  });

  it('should join args into a "docker <args>" command string', () => {
    const logger = makeLogger();

    commandRunner.exec(['build', '--quiet'], { cwd: '/work' }, logger);

    expect(execSyncMock.mock.calls[0][0]).toBe('docker build --quiet');
  });

  it('should pass cwd, input, and timeout through to execSync', () => {
    const logger = makeLogger();

    commandRunner.exec(
      ['login', '--password-stdin'],
      { cwd: '/work', input: 'secret', timeout: 1234 },
      logger,
    );

    expect(execSyncMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        cwd: '/work',
        input: 'secret',
        timeout: 1234,
      }),
    );
  });

  it('should default the timeout when none is provided', () => {
    const logger = makeLogger();

    commandRunner.exec(['version'], { cwd: '/work' }, logger);

    expect(execSyncMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: 600_000 }),
    );
  });

  it('should use inherit stdio when requested', () => {
    const logger = makeLogger();

    commandRunner.exec(
      ['push', 'repo:tag'],
      { cwd: '/work', stdio: 'inherit' },
      logger,
    );

    expect(execSyncMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('should use piped stdio by default', () => {
    const logger = makeLogger();

    commandRunner.exec(['build'], { cwd: '/work' }, logger);

    expect(execSyncMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('should return the execSync stdout', () => {
    const logger = makeLogger();

    const result = commandRunner.exec(['build'], { cwd: '/work' }, logger);

    expect(result).toBe('build output\n');
  });

  it('should return an empty string when execSync returns non-string output', () => {
    const logger = makeLogger();
    execSyncMock.mockReturnValue(Buffer.from('binary'));

    const result = commandRunner.exec(['build'], { cwd: '/work' }, logger);

    expect(result).toBe('');
  });

  it('should log the executed command', () => {
    const logger = makeLogger();

    commandRunner.exec(['version'], { cwd: '/work' }, logger);

    expect(logger.log).toHaveBeenCalledWith('Executing: docker version');
  });
});
