import { getAsset } from '../../src/asset-store';

type DownloadRequest = {
  target: 'scenebook-offscreen';
  type: 'download-archive';
  archiveKey: string;
  filename: string;
};

chrome.runtime.onMessage.addListener((message: DownloadRequest, _sender, sendResponse) => {
  if (message.target !== 'scenebook-offscreen' || message.type !== 'download-archive') {
    return false;
  }
  void (async () => {
    try {
      if (!/^download:[0-9a-f-]{36}$/u.test(message.archiveKey)) {
        throw new Error('The portable Scene download key is invalid.');
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,63})\.scene\.zip$/u.test(message.filename)) {
        throw new Error('The portable Scene filename is invalid.');
      }
      const archive = await getAsset(message.archiveKey);
      if (!archive?.byteLength) throw new Error('The portable Scene archive is empty.');
      const blob = new Blob([Uint8Array.from(archive).buffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = message.filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The runtime API is the only extension API available here. Triggering
      // the DOM download keeps the Blob in its owning document; the service
      // worker observes the resulting download ID for completion/error UI.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      sendResponse({ ok: true, url });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not create archive download',
      });
    }
  })();
  return true;
});
