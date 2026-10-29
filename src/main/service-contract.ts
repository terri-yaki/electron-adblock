import type { AdblockApi, AppEvent, VersionInfo } from '../shared/types';

export interface ServiceEnv {
  dataDir: string;
  version: VersionInfo;
  devMode: boolean;
  packaged: boolean;
}

export type ServiceMethods = Omit<AdblockApi, 'onEvent' | 'browseForExecutable'>;

export interface ServiceApi extends ServiceMethods {
  init(): Promise<void>;
  dispose(): Promise<void>;
  setEventSink(sink: (event: AppEvent) => void): void;
  getEnv(): ServiceEnv;
}
