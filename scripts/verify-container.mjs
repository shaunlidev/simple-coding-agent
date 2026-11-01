import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const image = process.argv[2] ?? "simple-coding-agent:r1";
const name = `agent-r1-${process.pid}-${Date.now()}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
const architecture = docker("image", "inspect", "--format={{.Architecture}}", image);
const output = resolve("artifacts/acceptance/R1", architecture);
let started = false;
let browser;

try {
  docker("run", "--detach", "--rm", "--name", name,
    "--publish", "127.0.0.1::4175", "--health-interval=2s", "--health-start-period=1s",
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
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const apiResponse = page.waitForResponse((response) => response.url() === `${origin}/api/snapshot` && response.status() === 200);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await apiResponse;
  await page.getByRole("button", { name: "Run now", exact: true }).waitFor();
  assert.equal(await page.getByText("API offline", { exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  const report = {
    batch: "R1", image, imageId: docker("inspect", "--format={{.Image}}", name),
    architecture,
    healthy, health, ready, nonRoot: true, secretsAbsent: true,
    cliHelp: true, tuiHelp: true, missingKeyFailed, browserSameOriginApi: true, pageErrors,
    provider: "not exercised; the container uses a synthetic key for startup only",
    checkedAt: new Date().toISOString(),
  };
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  if (started) docker("rm", "--force", name);
}
