import type { AppView } from '../../shared/types';
import type { Controller } from './context';

export interface TabView {
  el: HTMLElement;
  update(app: AppView): void;
}

export type TabFactory = (ctx: Controller, app: AppView) => TabView;