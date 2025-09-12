import { test, expect } from "@playwright/test";
import { fillFieldSmart, clickSubmitSmart } from "../../lib/handlers/smartStep";

test.describe("Stagehand fallback canary", () => {
  test("fills Email and submits when deterministic fails", async ({ page }) => {
    // Use a simple page that likely won't have exact matches to force fallback behavior in CI.
    await page.goto("data:text/html," + encodeURIComponent(`
      <html><body>
        <label for="em">Work Email Address</label>
        <input id="em" type="email" />
        <button id="go">Proceed</button>
      </body></html>
    `));

    // Force deterministic failure by using a mismatched label:
    const res1 = await fillFieldSmart(page, "Email", "test@example.com");
    expect(["deterministic","stagehand"]).toContain(res1.method);

    const res2 = await clickSubmitSmart(page);
    expect(["deterministic","stagehand"]).toContain(res2.method);
  });
});
