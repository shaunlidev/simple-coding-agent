import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scanForSecrets } from "../packages/security/src/index.ts";

async function text(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}

test("deployment readiness files define health checks, CI gates, and safe examples", async () => {
  const [dockerfile, compose, ci, packageJson, envExample, readme, gitignore] = await Promise.all([
    text("Dockerfile"),
    text("docker-compose.yml"),
    text(".github/workflows/ci.yml"),
    text("package.json"),
    text(".env.example"),
    text("README.md"),
    text(".gitignore"),
  ]);

  assert.equal(dockerfile.includes("HEALTHCHECK"), true);
  assert.equal(dockerfile.includes("/healthz"), true);
  assert.equal(compose.includes("agent-api"), true);
  assert.equal(compose.includes("dashboard"), true);
  assert.equal(compose.includes("service_healthy"), true);
  assert.equal(packageJson.includes("\"db:migrate\""), true);
  assert.equal(packageJson.includes("\"db:seed\""), true);
  for (const gate of ["npm run check", "npm run build", "npm run check:package-boundaries", "npm run dashboard:build", "npm run test", "npm run eval"]) {
    assert.equal(ci.includes(gate), true, `missing CI gate ${gate}`);
  }
  assert.equal(readme.includes("docker compose up --build"), true);
  assert.equal(readme.includes("AGENT_REQUIRE_PRODUCTION_SECRETS=1"), true);
  assert.match(gitignore, /^\.env$/m);
  assert.equal(scanForSecrets(envExample).passed, true);
  assert.equal(scanForSecrets(`${dockerfile}\n${compose}\n${ci}\n${readme}`).passed, true);
});
