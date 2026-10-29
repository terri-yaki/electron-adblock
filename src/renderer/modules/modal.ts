import { clear, h } from './dom';
import { icon } from './icons';
import { messageOf } from './format';
import { button } from './primitives';

export interface DialogOptions {
  title: string;
  subtitle?: string;
  body: HTMLElement;
  footer?: HTMLElement;
  width?: number;
  onClose?: () => void;
}

export interface DialogHandle {
  readonly el: HTMLElement;
  close(): void;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export interface DialogHost {
  open(options: DialogOptions): DialogHandle;
  confirm(options: ConfirmOptions): void;
  close(): void;
}

let dialogSequence = 0;

export function createDialogHost(container: HTMLElement, inertTarget: HTMLElement): DialogHost {
  let active: {
    overlay: HTMLElement;
    dialog: HTMLElement;
    onClose?: () => void;
    previousFocus: HTMLElement | null;
  } | null = null;

  function focusables(dialog: HTMLElement): HTMLElement[] {
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);
  }

  function close(): void {
    if (!active) return;
    const { overlay, previousFocus } = active;
    active = null;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    inertTarget.removeAttribute('inert');
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const onClose = active.onClose;
      close();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(active.dialog);
    if (items.length === 0) {
      event.preventDefault();
      active.dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (current === first || !active.dialog.contains(current)) {
        event.preventDefault();
        last.focus();
      }
    } else if (current === last || !active.dialog.contains(current)) {
      event.preventDefault();
      first.focus();
    }
  }

  function open(options: DialogOptions): DialogHandle {
    close();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = 'dialog-title-' + String(++dialogSequence);
    const subtitleId = options.subtitle ? 'dialog-subtitle-' + titleId : '';
    const footer = options.footer ?? h('div', { class: 'dialog-actions' }, button({ label: 'Close', variant: 'secondary', onClick: close }));

    const dialog = h(
      'div',
      {
        class: 'dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        'aria-describedby': subtitleId || undefined,
        tabindex: '-1',
        style: 'width:' + String(options.width ?? 480) + 'px',
      },
      h(
        'header',
        { class: 'dialog-head' },
        h(
          'div',
          { class: 'dialog-headings' },
          h('h2', { id: titleId, class: 'dialog-title', text: options.title }),
          options.subtitle ? h('p', { id: subtitleId, class: 'dialog-subtitle', text: options.subtitle }) : null,
        ),
        h(
          'button',
          {
            class: 'icon-btn dialog-close',
            type: 'button',
            'aria-label': 'Close dialog',
            title: 'Close',
            onclick: () => {
              const onClose = options.onClose;
              close();
              onClose?.();
            },
          },
          icon('x', 15),
        ),
      ),
      h('div', { class: 'dialog-body' }, options.body),
      h('footer', { class: 'dialog-footer' }, footer),
    );

    const overlay = h('div', { class: 'dialog-overlay' }, dialog);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target !== overlay) return;
      const onClose = options.onClose;
      close();
      onClose?.();
    });

    container.append(overlay);
    inertTarget.setAttribute('inert', '');
    active = { overlay, dialog, onClose: options.onClose, previousFocus };
    document.addEventListener('keydown', onKeyDown, true);

    window.setTimeout(() => {
      const bodyTarget = dialog.querySelector<HTMLElement>('[data-autofocus]');
      const target = bodyTarget ?? focusables(dialog)[0] ?? dialog;
      target.focus();
    }, 0);

    return {
      el: dialog,
      close: () => {
        const onClose = options.onClose;
        close();
        onClose?.();
      },
    };
  }

  function confirm(options: ConfirmOptions): void {
    const body = h('div', { class: 'confirm-body' }, h('p', { class: 'confirm-message', text: options.message }));
    const footer = h('div', { class: 'dialog-actions' });
    const cancel = button({ label: options.cancelLabel ?? 'Cancel', variant: 'secondary', onClick: () => host.close() });
    const confirmButton = button({
      label: options.confirmLabel,
      variant: options.danger ? 'danger' : 'primary',
      onClick: () => {
        void (async () => {
          confirmButton.disabled = true;
          cancel.disabled = true;
          try {
            await options.onConfirm();
            host.close();
          } catch (error) {
            console.error('dialog action failed', error);
            host.close();
          }
        })();
      },
    });
    confirmButton.dataset.autofocus = 'true';
    footer.append(cancel, confirmButton);
    host.open({ title: options.title, body, footer, width: 440 });
  }

  const host: DialogHost = {
    open,
    confirm,
    close,
  };
  return host;
}
