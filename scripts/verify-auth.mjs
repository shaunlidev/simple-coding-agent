import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createAgentOpsServer } from "../packages/server/dist/index.js";

const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const secretProbe = "synthetic-provider-secret-for-ui-redaction";
const users = [
  { id: "owner", role: "operator", secret: "synthetic-operator-credential-with-32-bytes" },
  { id: "guest", role: "viewer", secret: "synthetic-viewer-credential-with-32-bytes" },
];
const server = await createAgentOpsServer({ env: {
  AGENT_DB_PATH: ":memory:", AGENT_AUTH_USERS: JSON.stringify(users),
  DEEPSEEK_API_KEY: secretProbe,
  AGENT_SESSION_SECRET: "synthetic-session-signing-secret-with-32-bytes",
  AGENT_PUBLIC_ORIGIN: origin, AGENT_CORS_ORIGIN: origin,
} });
let browser;
const output = resolve("artifacts/acceptance/R2/auth");
try {
  await server.app.listen({ host: "127.0.0.1", port });
  await server.runtime.appendEvent(server.runtime.createEvent("ui-secret-probe", "run.started", { title: "Security probe", detail: secretProbe }));
  browser = await chromium.launch({ headless: true });
  await mkdir(output, { recursive: true });
  const pageErrors = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal((await context.request.get(`${origin}/api/memory/export`)).status(), 401);
    await page.screenshot({ path: resolve(output, `login-${viewport.width}.png`) });
    for (const user of users) {
      await page.getByLabel("User ID").fill(user.id);
      await page.getByLabel("Access secret").fill(user.secret);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const runButton = page.getByRole("button", { name: "Run now", exact: true });
      await runButton.waitFor();
      assert.equal(await runButton.isEnabled(), user.role === "operator");
      assert.equal((await page.locator("body").innerText()).includes(secretProbe), false);
      const session = await context.request.get(`${origin}/api/auth/session`).then((response) => response.json());
      const result = await context.request.post(`${origin}/api/runs/run-now`, { headers: { "x-csrf-token": session.csrfToken }, data: {} });
      assert.equal(result.status(), user.role === "operator" ? 200 : 403);
      if (user.role === "operator") {
        const { runId } = await result.json();
        const headers = { "x-csrf-token": session.csrfToken };
        const operation = { runId, tool: "memory_clear", args: { confirmation: "clear-memory" } };
        assert.equal((await context.request.post(`${origin}/api/tools/execute`, { headers, data: operation })).status(), 403);
        const grant = await context.request.post(`${origin}/api/security/approvals`, { headers, data: operation });
        assert.equal(grant.status(), 200);
        const { id } = await grant.json();
        assert.equal((await context.request.post(`${origin}/api/security/approvals/${id}/approve`, { headers, data: {} })).status(), 200);
        const execute = () => context.request.post(`${origin}/api/tools/execute`, { headers, data: { ...operation, approvalId: id } });
        assert.equal((await execute()).status(), 200);
        assert.equal((await execute()).status(), 403);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: resolve(output, `${user.role}-${viewport.width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
      assert.equal((await context.request.get(`${origin}/api/memory/export`)).status(), 401);
    }
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  const report = { checkedAt: new Date().toISOString(), viewports: [1440, 390], anonymousDenied: true, viewerDenied: true, operatorAllowed: true, boundApprovalExecutedOnce: true, logoutRevoked: true, secretAbsentFromUi: true, pageErrors, provider: "existing demo execution only; no live provider or production readiness claim" };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await server.app.close();
  server.database.sqlite.close();
}
