import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
}

const nativeClose = HTMLDialogElement.prototype.close;
HTMLDialogElement.prototype.close = function close(returnValue?: string) {
  if (nativeClose) nativeClose.call(this, returnValue);
  else {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  }
};
