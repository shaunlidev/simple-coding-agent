import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const image = process.argv[2] ?? "simple-coding-agent:r2";
const name = `agent-r2-${process.pid}-${Date.now()}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
const architecture = docker("image", "inspect", "--format={{.Architecture}}", image);
const output = resolve("artifacts/acceptance/R2/container", architecture);
const fixture = await mkdtemp(resolve(tmpdir(), "agent-tls-"));
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const tlsPort = probe.address().port;
await new Promise((done) => probe.close(done));
const tlsOrigin = `https://localhost:${tlsPort}`;
const credential = "harness-only-operator-credential-32-bytes";
let started = false;
let browser;

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", resolve(fixture, "key.pem"), "-out", resolve(fixture, "cert.pem"), "-subj", "/CN=localhost"], { stdio: "ignore" });
  await chmod(fixture, 0o755);
  await chmod(resolve(fixture, "key.pem"), 0o644);
  await copyFile(resolve("scripts/container-tls-proxy.mjs"), resolve(fixture, "container-tls-proxy.mjs"));
  docker("run", "--detach", "--rm", "--name", name,
    "--publish", "127.0.0.1::4175", "--health-interval=2s", "--health-start-period=1s",
    "--publish", `127.0.0.1:${tlsPort}:4443`, "--mount", `type=bind,source=${fixture},target=/verification,readonly`,
    "--env", "AGENT_TRUST_PROXY=1", "--env", `AGENT_PUBLIC_ORIGIN=${tlsOrigin}`, "--env", `AGENT_CORS_ORIGIN=${tlsOrigin}`,
    "--env", "AGENT_SESSION_SECRET=harness-only-session-signing-secret-32-bytes",
    "--env", `AGENT_AUTH_USERS=${JSON.stringify([{ id: "owner", role: "operator", secret: credential }])}`,
    "--env", "DEEPSEEK_API_KEY=harness-only-no-provider-calls", image);
  started = true;
  const port = docker("port", name, "4175/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (docker("inspect", "--format={{.State.Health.Status}}", name) === "healthy") {
      healthy = true;
      break;
    }
    await delay(1000);
  }
  assert.equal(healthy, true, "container did not become healthy");
  const health = await fetch(`${origin}/healthz`).then((response) => response.json());
  const ready = await fetch(`${origin}/readyz`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(ready.ok, true);
  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  assert.equal(docker("inspect", "--format={{.Config.User}}", name), "node");
  assert.equal(docker("exec", name, "node", "-e", "console.log(require('node:fs').existsSync('/app/.env'))"), "false");
  assert.equal(docker("exec", name, "node", "packages/coding-agent/dist/entry.js", "--help").includes("Usage"), true);
  assert.equal(docker("exec", name, "node", "packages/tui/dist/entry.js", "--help").includes("Usage"), true);
  let missingKeyFailed = false;
  try {
    docker("exec", "-e", "DEEPSEEK_API_KEY=", name, "node", "packages/coding-agent/dist/entry.js", "--print", "Reply exactly ok");
  } catch (error) {
    missingKeyFailed = `${error.stderr}`.includes("DEEPSEEK_API_KEY is required");
  }
  assert.equal(missingKeyFailed, true);

  await mkdir(output, { recursive: true });
  docker("exec", "--detach", name, "node", "/verification/container-tls-proxy.mjs");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if ((await context.request.get(`${tlsOrigin}/healthz`)).ok()) break; }
    catch { if (attempt === 19) throw new Error("TLS proxy did not start"); }
    await delay(200);
  }
  await page.goto(tlsOrigin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("User ID").fill("owner");
  await page.getByLabel("Access secret").fill(credential);
  const apiResponse = page.waitForResponse((response) => response.url() === `${tlsOrigin}/api/snapshot` && response.status() === 200);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await apiResponse;
  await page.getByRole("button", { name: "Run now", exact: true }).waitFor();
  assert.equal(await page.getByText("API offline", { exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  const cookies = await context.cookies();
  assert.equal(cookies.some((cookie) => cookie.name === "__Host-agent-session" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict"), true);
  assert.equal((await context.request.post(`${tlsOrigin}/api/runs/run-now`, { data: {} })).status(), 403);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal((await context.request.get(`${tlsOrigin}/api/memory/export`)).status(), 401);
  const report = {
    batch: "R2", image, imageId: docker("inspect", "--format={{.Image}}", name),
    architecture,
    healthy, health, ready, nonRoot: true, secretsAbsent: true,
    cliHelp: true, tuiHelp: true, missingKeyFailed, browserSameOriginApi: true, pageErrors,
    tlsLogin: true, secureCookie: true, csrfEnforced: true, logoutRevoked: true,
    tlsBoundary: "ephemeral self-signed acceptance certificate and loopback proxy, not a cloud certificate",
    provider: "not exercised; the container uses a synthetic key for startup only",
    checkedAt: new Date().toISOString(),
  };
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  if (started) docker("rm", "--force", name);
  await rm(fixture, { recursive: true, force: true });
}
