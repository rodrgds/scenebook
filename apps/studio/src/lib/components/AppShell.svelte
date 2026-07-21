<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  import { STUDIO_PROJECT_CHANGED_EVENT, studioSceneLibrary } from '../scene-library';
  import Icon from './Icon.svelte';
  import SceneCreateDialog from './SceneCreateDialog.svelte';
  import SceneImportDialog from './SceneImportDialog.svelte';

  type ActiveNav =
    | 'home'
    | 'catalog'
    | 'changes'
    | 'collections'
    | 'publish'
    | 'runs'
    | 'insights'
    | 'settings'
    | 'scene';

  let {
    active = 'home',
    children,
    flush = false,
  }: { active?: ActiveNav; children: Snippet; flush?: boolean } = $props();

  let navOpen = $state(false);
  let isMobileNavigation = $state(false);
  let searchInput: HTMLInputElement;
  let menuButton: HTMLButtonElement;
  let closeNavButton: HTMLButtonElement;
  let sidebar: HTMLElement;
  let search = $state('');
  let createVisible = $state(false);
  let importVisible = $state(false);
  let dialogTrigger: HTMLElement | null = null;
  let projectName = $state('Local workspace');

  let projectMark = $derived(projectName.trim().charAt(0).toLocaleUpperCase() || 'L');

  let navIsVisible = $derived(!isMobileNavigation || navOpen);

  $effect(() => {
    const action = page.url.searchParams.get('action');
    if (action === 'create' && !createVisible) {
      dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      createVisible = true;
    }
    if (action === 'import' && !importVisible) {
      dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      importVisible = true;
    }
  });

  onMount(() => {
    const query = window.matchMedia('(max-width: 1050px)');
    const update = () => (isMobileNavigation = query.matches);
    const updateProject = (event: Event) => {
      const project = (event as CustomEvent<{ name?: unknown }>).detail;
      if (typeof project?.name === 'string' && project.name.trim()) projectName = project.name;
    };
    void studioSceneLibrary
      .loadProject()
      .then((project) => {
        if (project?.name.trim()) projectName = project.name;
      })
      .catch(() => undefined);
    update();
    query.addEventListener('change', update);
    window.addEventListener(STUDIO_PROJECT_CHANGED_EVENT, updateProject);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener(STUDIO_PROJECT_CHANGED_EVENT, updateProject);
    };
  });

  function openNavigation() {
    navOpen = true;
    queueMicrotask(() => closeNavButton?.focus());
  }

  function closeNavigation({ restoreFocus = true } = {}) {
    if (!navOpen) return;
    navOpen = false;
    if (restoreFocus) queueMicrotask(() => menuButton?.focus());
  }

  function handleGlobalKey(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (isMobileNavigation) void goto('/catalog?focusSearch=1');
      else searchInput?.focus();
    }
    if (event.key === 'Escape' && navOpen) closeNavigation();
    if (event.key === 'Tab' && navOpen && isMobileNavigation && sidebar) {
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('inert'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function submitSearch() {
    const query = search.trim();
    void goto(query ? `/catalog?q=${encodeURIComponent(query)}` : '/catalog');
  }

  function openWorkspaceDialog(kind: 'create' | 'import') {
    dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (kind === 'create') createVisible = true;
    else importVisible = true;
  }

  function closeWorkspaceDialog(kind: 'create' | 'import') {
    if (kind === 'create') createVisible = false;
    else importVisible = false;
    if (page.url.searchParams.get('action') === kind) {
      const url = new URL(page.url);
      url.searchParams.delete('action');
      void goto(`${url.pathname}${url.search}${url.hash}`, {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      });
    }
    queueMicrotask(() => {
      dialogTrigger?.focus();
      dialogTrigger = null;
    });
  }
</script>

<svelte:window onkeydown={handleGlobalKey} />

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="shell" class:flush>
  <aside
    bind:this={sidebar}
    class:open={navOpen}
    class="sidebar"
    aria-label="Project navigation"
    aria-hidden={!navIsVisible}
    inert={!navIsVisible}
    onclick={(event) => {
      if (event.target instanceof Element && event.target.closest('a')) {
        closeNavigation({ restoreFocus: false });
      }
    }}
  >
    <div class="brand-row">
      <a class="brand" href="/" aria-label="Scenebook home">
        <svg aria-hidden="true" viewBox="0 0 32 32">
          <rect x="3" y="5" width="16" height="11" rx="2"></rect>
          <rect x="8" y="11" width="16" height="11" rx="2"></rect>
          <rect x="13" y="17" width="16" height="11" rx="2"></rect>
          <path d="M7 11c7 0 5 10 14 10h4"></path>
        </svg>
        <span>Scenebook</span>
      </a>
      <button
        bind:this={closeNavButton}
        class="close-nav"
        type="button"
        aria-label="Close navigation"
        onclick={() => closeNavigation()}
      >
        <Icon name="close" />
      </button>
    </div>

    <div class="project-switcher" aria-label="Current project">
      <span class="project-mark">{projectMark}</span>
      <span><strong>{projectName}</strong><small>Stored in this browser</small></span>
    </div>

    <p class="nav-label">Workspace</p>
    <nav class="primary-nav" aria-label="Workspace">
      <a class:active={active === 'home'} href="/"><Icon name="home" /><span>Home</span></a>
      <a class:active={active === 'catalog'} href="/catalog"
        ><Icon name="catalog" /><span>Scenes</span></a
      >
      <a class:active={active === 'changes'} href="/changes"
        ><Icon name="changes" /><span>Review</span></a
      >
      <a class:active={active === 'collections'} href="/collections"
        ><Icon name="collection" /><span>Collections</span></a
      >
    </nav>

    <div class="nav-spacer"></div>

    <p class="nav-label">Delivery</p>
    <nav class="secondary-nav" aria-label="Delivery">
      <a class:active={active === 'runs'} href="/runs"><Icon name="runs" /><span>Runs</span></a>
      <a class:active={active === 'publish'} href="/publish"
        ><Icon name="publish" /><span>Release</span></a
      >
      <a class:active={active === 'insights'} href="/insights"
        ><Icon name="insights" /><span>Coverage</span></a
      >
      <a class:active={active === 'settings'} href="/settings"
        ><Icon name="settings" /><span>Settings</span></a
      >
    </nav>
  </aside>

  {#if navOpen}
    <button
      class="scrim"
      type="button"
      aria-label="Close navigation"
      onclick={() => closeNavigation()}
    ></button>
  {/if}

  <div class="body" inert={isMobileNavigation && navOpen}>
    <header class="topbar">
      <button
        bind:this={menuButton}
        class="menu-button"
        type="button"
        aria-label="Open navigation"
        aria-expanded={navOpen}
        onclick={openNavigation}
      >
        <Icon name="menu" />
      </button>
      <form
        class="global-search"
        role="search"
        onsubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <label class="sr-only" for="global-scene-search">Search scenes</label>
        <Icon name="search" size={16} />
        <input
          id="global-scene-search"
          bind:this={searchInput}
          bind:value={search}
          placeholder="Search scenes…"
        />
        <kbd>⌘ K</kbd>
      </form>
      <button
        class="mobile-search-button"
        type="button"
        aria-label="Search scenes"
        onclick={() => void goto('/catalog?focusSearch=1')}><Icon name="search" size={18} /></button
      >
      <div class="top-actions">
        <button class="button" type="button" onclick={() => openWorkspaceDialog('import')}
          ><Icon name="download" size={16} />Import</button
        >
        <button class="button primary" type="button" onclick={() => openWorkspaceDialog('create')}
          ><Icon name="plus" size={16} />New Scene</button
        >
      </div>
    </header>

    <main id="main-content" class="main">
      {@render children()}
    </main>
  </div>
</div>

<SceneCreateDialog
  visible={createVisible}
  onclose={() => closeWorkspaceDialog('create')}
  oncreated={() => (navOpen = false)}
/>
<SceneImportDialog
  visible={importVisible}
  onclose={() => closeWorkspaceDialog('import')}
  onimported={() => (navOpen = false)}
/>

<style>
  .skip-link {
    background: var(--ink);
    border-radius: 0 0 7px 0;
    color: white;
    left: 0;
    padding: 10px 14px;
    position: fixed;
    top: 0;
    transform: translateY(-120%);
    z-index: 100;
  }
  .skip-link:focus {
    transform: translateY(0);
  }
  .shell {
    --topbar-height: 62px;
    display: grid;
    grid-template-columns: var(--nav-width) minmax(0, 1fr);
    min-height: 100vh;
  }
  .sidebar {
    background: var(--paper-2);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    height: 100vh;
    left: 0;
    overflow-y: auto;
    padding: 14px 12px;
    position: sticky;
    top: 0;
    z-index: 40;
  }
  .brand-row {
    align-items: center;
    display: flex;
    justify-content: space-between;
    min-height: 42px;
    padding: 0 7px;
  }
  .brand {
    align-items: center;
    display: flex;
    font-size: 1.02rem;
    font-weight: 760;
    gap: 9px;
    letter-spacing: -0.025em;
    text-decoration: none;
  }
  .brand svg {
    fill: none;
    height: 27px;
    stroke: var(--accent);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.7;
    width: 27px;
  }
  .close-nav {
    background: transparent;
    border: 0;
    display: none;
    height: 44px;
    justify-content: center;
    padding: 0;
    width: 44px;
  }
  .project-switcher {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 9px;
    display: grid;
    gap: 9px;
    grid-template-columns: 28px 1fr;
    margin: 12px 0 20px;
    min-height: 52px;
    padding: 7px;
    text-align: left;
    width: 100%;
  }
  .project-mark {
    align-items: center;
    background: var(--ink);
    border-radius: 7px;
    color: white;
    display: flex;
    font-size: 0.72rem;
    font-weight: 800;
    height: 28px;
    justify-content: center;
    width: 28px;
  }
  .project-switcher strong,
  .project-switcher small {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-switcher strong {
    font-size: 0.8rem;
  }
  .project-switcher small {
    color: var(--muted);
    font-size: 0.7rem;
    margin-top: 1px;
  }
  .nav-label {
    color: var(--faint);
    font-size: 0.7rem;
    font-weight: 650;
    margin: 0 9px 6px;
  }
  nav {
    display: grid;
    gap: 3px;
  }
  nav a {
    align-items: center;
    border-radius: 7px;
    color: var(--muted);
    display: grid;
    font-size: 0.82rem;
    font-weight: 590;
    gap: 10px;
    grid-template-columns: 19px 1fr auto;
    min-height: 42px;
    padding: 8px 9px;
    text-decoration: none;
  }
  nav a:hover {
    background: color-mix(in srgb, var(--surface) 72%, transparent);
    color: var(--ink);
  }
  nav a.active {
    background: var(--surface);
    color: var(--ink);
    font-weight: 690;
  }
  nav a.active :global(svg) {
    color: var(--accent);
  }
  .nav-spacer {
    flex: 1;
    min-height: 24px;
  }
  .secondary-nav {
    padding-bottom: 4px;
  }
  .body {
    min-width: 0;
  }
  .topbar {
    align-items: center;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 14px;
    height: 62px;
    justify-content: space-between;
    padding: 0 22px;
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .menu-button {
    align-items: center;
    background: transparent;
    border: 0;
    display: none;
    height: 44px;
    justify-content: center;
    padding: 0;
    width: 44px;
  }
  .global-search {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--muted);
    display: flex;
    flex: 1;
    gap: 8px;
    max-width: 420px;
    padding: 0 9px;
    position: relative;
  }
  .global-search input {
    background: transparent;
    border: 0;
    font-size: 0.8rem;
    height: 40px;
    min-width: 0;
    outline: 0;
    padding: 0;
    width: 100%;
  }
  .global-search:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent);
    color: var(--ink);
  }
  kbd {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 5px;
    box-shadow: 0 1px 0 var(--line);
    color: var(--faint);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 3px 6px;
    white-space: nowrap;
  }
  .top-actions {
    align-items: center;
    display: flex;
    gap: 8px;
  }
  .mobile-search-button {
    align-items: center;
    background: transparent;
    border: 0;
    display: none;
    height: 44px;
    justify-content: center;
    padding: 0;
    width: 44px;
  }
  .main {
    min-height: calc(100vh - 62px);
    min-width: 0;
  }
  .shell.flush .main {
    overflow: clip;
  }
  .scrim {
    background: rgba(25, 24, 22, 0.38);
    border: 0;
    inset: 0;
    position: fixed;
    z-index: 35;
  }
  @media (max-width: 1050px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }
    .sidebar {
      box-shadow: var(--shadow-md);
      max-width: min(86vw, 280px);
      position: fixed;
      transform: translateX(-105%);
      transition: transform 180ms ease;
      width: 100%;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .close-nav,
    .menu-button {
      display: inline-flex;
    }
    .topbar {
      padding-left: 12px;
    }
  }
  @media (max-width: 720px) {
    .shell {
      --topbar-height: 56px;
    }
    .topbar {
      gap: 6px;
      height: 56px;
      padding-right: 10px;
    }
    .global-search,
    .top-actions .button:not(.primary) {
      display: none;
    }
    .mobile-search-button {
      display: inline-flex;
      margin-left: auto;
    }
    .top-actions .button.primary {
      font-size: 0;
      min-width: 44px;
      padding: 8px;
    }
    .top-actions .button.primary :global(svg) {
      margin: 0;
    }
    .main {
      min-height: calc(100vh - 56px);
    }
  }
</style>
