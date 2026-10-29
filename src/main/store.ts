import { createDefaultState } from '../shared/defaults';
import type { PersistedState } from '../shared/types';

export class AppStore {
  data: PersistedState;

  constructor(readonly dir: string) {
    this.data = createDefaultState();
  }

  async load(): Promise<void> {
    // Implemented by the apps owner.
  }

  async save(): Promise<void> {
    // Implemented by the apps owner.
  }
}
