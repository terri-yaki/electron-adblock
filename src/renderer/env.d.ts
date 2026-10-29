import type { AdblockApi } from '../shared/types';

declare global {
  interface Window {
    adblock: AdblockApi;
  }
}

export {};
