# JLL Flow 1


import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://login.jll.com/?fromURI=https%3A%2F%2Finvest.jll.com%2Fapi%2Fauthorization-code%2Fcallback&lang=en&locale=us');
  await page.getByRole('textbox', { name: 'Username' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill('wcromartie@orhlp.com');
  await page.getByText('Remember me').click();
  await page.getByText('Remember me').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('ban5anm_HRQ-pgz7awd');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.goto('https://invest.jll.com/us/en/listings/living-multi-housing/allura-las-colinas/esign-ca');
  await page.locator('label').filter({ hasText: 'Investor' }).locator('div').nth(2).click();
  await page.locator('[data-test-id="ca-nda.continue"]').click();
  const page1Promise = page.waitForEvent('popup');
  await page.locator('[data-test-id="ca-nda.sign-agreement"]').click();
  const page1 = await page1Promise;
  await page1.getByTestId('lhp-continue-btn').click();
  await page1.getByTestId('floating-panel-action-button').click();
  await page1.getByTestId('signature-form-field').locator('div').first().click();
  await page1.locator('[data-test-id="type-sign-canvas"]').click();
  await page1.locator('[data-test-id="type-sign-canvas"]').fill('W. Cromartie');
  await page1.locator('[data-test-id="apply-btn"]').click();
  await page1.getByTestId('title-field').click();
  await page1.getByTestId('title-field').fill('Dir Acquisitions');
  await page1.getByTestId('title-field').press('Tab');
  await page1.getByTestId('company-field').fill('Odyssey Residential Holdings');
  await page1.getByTestId('footer-submit-button').click();
  await page.goto('https://invest.jll.com/us/en/listings/living-multi-housing/allura-las-colinas/deal-room');
  await page.locator('.checkbox_overlay__kZBNW').first().click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-test-id="deal-room-download"]').click();
  const download = await downloadPromise;
});
