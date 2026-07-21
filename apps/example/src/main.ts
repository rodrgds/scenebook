import './style.css';

type Member = {
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly status: 'Active' | 'Invited';
  readonly initials: string;
};

const members: readonly Member[] = [
  {
    name: 'Maya Chen',
    email: 'maya@example.test',
    role: 'Owner',
    status: 'Active',
    initials: 'MC',
  },
  {
    name: 'Jon Bell',
    email: 'jon@example.test',
    role: 'Admin',
    status: 'Active',
    initials: 'JB',
  },
  {
    name: 'Sofia Costa',
    email: 'sofia@example.test',
    role: 'Member',
    status: 'Active',
    initials: 'SC',
  },
];

const roleDescriptions: Readonly<Record<string, string>> = {
  Member: 'Can create and edit projects.',
  Admin: 'Can manage projects, members, and workspace settings.',
  Viewer: 'Can view projects without making changes.',
};

let activeView: 'overview' | 'members' = 'members';
let invitedMember: Member | undefined;
let searchQuery = '';

const app = document.querySelector<HTMLDivElement>('#app')!;
const drift = new URLSearchParams(location.search).has('drift');
const inviteLabel = drift ? 'Add teammate' : 'Invite member';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function memberRow(member: Member): string {
  return `<tr>
    <td data-label="Member">
      <div class="person">
        <span class="avatar" aria-hidden="true">${escapeHtml(member.initials)}</span>
        <span><strong>${escapeHtml(member.name)}</strong><small data-scenebook-redact>${escapeHtml(member.email)}</small></span>
      </div>
    </td>
    <td data-label="Role">${escapeHtml(member.role)}</td>
    <td data-label="Status"><span class="status status-${member.status.toLowerCase()}"><span aria-hidden="true"></span>${member.status}</span></td>
  </tr>`;
}

app.innerHTML = `
  <div class="shell">
    <aside>
      <a class="brand" href="/" aria-label="Northstar home">
        <span class="brand-mark" aria-hidden="true">N</span>
        <span>Northstar</span>
      </a>
      <nav aria-label="Workspace">
        <button type="button" data-view="overview">Overview</button>
        <button type="button" data-view="members">Members</button>
      </nav>
      <div class="workspace">
        <span class="workspace-mark" aria-hidden="true">A</span>
        <span><strong>Acme Studio</strong><small>Workspace</small></span>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <span>Acme Studio</span>
        <span class="user-avatar" aria-label="Signed in as Riley Morgan">RM</span>
      </header>

      <section id="overview-view" class="content" aria-labelledby="overview-title" hidden>
        <div class="page-heading">
          <div>
            <h1 id="overview-title">Overview</h1>
            <p>Manage the people who can work in this workspace.</p>
          </div>
          <button type="button" class="primary" data-open-members>Manage members</button>
        </div>
        <article class="overview-card">
          <div>
            <h2>Workspace members</h2>
            <p id="overview-member-count">3 people have access to Acme Studio.</p>
          </div>
          <button type="button" class="secondary" data-open-members>View members</button>
        </article>
      </section>

      <section id="members-view" class="content" aria-labelledby="page-title">
        <div class="page-heading">
          <div>
            <h1 id="page-title">Members</h1>
            <p>Manage workspace access and roles.</p>
          </div>
          <button id="invite" type="button" class="primary"><span aria-hidden="true">+</span>${inviteLabel}</button>
        </div>

        <section class="member-list" aria-labelledby="member-list-title">
          <div class="list-tools">
            <div>
              <h2 id="member-list-title">Workspace members</h2>
              <p id="result-count" aria-live="polite"></p>
            </div>
            <label class="search-field">
              <span class="sr-only">Search members</span>
              <span aria-hidden="true">⌕</span>
              <input id="member-search" type="search" placeholder="Search members" autocomplete="off" />
              <button id="clear-search" type="button" aria-label="Clear member search" hidden>Clear</button>
            </label>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Status</th></tr></thead>
              <tbody id="member-rows"></tbody>
            </table>
          </div>
          <div id="no-results" class="empty-state" hidden>
            <h3>No members found</h3>
            <p>Try another name, email, or role.</p>
            <button type="button" class="secondary" data-clear-search>Clear search</button>
          </div>
        </section>
      </section>
    </main>
  </div>

  <dialog id="invite-dialog" aria-labelledby="dialog-title" aria-describedby="dialog-description">
    <form id="invite-form">
      <header class="dialog-head">
        <div>
          <h2 id="dialog-title">Invite a teammate</h2>
          <p id="dialog-description">They’ll receive an email invitation to Acme Studio.</p>
        </div>
        <button type="button" class="icon-button" data-close-dialog aria-label="Close invitation form"><span aria-hidden="true">×</span></button>
      </header>
      <div class="dialog-fields">
        <label>Email address<input id="invite-email" name="email" type="email" value="ana@example.test" autocomplete="email" required data-scenebook-redact /></label>
        <label>Role<select id="invite-role" name="role"><option>Member</option><option>Admin</option><option>Viewer</option></select></label>
        <p id="role-description" class="field-help">${roleDescriptions.Member}</p>
      </div>
      <footer class="dialog-actions">
        <button type="button" class="secondary" data-close-dialog>Cancel</button>
        <button type="submit" class="primary">Send invitation</button>
      </footer>
    </form>
  </dialog>

  <div id="invite-toast" class="toast" role="status" aria-live="polite" hidden>
    <div><strong>Invitation sent</strong><span id="toast-detail"></span></div>
    <button type="button" class="icon-button" id="dismiss-toast" aria-label="Dismiss notification"><span aria-hidden="true">×</span></button>
  </div>`;

const memberRows = app.querySelector<HTMLTableSectionElement>('#member-rows')!;
const resultCount = app.querySelector<HTMLElement>('#result-count')!;
const noResults = app.querySelector<HTMLElement>('#no-results')!;
const searchInput = app.querySelector<HTMLInputElement>('#member-search')!;
const clearSearch = app.querySelector<HTMLButtonElement>('#clear-search')!;
const dialog = app.querySelector<HTMLDialogElement>('#invite-dialog')!;
const inviteForm = app.querySelector<HTMLFormElement>('#invite-form')!;
const inviteEmail = app.querySelector<HTMLInputElement>('#invite-email')!;
const inviteRole = app.querySelector<HTMLSelectElement>('#invite-role')!;
const roleDescription = app.querySelector<HTMLElement>('#role-description')!;
const toast = app.querySelector<HTMLElement>('#invite-toast')!;
const toastDetail = app.querySelector<HTMLElement>('#toast-detail')!;
const dialogFocusSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function currentMembers(): readonly Member[] {
  return invitedMember ? [...members, invitedMember] : members;
}

function renderMembers(): void {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filtered = currentMembers().filter((member) =>
    [member.name, member.email, member.role, member.status].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
  memberRows.innerHTML = filtered.map(memberRow).join('');
  resultCount.textContent = normalizedQuery
    ? `${filtered.length} of ${currentMembers().length} members`
    : `${currentMembers().length} members`;
  noResults.hidden = filtered.length > 0;
  clearSearch.hidden = normalizedQuery.length === 0;
  app.querySelector('#overview-member-count')!.textContent =
    `${currentMembers().length} people have access to Acme Studio.`;
}

function setView(view: 'overview' | 'members'): void {
  activeView = view;
  app.querySelector<HTMLElement>('#overview-view')!.hidden = view !== 'overview';
  app.querySelector<HTMLElement>('#members-view')!.hidden = view !== 'members';
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    const selected = button.dataset.view === view;
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const heading = app.querySelector<HTMLElement>(
    view === 'members' ? '#page-title' : '#overview-title',
  );
  heading?.focus({ preventScroll: true });
}

function resetSearch(): void {
  searchQuery = '';
  searchInput.value = '';
  renderMembers();
  searchInput.focus();
}

app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
  button.addEventListener('click', () =>
    setView(button.dataset.view === 'overview' ? 'overview' : 'members'),
  );
});

app.querySelectorAll<HTMLButtonElement>('[data-open-members]').forEach((button) => {
  button.addEventListener('click', () => setView('members'));
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderMembers();
});
clearSearch.addEventListener('click', resetSearch);
app.querySelector('[data-clear-search]')?.addEventListener('click', resetSearch);

app.querySelector('#invite')?.addEventListener('click', () => {
  dialog.showModal();
  requestAnimationFrame(() => inviteEmail.focus());
});

app.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => dialog.close());
});

dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const targets = [...dialog.querySelectorAll<HTMLElement>(dialogFocusSelector)].filter(
    (element) => element.getClientRects().length > 0,
  );
  const first = targets[0];
  const last = targets.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (
    event.shiftKey
      ? active === first || !dialog.contains(active)
      : active === last || !dialog.contains(active)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
});

inviteRole.addEventListener('change', () => {
  roleDescription.textContent = roleDescriptions[inviteRole.value] ?? '';
});

inviteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!inviteForm.reportValidity()) return;
  const email = inviteEmail.value.trim();
  const localName = email.split('@', 1)[0] ?? 'Teammate';
  const firstName = localName.charAt(0).toUpperCase() + localName.slice(1);
  invitedMember = {
    name: email === 'ana@example.test' ? 'Ana Martins' : firstName,
    email,
    role: inviteRole.value,
    status: 'Invited',
    initials: email === 'ana@example.test' ? 'AM' : firstName.slice(0, 2).toUpperCase(),
  };
  dialog.close();
  renderMembers();
  toastDetail.textContent = 'They can now join Acme Studio.';
  toast.hidden = false;
});

app.querySelector('#dismiss-toast')?.addEventListener('click', () => {
  toast.hidden = true;
});

renderMembers();
setView(activeView);
