import { test, expect } from '@playwright/test';

const API = 'http://localhost:4000';

const createdEmails: string[] = [];

const createAuthenticatedSession = async (page: any): Promise<{ email: string; token: string }> => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const email = `e2e.owner.${suffix}@elpim.local`;
  const password = 'e2e-password-123';

  const response = await page.request.post(`${API}/auth/register`, {
    data: { email, password },
  });

  if (response.status() !== 201) {
    throw new Error(`Could not create e2e user. HTTP ${response.status()}`);
  }

  createdEmails.push(email);

  const loginResponse = await page.request.post(`${API}/auth/login`, {
    data: { email, password },
  });

  if (!loginResponse.ok()) {
    throw new Error(`Could not login e2e user. HTTP ${loginResponse.status()}`);
  }

  const payload = (await loginResponse.json()) as { token: string };

  await page.addInitScript((token: string) => {
    localStorage.setItem('elpim_token', token);
  }, payload.token);

  // Set the auth-presence cookie at browser level so Next.js middleware allows the session
  await page.context().addCookies([
    {
      name: 'elpim_authed',
      value: '1',
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
      expires: Math.floor(Date.now() / 1000) + 365 * 86400,
    },
  ]);

  return { email, token: payload.token };
};

test('smoke flow: register/login -> gated onboarding wizard', async ({ page }) => {
  await createAuthenticatedSession(page);

  await page.goto('/dashboard/products');

  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole('heading', { name: 'Onboarding' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forbind webshop' })).toBeVisible();
});

test('smoke flow: billing ops page loads and can run close-month preview', async ({ page }) => {
  await createAuthenticatedSession(page);

  await page.goto('/settings/billing');
  await expect(page.getByRole('heading', { name: 'Billing Ops' })).toBeVisible();

  await page.getByRole('button', { name: 'Kør close-month preview' }).click();
  await expect(page.getByText(/Preview opdateret for|Close-month fejlede|Platform admin\/support role required/)).toBeVisible();

  await page.getByRole('button', { name: 'Hent audit-log' }).click();
  await expect(page.getByText(/Audit-log hentet|Kunne ikke hente audit-log|Platform admin\/support role required/)).toBeVisible();
});

// Clean up e2e users + their auto-created organizations after all tests
test.afterAll(async ({ request }) => {
  // Log in as the platform admin seed user to call admin endpoints
  const login = await request.post(`${API}/auth/login`, {
    data: { email: 'owner@elpim.local', password: 'changeme123' },
  });

  if (!login.ok()) {
    console.warn('e2e cleanup: could not log in as admin — skipping cleanup');
    return;
  }

  const { token } = (await login.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}` };

  for (const email of createdEmails) {
    try {
      // Find user by email
      const res = await request.fetch(`${API}/admin/users?q=${encodeURIComponent(email)}&pageSize=1`, { headers });
      if (!res.ok()) continue;
      const data = (await res.json()) as { users: Array<{ id: string; organizationMemberships: Array<{ organization: { id: string } }> }> };
      const user = data.users[0];
      if (!user) continue;

      // Delete their auto-created organizations first
      for (const m of user.organizationMemberships) {
        await request.delete(`${API}/admin/organizations/${m.organization.id}`, { headers }).catch(() => {});
      }

      // Delete the user
      await request.delete(`${API}/admin/users/${user.id}`, { headers }).catch(() => {});
    } catch {
      // Best-effort cleanup — don't fail the suite
    }
  }
});
