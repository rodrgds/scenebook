import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Scenebook Recorder',
    description: 'Capture portable, privacy-safe product stories in your own browser.',
    permissions: ['activeTab', 'downloads', 'offscreen', 'scripting', 'storage'],
    action: {
      default_title: 'Scenebook Recorder',
    },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'Command+Shift+S',
        },
      },
    },
  },
});
