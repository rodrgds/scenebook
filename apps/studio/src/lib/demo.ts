import type { CatalogScene, EditorScene, EditorStep } from './model';

function encodeSvg(svg: string): string {
  // Model the recorder's before-persistence privacy default, even for synthetic demo data.
  const privacySafe = svg.replaceAll(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    'PRIVATE VALUE MASKED',
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(privacySafe)}`;
}

function productScreenshot(
  state: 'members' | 'details' | 'role' | 'sent' | 'integration' | 'report',
): string {
  return `/demo/${state}.png`;

  const modal = state === 'details' || state === 'role';
  const success = state === 'sent';
  const title =
    state === 'integration' ? 'Integrations' : state === 'report' ? 'Reports' : 'Members';
  const subtitle =
    state === 'integration'
      ? 'Connect tools to automate your workspace.'
      : state === 'report'
        ? 'Create and schedule workspace reports.'
        : 'Manage who can access this workspace.';

  const rows =
    state === 'integration'
      ? `<g transform="translate(332 260)"><rect width="870" height="118" rx="14" fill="#fff" stroke="#ddd7cc"/><rect x="26" y="26" width="56" height="56" rx="12" fill="#171614"/><text x="54" y="62" text-anchor="middle" font-size="23" font-weight="700" fill="#fff">GH</text><text x="105" y="50" font-size="19" font-weight="650" fill="#201e1b">GitHub</text><text x="105" y="76" font-size="14" fill="#69645d">Sync pull requests and releases</text><rect x="728" y="35" width="112" height="43" rx="8" fill="#b83b24"/><text x="784" y="62" text-anchor="middle" font-size="14" font-weight="650" fill="#fff">Connect</text></g>`
      : state === 'report'
        ? `<g transform="translate(332 260)"><rect width="870" height="162" rx="14" fill="#fff" stroke="#ddd7cc"/><text x="28" y="46" font-size="18" font-weight="650" fill="#201e1b">Monthly usage summary</text><text x="28" y="75" font-size="14" fill="#69645d">Delivered on the first Monday of each month</text><rect x="28" y="102" width="118" height="34" rx="17" fill="#e4eee8"/><text x="87" y="124" text-anchor="middle" font-size="12" font-weight="650" fill="#267152">Scheduled</text><rect x="736" y="101" width="104" height="36" rx="8" fill="#f7f3ec" stroke="#d6d0c5"/><text x="788" y="124" text-anchor="middle" font-size="13" font-weight="600" fill="#393631">Edit report</text></g>`
        : `<g transform="translate(332 255)"><rect width="870" height="260" rx="14" fill="#fff" stroke="#ddd7cc"/><g fill="#6f6a62" font-size="12" font-weight="650"><text x="28" y="35">MEMBER</text><text x="525" y="35">ROLE</text><text x="730" y="35">STATUS</text></g><path d="M0 56h870M0 126h870M0 196h870" stroke="#ece7de"/><circle cx="52" cy="91" r="20" fill="#f0dad4"/><text x="52" y="96" text-anchor="middle" font-size="12" font-weight="700" fill="#a63722">AR</text><text x="86" y="86" font-size="15" font-weight="620" fill="#201e1b">Ana Ribeiro</text><text x="86" y="106" font-size="12" fill="#777168">ana@orbit.test</text><text x="525" y="96" font-size="14" fill="#393631">Owner</text><rect x="730" y="78" width="75" height="27" rx="13" fill="#e4eee8"/><text x="767" y="96" text-anchor="middle" font-size="11" font-weight="650" fill="#267152">Active</text><circle cx="52" cy="161" r="20" fill="#dae6eb"/><text x="52" y="166" text-anchor="middle" font-size="12" font-weight="700" fill="#315d73">JM</text><text x="86" y="156" font-size="15" font-weight="620" fill="#201e1b">Jonas Meyer</text><text x="86" y="176" font-size="12" fill="#777168">jonas@orbit.test</text><text x="525" y="166" font-size="14" fill="#393631">Member</text><rect x="730" y="148" width="75" height="27" rx="13" fill="#e4eee8"/><text x="767" y="166" text-anchor="middle" font-size="11" font-weight="650" fill="#267152">Active</text><circle cx="52" cy="231" r="20" fill="#eee4c8"/><text x="52" y="236" text-anchor="middle" font-size="12" font-weight="700" fill="#856213">LK</text><text x="86" y="226" font-size="15" font-weight="620" fill="#201e1b">Leila Khan</text><text x="86" y="246" font-size="12" fill="#777168">leila@orbit.test</text><text x="525" y="236" font-size="14" fill="#393631">Administrator</text><rect x="730" y="218" width="75" height="27" rx="13" fill="#f5e9c8"/><text x="767" y="236" text-anchor="middle" font-size="11" font-weight="650" fill="#8b5c00">Invited</text></g>`;

  const overlay = modal
    ? `<rect x="0" y="0" width="1440" height="900" fill="#171614" opacity=".36"/><g transform="translate(450 142)"><rect width="540" height="615" rx="18" fill="#fffdf8"/><text x="32" y="51" font-size="22" font-weight="680" fill="#1c1a18">Invite a teammate</text><text x="32" y="78" font-size="14" fill="#6d675f">They’ll receive a secure invitation by email.</text><circle cx="500" cy="46" r="18" fill="#f2ede4"/><path d="m493 39 14 14m0-14-14 14" stroke="#5f5a53" stroke-width="2"/><text x="32" y="127" font-size="12" font-weight="650" fill="#6d675f">EMAIL ADDRESS</text><rect x="32" y="142" width="476" height="48" rx="8" fill="#fff" stroke="${state === 'details' ? '#b83b24' : '#d5cec2'}" stroke-width="${state === 'details' ? 2 : 1}"/><text x="48" y="172" font-size="15" fill="#292622">teammate@acme.test</text><text x="32" y="231" font-size="12" font-weight="650" fill="#6d675f">FULL NAME</text><rect x="32" y="246" width="476" height="48" rx="8" fill="#fff" stroke="#d5cec2"/><text x="48" y="276" font-size="15" fill="#292622">Teammate Example</text><text x="32" y="335" font-size="12" font-weight="650" fill="#6d675f">WORKSPACE ROLE</text><g transform="translate(32 352)"><rect width="148" height="104" rx="10" fill="${state === 'role' ? '#f7e5df' : '#fff'}" stroke="${state === 'role' ? '#b83b24' : '#d5cec2'}" stroke-width="${state === 'role' ? 2 : 1}"/><circle cx="24" cy="25" r="7" fill="${state === 'role' ? '#b83b24' : '#fff'}" stroke="#b83b24"/><text x="42" y="30" font-size="14" font-weight="650" fill="#292622">Member</text><text x="16" y="57" font-size="12" fill="#6d675f">Can view and edit</text><text x="16" y="76" font-size="12" fill="#6d675f">workspace projects.</text></g><g transform="translate(196 352)"><rect width="148" height="104" rx="10" fill="#fff" stroke="#d5cec2"/><circle cx="24" cy="25" r="7" fill="#fff" stroke="#978f84"/><text x="42" y="30" font-size="14" font-weight="650" fill="#292622">Admin</text><text x="16" y="57" font-size="12" fill="#6d675f">Can manage people</text><text x="16" y="76" font-size="12" fill="#6d675f">and workspace settings.</text></g><path d="M0 511h540" stroke="#e8e2d8"/><rect x="319" y="535" width="88" height="44" rx="8" fill="#fff" stroke="#d5cec2"/><text x="363" y="563" text-anchor="middle" font-size="14" font-weight="620" fill="#393631">Cancel</text><rect x="419" y="535" width="89" height="44" rx="8" fill="#b83b24"/><text x="463" y="563" text-anchor="middle" font-size="14" font-weight="650" fill="#fff">Send invite</text></g>`
    : '';

  const toast = success
    ? `<g transform="translate(1030 770)"><rect width="330" height="72" rx="12" fill="#1f2f28"/><circle cx="37" cy="36" r="14" fill="#3b8968"/><path d="m30 36 5 5 9-11" fill="none" stroke="#fff" stroke-width="2.5"/><text x="66" y="31" font-size="14" font-weight="650" fill="#fff">Invitation sent</text><text x="66" y="51" font-size="12" fill="#cbd8d1">teammate@acme.test can now join.</text></g>`
    : '';

  return encodeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900"><rect width="1440" height="900" fill="#f8f4ec"/><rect width="1440" height="44" fill="#26231f"/><circle cx="22" cy="22" r="5" fill="#e2634a"/><circle cx="40" cy="22" r="5" fill="#d8a849"/><circle cx="58" cy="22" r="5" fill="#5d9b76"/><rect x="420" y="10" width="600" height="24" rx="6" fill="#3b3732"/><text x="720" y="27" text-anchor="middle" font-size="11" fill="#c7c0b6">app.orbit.test/settings/${title.toLowerCase()}</text><rect x="0" y="44" width="250" height="856" fill="#f0eadf"/><g transform="translate(26 80)"><rect width="28" height="28" rx="7" fill="#b83b24"/><text x="14" y="19" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">O</text><text x="40" y="19" font-size="17" font-weight="700" fill="#24211e">Orbit</text><text x="0" y="90" font-size="12" font-weight="650" fill="#8a8379">WORKSPACE</text><g font-size="14" fill="#5c574f"><text x="16" y="132">Overview</text><text x="16" y="174">Projects</text><text x="16" y="216">Automations</text></g><text x="0" y="282" font-size="12" font-weight="650" fill="#8a8379">SETTINGS</text><rect x="-8" y="300" width="206" height="40" rx="8" fill="#fff" stroke="#ddd6cb"/><text x="16" y="326" font-size="14" font-weight="650" fill="#24211e">Members</text><text x="16" y="372" font-size="14" fill="#5c574f">Integrations</text><text x="16" y="414" font-size="14" fill="#5c574f">Billing</text></g><rect x="250" y="44" width="1190" height="76" fill="#fffdf8"/><text x="286" y="91" font-size="14" font-weight="650" fill="#312e2a">Orbit Product</text><circle cx="1386" cy="82" r="18" fill="#f0dad4"/><text x="1386" y="87" text-anchor="middle" font-size="11" font-weight="700" fill="#a63722">AR</text><g transform="translate(304 160)"><text x="0" y="44" font-size="31" font-weight="680" fill="#1c1a18">${title}</text><text x="0" y="75" font-size="15" fill="#6d675f">${subtitle}</text><rect x="704" y="11" width="166" height="45" rx="9" fill="#b83b24"/><text x="787" y="40" text-anchor="middle" font-size="14" font-weight="650" fill="#fff">${state === 'integration' ? 'Connect service' : state === 'report' ? 'New report' : 'Invite member'}</text></g>${rows}${overlay}${toast}</svg>`,
  );
}

const images = {
  members: productScreenshot('members'),
  details: productScreenshot('details'),
  role: productScreenshot('role'),
  sent: productScreenshot('sent'),
  integration: productScreenshot('integration'),
  report: productScreenshot('report'),
};

function editorStep(
  input: Partial<EditorStep> & Pick<EditorStep, 'id' | 'title' | 'type'>,
): EditorStep {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    instruction: input.instruction ?? '',
    caption: input.caption ?? '',
    notes: input.notes ?? '',
    alt: input.alt ?? '',
    image: input.image,
    hotspot: input.hotspot,
    masks: input.masks ?? [],
    annotations: input.annotations ?? [],
    crop: input.crop ?? { x: 0.5, y: 0.5, zoom: 1 },
    cursor: input.cursor ?? {
      x: 0.5,
      y: 0.5,
      visible: true,
      click: true,
      path: [],
      clickAtMs: 300,
      style: 'default',
    },
    choices: input.choices ?? [],
    ctas: input.ctas ?? [],
    outputVisibility: input.outputVisibility ?? {
      interactive: true,
      guide: true,
      motion: true,
      social: true,
    },
    durationMs: input.durationMs ?? 2400,
    autoAdvance: input.autoAdvance ?? false,
    frame: input.frame ?? 'browser',
  };
}

export const demoScene: EditorScene = {
  version: 1,
  id: 'invite-teammate',
  title: 'Invite a teammate',
  description: 'Invite someone to Acme Studio and confirm they can join.',
  audience: 'Workspace administrators',
  tags: ['Team management', 'Onboarding'],
  theme: { accent: '#4c63d2', paper: '#f5f6f7', ink: '#202226', radius: 14, frame: 'dark' },
  sample: true,
  steps: [
    editorStep({
      id: 'open-members',
      type: 'screen',
      title: 'Open the invitation form',
      instruction: 'Choose Invite member.',
      caption: 'Start from the Members page.',
      alt: 'Acme Studio Members page with the Invite member button in the upper right.',
      image: images.members,
      hotspot: { x: 0.846, y: 0.167, label: 'Invite member' },
      cursor: {
        x: 0.846,
        y: 0.167,
        visible: true,
        click: true,
        path: [
          { atMs: 0, x: 0.66, y: 0.28 },
          { atMs: 700, x: 0.846, y: 0.167 },
        ],
        clickAtMs: 850,
        style: 'default',
      },
      annotations: [
        {
          id: 'member-note',
          x: 0.65,
          y: 0.3,
          text: 'Admin only',
          kind: 'callout',
          width: 0.14,
          height: 0.07,
        },
      ],
    }),
    editorStep({
      id: 'enter-details',
      type: 'screen',
      title: 'Enter their email',
      instruction: 'Enter a work email and choose a role.',
      caption: 'The email is masked before capture.',
      alt: 'Invitation dialog with the email field masked and Member selected.',
      image: images.details,
      hotspot: { x: 0.5, y: 0.46, width: 0.31, height: 0.05, label: 'Email address' },
      cursor: { x: 0.5, y: 0.46, visible: true, click: false, path: [], style: 'default' },
      masks: [
        {
          id: 'email-mask',
          mode: 'opaque',
          source: 'automatic',
          scope: 'both',
          classification: 'email',
          x: 0.344,
          y: 0.436,
          width: 0.313,
          height: 0.049,
          label: 'Email address redacted',
        },
      ],
    }),
    editorStep({
      id: 'choose-path',
      type: 'choice',
      title: 'What access should they have?',
      instruction: 'Choose the role that fits their work.',
      choices: [
        {
          id: 'member',
          label: 'Member access',
          description: 'Work in projects without changing workspace settings.',
          sceneId: 'invite-member-access',
          href: '/scenes/invite-member-access',
        },
        {
          id: 'admin',
          label: 'Administrator access',
          description: 'Manage people and workspace settings.',
          sceneId: 'invite-admin-access',
          href: '/scenes/invite-admin-access',
        },
      ],
    }),
    editorStep({
      id: 'choose-role',
      type: 'screen',
      title: 'Choose their role',
      instruction: 'Select the least-privileged role that fits.',
      alt: 'Invitation dialog with Member selected.',
      image: images.role,
      hotspot: { x: 0.5, y: 0.56, width: 0.31, height: 0.05, label: 'Member role' },
      cursor: {
        x: 0.5,
        y: 0.56,
        visible: true,
        click: true,
        path: [],
        clickAtMs: 300,
        style: 'default',
      },
    }),
    editorStep({
      id: 'send-invite',
      type: 'screen',
      title: 'Send the invitation',
      instruction: 'Choose Send invitation.',
      alt: 'Invitation dialog with the Send invitation button in the lower right.',
      image: images.role,
      hotspot: { x: 0.604, y: 0.678, label: 'Send invitation' },
      cursor: {
        x: 0.604,
        y: 0.678,
        visible: true,
        click: true,
        path: [],
        clickAtMs: 300,
        style: 'default',
      },
    }),
    editorStep({
      id: 'invitation-sent',
      type: 'end',
      title: 'Your teammate is invited',
      instruction: 'They can now join Acme Studio.',
      alt: 'Members page with an Invitation sent notice and a new invited member.',
      image: images.sent,
      ctas: [
        {
          id: 'open-product',
          label: 'Open Acme Studio',
          href: 'https://example.com',
          variant: 'primary',
        },
        { id: 'restart', label: 'Restart walkthrough', event: 'restart', variant: 'secondary' },
      ],
      cursor: { x: 0.5, y: 0.5, visible: false, click: false, path: [], style: 'default' },
    }),
  ],
};

export const catalogScenes: CatalogScene[] = [
  {
    id: 'invite-teammate',
    title: 'Invite a teammate',
    description: 'Invite someone to Acme Studio and confirm they can join.',
    capability: 'captured',
    status: 'stale',
    firstImage: images.members,
    finalImage: images.sent,
    audience: 'Workspace admin',
    feature: 'Team management',
    tags: ['Onboarding', 'Critical'],
    duration: 'Not run',
    lastVerified: 'No Run evidence',
    commit: 'Not applicable',
    environment: 'Synthetic fixture',
    stepCount: 6,
    published: false,
    sample: true,
  },
  {
    id: 'connect-github',
    title: 'Connect GitHub',
    description: 'Authorize GitHub and select repositories to synchronize.',
    capability: 'verified',
    status: 'stale',
    firstImage: images.integration,
    finalImage: images.integration,
    audience: 'Workspace admin',
    feature: 'Integrations',
    tags: ['Setup', 'Developer'],
    duration: 'Not run',
    lastVerified: 'No Run evidence',
    commit: 'Not applicable',
    environment: 'Synthetic fixture',
    stepCount: 5,
    published: false,
    sample: true,
  },
  {
    id: 'schedule-report',
    title: 'Schedule a usage report',
    description: 'Send recurring workspace activity summaries to stakeholders.',
    capability: 'monitored',
    status: 'stale',
    firstImage: images.report,
    finalImage: images.report,
    audience: 'Operations',
    feature: 'Reporting',
    tags: ['Analytics'],
    duration: 'Not run',
    lastVerified: 'No Run evidence',
    commit: 'Not applicable',
    environment: 'Synthetic fixture',
    stepCount: 4,
    published: false,
    sample: true,
  },
  {
    id: 'export-audit-log',
    title: 'Export an audit log',
    description: 'Filter account activity and export a signed CSV archive.',
    capability: 'captured',
    status: 'stale',
    firstImage: images.report,
    finalImage: images.report,
    audience: 'Security admin',
    feature: 'Security',
    tags: ['Compliance'],
    duration: 'Not run',
    lastVerified: 'No Run evidence',
    commit: 'Not applicable',
    environment: 'Synthetic fixture',
    stepCount: 7,
    published: false,
    sample: true,
  },
  {
    id: 'rotate-api-key',
    title: 'Rotate an API key',
    description: 'Replace a production credential without service interruption.',
    capability: 'verified',
    status: 'stale',
    firstImage: images.integration,
    finalImage: images.integration,
    audience: 'Developer',
    feature: 'API access',
    tags: ['Security', 'Critical'],
    duration: 'Not run',
    lastVerified: 'No Run evidence',
    commit: 'Not applicable',
    environment: 'Synthetic fixture',
    stepCount: 5,
    published: false,
    sample: true,
  },
];

