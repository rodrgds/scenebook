const DIALOG_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusTargets(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)].filter((element) => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (
        current.hidden ||
        current.getAttribute('aria-hidden') === 'true' ||
        style?.display === 'none' ||
        style?.visibility === 'hidden'
      )
        return false;
      if (current === dialog) break;
    }
    return true;
  });
}

export function trapDialogFocus(event: KeyboardEvent, dialog?: HTMLDialogElement): void {
  if (event.key !== 'Tab' || !dialog?.open) return;

  const targets = visibleFocusTargets(dialog);
  if (targets.length === 0) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const first = targets[0]!;
  const last = targets.at(-1)!;
  const active = dialog.ownerDocument.activeElement;
  const focusOutside = !active || active === dialog || !dialog.contains(active);

  if (event.shiftKey ? active === first || focusOutside : active === last || focusOutside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}
