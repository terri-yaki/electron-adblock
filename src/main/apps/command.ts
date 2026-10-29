import { execFile } from 'node:child_process';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const POWERSHELL_FLAGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
];

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

// Runs a child process without a shell and never rejects: callers degrade gracefully.
export function runCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  maxBuffer: number = DEFAULT_MAX_BUFFER,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          timeout: Math.max(1000, timeoutMs),
          maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
          });
        },
      );
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' });
    }
  });
}

export function runPowerShell(script: string, timeoutMs: number): Promise<CommandResult> {
  return runCommand('powershell.exe', [...POWERSHELL_FLAGS, script], timeoutMs);
}

// Produces a Windows PowerShell single-quoted literal.
export function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
