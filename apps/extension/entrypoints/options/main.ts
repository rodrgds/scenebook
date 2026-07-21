import { DEFAULT_STUDIO_URL, normalizeStudioUrl, STUDIO_URL_KEY } from '../../src/studio-url';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const input = document.querySelector<HTMLInputElement>('#studio-url')!;
const status = document.querySelector<HTMLElement>('#status')!;

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(STUDIO_URL_KEY);
  input.value =
    typeof stored[STUDIO_URL_KEY] === 'string' ? stored[STUDIO_URL_KEY] : DEFAULT_STUDIO_URL;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.dataset.kind = '';
  try {
    const normalized = normalizeStudioUrl(input.value);
    await chrome.storage.local.set({ [STUDIO_URL_KEY]: normalized });
    input.value = normalized;
    status.textContent = 'Studio connection saved.';
    status.dataset.kind = 'success';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Studio URL is invalid.';
    input.focus();
  }
});

document.querySelector('#reset')!.addEventListener('click', async () => {
  await chrome.storage.local.remove(STUDIO_URL_KEY);
  input.value = DEFAULT_STUDIO_URL;
  status.textContent = 'Using the self-hosted default.';
  status.dataset.kind = 'success';
});

void load();
