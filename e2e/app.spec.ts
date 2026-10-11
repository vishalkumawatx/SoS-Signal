import { expect, test, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function mockApi(page: Page, signedIn = false, configured = false) {
  let user: null | { id: number; name: string; email: string } = signedIn ? { id: 1, name: 'Test user', email: 'test@example.invalid' } : null;
  let contacts: { id: number; name: string; phone: string; verified: boolean }[] = [];
  const alerts: unknown[] = [];
  const sends: Record<string, unknown>[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = {};
    if (path === '/api/session') body = { user, configured };
    else if (path === '/api/auth/register' || path === '/api/auth/login') {
      user = { id: 1, name: 'Test user', email: 'test@example.invalid' }; body = { user };
    } else if (path === '/api/auth/logout') { user = null; body = {}; }
    else if (path === '/api/contacts' && request.method() === 'GET') body = { contacts };
    else if (path === '/api/contacts' && request.method() === 'POST') {
      const contact = { ...request.postDataJSON(), id: 1, verified: false }; contacts.push(contact); body = { contact };
    } else if (path.endsWith('/verify')) { contacts[0].verified = true; body = { contact: contacts[0] }; }
    else if (path === '/api/contacts/1' && request.method() === 'DELETE') { contacts = []; }
    else if (path === '/api/alerts' && request.method() === 'GET') body = { alerts };
    else if (path === '/api/alerts' && request.method() === 'POST') {
      const data = request.postDataJSON(); sends.push(data);
      const alert = { id: 1, createdAt: new Date().toISOString(), ...data, latitude: data.latitude ?? null, longitude: data.longitude ?? null, recipients: contacts.map(c => ({ ...c, status: 'queued', error: null })) };
      alerts.unshift(alert); body = { alert };
    } else throw new Error(`Unexpected API request: ${request.method()} ${path}`);
    await route.fulfill({ json: body });
  });
  return sends;
}

test('desktop overview is honest about setup and keyboard-accessible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your safety, connected.' })).toBeVisible();
  await expect(page.getByText('Setup needed', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No alerts to show' })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Emergency guidance' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery isn’t guaranteed' })).toBeVisible();
  await page.getByRole('button', { name: 'Understood' }).click();
  expect(errors).toEqual([]);
});

test('account, contact verification, explicit SOS confirmation, history and removal', async ({ page }) => {
  const sends = await mockApi(page, false, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Your name').fill('Test user');
  await page.getByLabel('Email address').fill('test@example.invalid');
  await page.getByLabel('Password').fill('a-unique-test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Your account is ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add your first contact' }).click();
  await page.getByLabel('Contact’s name').fill('Test contact');
  await page.getByLabel('Mobile number').fill('+14155550123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByRole('heading', { name: 'Verify this contact' })).toBeVisible();
  await page.getByLabel('Verification code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify contact' }).click();
  await expect(page.getByText('Ready to alert', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'SOS Send an alert' }).click();
  expect(sends).toHaveLength(0);
  await expect(page.getByText('No location available. Your alert can be sent without it.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(sends).toHaveLength(0);
  await page.getByRole('button', { name: 'SOS Send an alert' }).click();
  await page.getByRole('button', { name: 'Confirm & send SOS' }).click();
  await expect(page.getByText('queued', { exact: true })).toBeVisible();
  expect(sends).toHaveLength(1);
  expect(sends[0].confirmed).toBe(true);
  expect(sends[0].latitude).toBeUndefined();
  await page.getByRole('button', { name: 'Trusted contacts' }).click();
  await page.getByRole('button', { name: 'Remove Test contact' }).click();
  await page.getByRole('button', { name: 'Remove contact', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with someone you trust.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('mobile navigation, denied location and missing configuration', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.clearPermissions();
  await mockApi(page, true, false);
  await page.goto('/');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Enable location' }).click();
  await expect(page.getByText(/Location permission was denied/)).toBeVisible();
  await page.getByRole('button', { name: 'SOS Send an alert' }).click();
  await expect(page.getByText(/SMS is not configured/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm & send SOS' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to trusted contacts' }).click();
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send verification code' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/mobile-dialog.png', fullPage: true });
});
