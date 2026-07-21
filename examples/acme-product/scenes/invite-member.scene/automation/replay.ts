import { expect, scene } from '@scenebook/playwright';

scene('Invite a teammate', { id: 'invite-member' }, async ({ page, step }) => {
  await page.goto('/?scenebook=1');

  await step(
    'open-invitation-form',
    {
      title: 'Open the invitation form',
      target: page.getByRole('button', { name: 'Invite member' }),
    },
    async () => page.getByRole('button', { name: 'Invite member' }).click(),
  );

  await step(
    'enter-invitee',
    {
      title: 'Enter your teammate’s email',
      target: page.getByLabel('Email address'),
      masks: [page.getByLabel('Email address')],
    },
    async () => page.getByLabel('Email address').fill('ana@example.test'),
  );

  await step(
    'send-invitation',
    {
      title: 'Send the invitation',
    },
    async () => page.getByText('Send invitation', { exact: true }).click(),
  );

  await expect(page.getByText('Invitation sent')).toBeVisible();
});
