import type { ProcessInfo } from '../../shared/types';

export async function allocateDebugPort(_preferred?: number): Promise<number> {
  throw new Error('launcher: not implemented yet');
}

export async function launchExecutable(
  _exePath: string,
  _args: string[],
  _debugPort: number,
): Promise<number> {
  throw new Error('launcher: not implemented yet');
}

export async function waitForDebugEndpoint(_port: number, _timeoutMs?: number): Promise<boolean> {
  return false;
}

export async function findDebugPortForApp(_exePath: string): Promise<number | null> {
  return null;
}

export async function processesForExecutable(_exePath: string): Promise<ProcessInfo[]> {
  return [];
}
