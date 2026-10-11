import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.js';

test('real frontend/API onboarding and location alert with an isolated mock SMS transport', async ({ page, context }) => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const messages: { to: string; body: string }[] = [];
  const app = createApp({
    dbPath: ':memory:',
    config: { appOrigin: origin, production: false },
    sms: {
      async send(message: { to: string; body: string }) {
        messages.push(message);
        return { sid: `SM${'a'.repeat(32)}`, status: 'queued' };
      },
    },
  });
  app.use(express.static(resolve('dist')));
  server.on('request', app);
  try {
    await context.grantPermissions(['geolocation'], { origin });
    await context.setGeolocation({ latitude: 28.6139, longitude: 77.209, accuracy: 25 });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.getByLabel('Your name').fill('Integration Test');
    await page.getByLabel('Email address').fill('integration@example.invalid');
    await page.getByLabel('Password').fill('integration-password-123');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByText('Your account is ready')).toBeVisible();
    await page.getByRole('button', { name: 'Add your first contact' }).click();
    await page.getByLabel('Contact’s name').fill('Consenting Test Contact');
    await page.getByLabel('Mobile number').fill('+14155550123');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Send verification code' }).click();
    await expect(page.getByRole('heading', { name: 'Verify this contact' })).toBeVisible();
    const code = messages[0].body.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error('Verification SMS missing code');
    await page.getByLabel('Verification code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Verify contact' }).click();
    await expect(page.getByText('Ready to alert', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enable location' }).click();
    await expect(page.getByText('Available', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'SOS Send an alert' }).click();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: 'Confirm & send SOS' }).click();
    await expect(page.getByText('queued', { exact: true })).toBeVisible();
    expect(messages).toHaveLength(2);
    expect(messages[1].body).toContain('28.6139,77.209');
    await page.reload();
    await page.getByRole('button', { name: 'Alert history' }).click();
    await expect(page.getByText('queued', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No alerts to show' })).toBeVisible();
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    app.locals.db.close();
  }
});
