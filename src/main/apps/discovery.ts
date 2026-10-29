import path from 'node:path';
import type { DiscoveredApp, ProcessInfo } from '../../shared/types';

export function exeNameForPath(exePath: string): string {
  return path.basename(exePath);
}

export async function discoverInstalledApps(): Promise<DiscoveredApp[]> {
  return [];
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  return [];
}

export async function listProcessesForExecutable(_exePath: string): Promise<ProcessInfo[]> {
  return [];
}

export async function closeProcesses(_pids: number[], _gracefulWaitMs?: number): Promise<void> {
  // Implemented by the apps owner.
}
