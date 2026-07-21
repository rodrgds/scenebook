import { DEFAULT_STUDIO_URL, normalizeStudioUrl, STUDIO_URL_KEY } from '../../src/studio-url';

type StatusKind = 'error' | 'info' | 'success';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const input = document.querySelector<HTMLInputElement>('#studio-url')!;
const status = document.querySelector<HTMLElement>('#status')!;
const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;

function setStatus(message = '', kind: StatusKind = 'info'): void {
  status.textContent = message;
  status.dataset.kind = message ? kind : '';
  status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  status.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  submit.disabled = busy;
  reset.disabled = busy;
  for (const candidate of [submit, reset]) {
    if (busy && candidate === button) candidate.setAttribute('aria-busy', 'true');
    else candidate.removeAttribute('aria-busy');
  }
  form.setAttribute('aria-busy', String(busy));
}

async function load(): Promise<void> {
  submit.disabled = true;
  reset.disabled = true;
  form.setAttribute('aria-busy', 'true');
  setStatus('Loading the saved connection…', 'info');
  try {
    const stored = await chrome.storage.local.get(STUDIO_URL_KEY);
    input.value =
      typeof stored[STUDIO_URL_KEY] === 'string' ? stored[STUDIO_URL_KEY] : DEFAULT_STUDIO_URL;
    setStatus();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : 'The saved Studio connection could not be loaded.',
      'error',
    );
  } finally {
    submit.disabled = false;
    reset.disabled = false;
    form.setAttribute('aria-busy', 'false');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  setBusy(submit, true);
  setStatus('Saving the Studio connection…', 'info');
  input.removeAttribute('aria-invalid');
  try {
    const normalized = normalizeStudioUrl(input.value);
    await chrome.storage.local.set({ [STUDIO_URL_KEY]: normalized });
    input.value = normalized;
    setStatus('Studio connection saved.', 'success');
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    setStatus(error instanceof Error ? error.message : 'Studio URL is invalid.', 'error');
    input.focus();
  } finally {
    setBusy(submit, false);
  }
});

reset.addEventListener('click', async () => {
  if (reset.disabled) return;
  setBusy(reset, true);
  setStatus('Restoring the default connection…', 'info');
  try {
    await chrome.storage.local.remove(STUDIO_URL_KEY);
    input.value = DEFAULT_STUDIO_URL;
    input.removeAttribute('aria-invalid');
    setStatus('Using the self-hosted default.', 'success');
    input.focus();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : 'The default connection could not be restored.',
      'error',
    );
  } finally {
    setBusy(reset, false);
  }
});

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  if (status.dataset.kind === 'error') setStatus();
});

void load();
