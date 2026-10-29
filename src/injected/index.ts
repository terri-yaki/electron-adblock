// Placeholder content script. The injected-script owner replaces this file.
interface InjectedWindow {
  __electronAdblock?: {
    apply: (payload: unknown) => void;
    startPicker: (options?: unknown) => void;
    stopPicker: () => void;
    scan: () => unknown[];
  };
}

const injectedWindow = window as unknown as InjectedWindow;

injectedWindow.__electronAdblock = {
  apply: () => {},
  startPicker: () => {},
  stopPicker: () => {},
  scan: () => [],
};

export {};
