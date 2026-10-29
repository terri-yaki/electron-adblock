import { h } from './dom';
import { icon, type IconName } from './icons';
import type { ToastLevel } from './context';

export interface ToastHost {
  show(level: ToastLevel, message: string): void;
}

const ICONS: Record<ToastLevel, IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert',
};

const MAX_TOASTS = 4;
const DURATION_MS = 4400;

export function createToastHost(container: HTMLElement): ToastHost {
  container.classList.add('toast-host');
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-atomic', 'false');

  function dismiss(toast: HTMLElement): void {
    if (toast.dataset.leaving === '1') return;
    toast.dataset.leaving = '1';
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 160);
  }

  function show(level: ToastLevel, message: string): void {
    while (container.children.length >= MAX_TOASTS) {
      container.firstElementChild?.remove();
    }
    const toast = h(
      'div',
      { class: 'toast toast-' + level },
      h('span', { class: 'toast-icon' }, icon(ICONS[level], 15)),
      h('span', { class: 'toast-message', text: message }),
      h(
        'button',
        {
          class: 'toast-close',
          type: 'button',
          'aria-label': 'Dismiss notification',
          title: 'Dismiss',
          onclick: () => dismiss(toast),
        },
        icon('x', 12),
      ),
    );
    container.append(toast);
    let timer = window.setTimeout(() => dismiss(toast), DURATION_MS);
    toast.addEventListener('mouseenter', () => window.clearTimeout(timer));
    toast.addEventListener('mouseleave', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => dismiss(toast), 1800);
    });
  }

  return { show };
}
