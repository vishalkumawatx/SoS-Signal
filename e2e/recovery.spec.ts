import { expect, test } from '@playwright/test';

test('an unconfirmed verification send keeps the contact recoverable and announces resend', async ({ page }) => {
  const contact = { id: 1, name: 'Test contact', phone: '+14155550123', verified: false };
  let created = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { user: { id: 1, name: 'Test', email: 'test@example.invalid' }, configured: true } });
    if (path === '/api/alerts') return route.fulfill({ json: { alerts: [] } });
    if (path === '/api/contacts' && route.request().method() === 'GET') return route.fulfill({ json: { contacts: created ? [contact] : [] } });
    if (path === '/api/contacts' && route.request().method() === 'POST') {
      created = true;
      return route.fulfill({ status: 502, json: { error: 'Verification SMS could not be confirmed. Contact remains pending.', contact } });
    }
    if (path.endsWith('/resend')) return route.fulfill({ json: { contact } });
    throw new Error(`Unexpected request ${path}`);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add your first contact' }).click();
  await page.getByLabel('Contact’s name').fill(contact.name);
  await page.getByLabel('Mobile number').fill(contact.phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByRole('heading', { name: 'Verify this contact' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('dialog')).not.toContainText('code sent to');
  await expect(page.getByRole('dialog')).toContainText('SMS delivery is not guaranteed.');
  await expect(page.getByRole('link', { name: 'Twilio Console' })).toHaveAttribute('href', 'https://console.twilio.com/');
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('A new code was submitted');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Unverified', { exact: true })).toBeVisible();
});
