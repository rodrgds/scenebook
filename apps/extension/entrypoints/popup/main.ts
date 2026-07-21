import type { RecorderMessage, RecorderResponse, RecorderSession } from '../../src/protocol';

type View = 'idle' | 'active' | 'finished';
type StatusKind = 'error' | 'info' | 'success';

const idle = document.querySelector<HTMLElement>('#idle-view')!;
const active = document.querySelector<HTMLElement>('#active-view')!;
const finished = document.querySelector<HTMLElement>('#finished-view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const titleInput = document.querySelector<HTMLInputElement>('#scene-title')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
let currentView: View | undefined;
let pendingAction = false;

function setStatus(message = '', kind: StatusKind = 'info'): void {
  status.textContent = message;
  status.dataset.kind = message ? kind : '';
  status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  status.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

function focusView(view: View): void {
  requestAnimationFrame(() => {
    if (view === 'idle') titleInput.focus();
    else
      document
        .querySelector<HTMLElement>(view === 'active' ? '#active-title' : '#finished-title')
        ?.focus();
  });
}

function show(view: View, session?: RecorderSession): void {
  const changed = currentView !== view;
  currentView = view;
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
  if (changed) focusView(view);
}

async function send(message: RecorderMessage): Promise<RecorderResponse> {
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
    setStatus(response.error, 'error');
    return false;
  }
  if (response.session?.status === 'recording') show('active', response.session);
  if (response.session?.status === 'stopped') show('finished', response.session);
  return true;
}

async function pending(
  button: HTMLButtonElement,
  message: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (pendingAction || button.disabled) return;
  pendingAction = true;
  buttons.forEach((candidate) => {
    candidate.disabled = true;
  });
  button.setAttribute('aria-busy', 'true');
  setStatus(message, 'info');
  try {
    await operation();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : 'The action could not be completed.',
      'error',
    );
  } finally {
    pendingAction = false;
    buttons.forEach((candidate) => {
      candidate.disabled = false;
    });
    button.removeAttribute('aria-busy');
  }
}

startButton.addEventListener('click', async () => {
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.setAttribute('aria-invalid', 'true');
    setStatus('Give this scene a clear outcome first.', 'error');
    titleInput.focus();
    return;
  }
  titleInput.removeAttribute('aria-invalid');
  await pending(startButton, 'Starting the recorder…', async () => {
    if (handle(await send({ type: 'start', title }))) setStatus('Recording started.', 'success');
  });
});

document.querySelector<HTMLButtonElement>('#undo')!.addEventListener('click', async (event) => {
  await pending(event.currentTarget as HTMLButtonElement, 'Removing the last step…', async () => {
    if (handle(await send({ type: 'undo' }))) setStatus('Last step removed.', 'success');
  });
});
document.querySelector<HTMLButtonElement>('#stop')!.addEventListener('click', async (event) => {
  await pending(event.currentTarget as HTMLButtonElement, 'Finishing the recording…', async () => {
    if (handle(await send({ type: 'stop' }))) setStatus('Recording finished.', 'success');
  });
});
document.querySelector<HTMLButtonElement>('#download')!.addEventListener('click', async (event) => {
  await pending(
    event.currentTarget as HTMLButtonElement,
    'Preparing the source download…',
    async () => {
      if (handle(await send({ type: 'download' }))) setStatus('Source downloaded.', 'success');
    },
  );
});
document.querySelector<HTMLButtonElement>('#studio')!.addEventListener('click', async (event) => {
  await pending(event.currentTarget as HTMLButtonElement, 'Opening Studio…', async () => {
    const response = await send({ type: 'open-studio' });
    if (!handle(response) || !response.ok) return;
    setStatus(
      response.imported
        ? 'The scene opened in Studio.'
        : 'Portable source downloaded. Choose it in the Studio import dialog.',
      response.imported ? 'success' : 'info',
    );
  });
});
document.querySelector<HTMLButtonElement>('#settings')!.addEventListener('click', async (event) => {
  await pending(
    event.currentTarget as HTMLButtonElement,
    'Opening Studio connection settings…',
    async () => {
      await chrome.runtime.openOptionsPage();
      setStatus('Studio connection settings opened.', 'success');
    },
  );
});
document
  .querySelector<HTMLButtonElement>('#new-recording')!
  .addEventListener('click', async (event) => {
    await pending(
      event.currentTarget as HTMLButtonElement,
      'Preparing a new recording…',
      async () => {
        const response = await send({ type: 'clear' });
        if (response.ok) {
          titleInput.value = '';
          show('idle');
          setStatus('Ready for a new scene.', 'success');
        } else handle(response);
      },
    );
  });

titleInput.addEventListener('input', () => {
  titleInput.removeAttribute('aria-invalid');
  if (status.dataset.kind === 'error') setStatus();
});
titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') startButton.click();
});

void send({ type: 'status' }).then((response) => {
  if (!response.ok) {
    show('idle');
    setStatus(response.error, 'error');
  } else if (!response.session) show('idle');
  else handle(response);
});
