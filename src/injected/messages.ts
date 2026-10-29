// Report messages sent to the host through the CDP binding function.
import type { LayoutReport, PickReport } from '../shared/types';

export interface ReadyMessage {
  type: 'ready';
}

export interface PickMessage {
  type: 'pick';
  payload: PickReport;
}

export interface PickerStateMessage {
  type: 'picker-state';
  active: boolean;
  picked: number;
}

export interface HiddenMessage {
  type: 'hidden';
  count: number;
}

export interface LayoutMessage {
  type: 'layout';
  payload: LayoutReport;
}

export interface LayoutEditorMessage {
  type: 'layout-editor';
  active: boolean;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type InjectedMessage =
  | ReadyMessage
  | PickMessage
  | PickerStateMessage
  | HiddenMessage
  | LayoutMessage
  | LayoutEditorMessage
  | ErrorMessage;

export type ReportFn = (message: InjectedMessage) => void;
