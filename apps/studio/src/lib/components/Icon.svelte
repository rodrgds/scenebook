<script lang="ts">
  type IconName =
    | 'home'
    | 'catalog'
    | 'changes'
    | 'collection'
    | 'publish'
    | 'runs'
    | 'insights'
    | 'settings'
    | 'search'
    | 'plus'
    | 'camera'
    | 'chevron-down'
    | 'chevron-right'
    | 'menu'
    | 'close'
    | 'play'
    | 'external'
    | 'check'
    | 'clock'
    | 'warning'
    | 'branch'
    | 'history'
    | 'code'
    | 'edit'
    | 'health'
    | 'versions'
    | 'save'
    | 'undo'
    | 'redo'
    | 'copy'
    | 'trash'
    | 'up'
    | 'down'
    | 'hotspot'
    | 'mask'
    | 'crop'
    | 'annotation'
    | 'cursor'
    | 'theme'
    | 'guide'
    | 'video'
    | 'lock'
    | 'globe'
    | 'download'
    | 'file'
    | 'more'
    | 'arrow-left'
    | 'arrow-right';

  let {
    name,
    size = 18,
    strokeWidth = 1.8,
  }: { name: IconName; size?: number; strokeWidth?: number } = $props();
</script>

<svg
  aria-hidden="true"
  fill="none"
  height={size}
  viewBox="0 0 24 24"
  width={size}
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  stroke-width={strokeWidth}
>
  {#if name === 'home'}
    <path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" />
  {:else if name === 'catalog'}
    <rect x="3" y="4" width="7" height="7" rx="1.5" /><rect
      x="14"
      y="4"
      width="7"
      height="7"
      rx="1.5"
    /><rect x="3" y="15" width="7" height="5" rx="1.5" /><rect
      x="14"
      y="15"
      width="7"
      height="5"
      rx="1.5"
    />
  {:else if name === 'changes'}
    <path d="M7 3v12" /><path d="m3 11 4 4 4-4" /><path d="M17 21V9" /><path d="m13 13 4-4 4 4" />
  {:else if name === 'collection'}
    <rect x="4" y="4" width="14" height="14" rx="2" /><path d="M8 2h10a4 4 0 0 1 4 4v10" /><path
      d="M8 9h6M8 13h5"
    />
  {:else if name === 'publish'}
    <path d="M12 16V3" /><path d="m7 8 5-5 5 5" /><path d="M5 13v7h14v-7" />
  {:else if name === 'runs'}
    <circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" />
  {:else if name === 'insights'}
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3" /><path
      d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1A1.7 1.7 0 0 0 2.4 13.6H2V9.6h.4A1.7 1.7 0 0 0 4.1 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.2l.06.06A1.7 1.7 0 0 0 8.5 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1H14a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.9v4.2h-.9a1.7 1.7 0 0 0-1.7 1.4Z"
    />
  {:else if name === 'search'}
    <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'camera'}
    <path d="M4 7h3l1.5-2h7L17 7h3v12H4Z" /><circle cx="12" cy="13" r="3.5" />
  {:else if name === 'chevron-down'}
    <path d="m7 9 5 5 5-5" />
  {:else if name === 'chevron-right'}
    <path d="m9 6 6 6-6 6" />
  {:else if name === 'menu'}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === 'close'}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'play'}
    <path d="m9 6 9 6-9 6Z" />
  {:else if name === 'external'}
    <path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6H5V6h6" />
  {:else if name === 'check'}
    <path d="m5 12 4 4L19 6" />
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  {:else if name === 'warning'}
    <path d="m12 3 10 18H2Z" /><path d="M12 9v5M12 17h.01" />
  {:else if name === 'branch'}
    <circle cx="6" cy="5" r="2" /><circle cx="18" cy="8" r="2" /><circle
      cx="6"
      cy="19"
      r="2"
    /><path d="M6 7v10M8 10h5a5 5 0 0 0 5-5" />
  {:else if name === 'history'}
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" />
  {:else if name === 'code'}
    <path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" />
  {:else if name === 'edit'}
    <path d="m4 16-1 5 5-1L19 9l-4-4Z" /><path d="m13 7 4 4" />
  {:else if name === 'health'}
    <path d="M3 12h4l2-5 4 10 2-5h6" />
  {:else if name === 'versions'}
    <path d="M5 4h14v16H5z" /><path d="M9 8h6M9 12h6M9 16h4" />
  {:else if name === 'save'}
    <path d="M4 3h14l2 2v16H4Z" /><path d="M8 3v6h8V3M8 21v-7h8v7" />
  {:else if name === 'undo'}
    <path d="m9 7-5 5 5 5" /><path d="M4 12h9a6 6 0 0 1 6 6" />
  {:else if name === 'redo'}
    <path d="m15 7 5 5-5 5" /><path d="M20 12h-9a6 6 0 0 0-6 6" />
  {:else if name === 'copy'}
    <rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" />
  {:else if name === 'trash'}
    <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
  {:else if name === 'up'}
    <path d="m6 15 6-6 6 6" />
  {:else if name === 'down'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'hotspot'}
    <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path
      d="M12 2v3M12 19v3M2 12h3M19 12h3"
    />
  {:else if name === 'mask'}
    <path d="M3 7h18v10H3Z" /><path d="m5 15 4-4 3 3 3-3 4 4" />
  {:else if name === 'crop'}
    <path d="M6 3v15h15M3 6h15v15" />
  {:else if name === 'annotation'}
    <path d="M4 5h16v12H9l-5 4Z" /><path d="M8 9h8M8 13h5" />
  {:else if name === 'cursor'}
    <path d="m5 3 13 9-7 1-3 7Z" />
  {:else if name === 'theme'}
    <path
      d="M12 3a9 9 0 1 0 0 18c1.2 0 2-1 1.5-2-.7-1.5.4-3 2-3h2.2A3.3 3.3 0 0 0 21 12.7 9.7 9.7 0 0 0 12 3Z"
    /><circle cx="7.5" cy="11" r=".7" /><circle cx="10" cy="7" r=".7" /><circle
      cx="15"
      cy="7.5"
      r=".7"
    />
  {:else if name === 'guide'}
    <path d="M4 4h16v16H4Z" /><path d="M8 8h8M8 12h8M8 16h5" />
  {:else if name === 'video'}
    <rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2Z" />
  {:else if name === 'lock'}
    <rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
  {:else if name === 'globe'}
    <circle cx="12" cy="12" r="9" /><path
      d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"
    />
  {:else if name === 'download'}
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  {:else if name === 'file'}
    <path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h5" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle
      cx="12"
      cy="12"
      r="1"
      fill="currentColor"
      stroke="none"
    /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  {:else if name === 'arrow-left'}
    <path d="m15 18-6-6 6-6" />
  {:else if name === 'arrow-right'}
    <path d="m9 18 6-6-6-6" />
  {/if}
</svg>
