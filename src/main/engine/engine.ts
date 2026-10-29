import type {
  AdCandidate,
  DebugEndpointInfo,
  Engine,
  EngineOptions,
} from '../../shared/types';

// Implemented by the engine owner. This stub keeps the app buildable.
export function createEngine(_options: EngineOptions): Engine {
  throw new Error('engine: not implemented yet');
}

export async function probeDebugEndpoint(
  _port: number,
  _timeoutMs?: number,
): Promise<DebugEndpointInfo | null> {
  return null;
}
