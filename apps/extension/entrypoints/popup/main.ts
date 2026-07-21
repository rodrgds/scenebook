import type { RecorderMessage, RecorderResponse, RecorderSession } from '../../src/protocol';

const idle = document.querySelector<HTMLElement>('#idle-view')!;
const active = document.querySelector<HTMLElement>('#active-view')!;
const finished = document.querySelector<HTMLElement>('#finished-view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const titleInput = document.querySelector<HTMLInputElement>('#scene-title')!;

function show(view: 'idle' | 'active' | 'finished', session?: RecorderSession): void {
  idle.hidden = view !== 'idle';
  active.hidden = view !== 'active';
  finished.hidden = view !== 'finished';
  if (session) {
    document.querySelector('#active-title')!.textContent = session.title;
    document.querySelector('#step-count')!.textContent = String(session.steps.length);
    document.querySelector('#finished-title')!.textContent = session.title;
    document.querySelector('#finished-count')!.textContent =
      `${session.steps.length} ${session.steps.length === 1 ? 'step' : 'steps'}`;
  }
}

async function send(message: RecorderMessage): Promise<RecorderResponse> {
  status.textContent = '';
  try {
    return (await chrome.runtime.sendMessage(message)) as RecorderResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The recorder did not respond.',
    };
  }
}

function handle(response: RecorderResponse): boolean {
  if (!response.ok) {
    status.textContent = response.error;
    return false;
  }
  if (response.session?.status === 'recording') show('active', response.session);
  if (response.session?.status === 'stopped') show('finished', response.session);
  return true;
}

document.querySelector('#start')!.addEventListener('click', async () => {
  const title = titleInput.value.trim();
  if (!title) {
    status.textContent = 'Give this story a clear outcome first.';
    titleInput.focus();
    return;
  }
  handle(await send({ type: 'start', title }));
});

document
  .querySelector('#undo')!
  .addEventListener('click', async () => handle(await send({ type: 'undo' })));
document
  .querySelector('#stop')!
  .addEventListener('click', async () => handle(await send({ type: 'stop' })));
document
  .querySelector('#download')!
  .addEventListener('click', async () => handle(await send({ type: 'download' })));
document.querySelector('#studio')!.addEventListener('click', async () => {
  const response = await send({ type: 'open-studio' });
  if (handle(response) && response.ok && !response.imported) {
    status.textContent = 'Portable source downloaded. Choose it in the Studio import dialog.';
  }
});
document.querySelector('#settings')!.addEventListener('click', async () => {
  await chrome.runtime.openOptionsPage();
});
document.querySelector('#new-recording')!.addEventListener('click', async () => {
  const response = await send({ type: 'clear' });
  if (response.ok) {
    titleInput.value = '';
    show('idle');
    titleInput.focus();
  } else handle(response);
});

titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') (document.querySelector('#start') as HTMLButtonElement).click();
});

void send({ type: 'status' }).then((response) => {
  if (!response.ok || !response.session) show('idle');
  else handle(response);
});
