import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { nextRunAt } from "../src/index.ts";

test("R5.1 calendar time is independent of the process timezone", () => {
  const source = new URL("../src/index.ts", import.meta.url).href;
  const code = `import {nextRunAt} from ${JSON.stringify(source)}; console.log(nextRunAt({cron:"0 9 * * *",timezone:"Asia/Shanghai"},new Date("2026-11-01T00:00:00Z")))`;
  for (const TZ of ["UTC", "Asia/Shanghai"]) {
    const result = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", code], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "2026-11-01T01:00:00.000Z");
  }
});

test("R5.1 weekdays and DST use explicit calendar semantics", () => {
  assert.equal(nextRunAt({ cron: "0 9 * * 1", timezone: "Asia/Shanghai" }, new Date("2026-11-01T02:00:00Z")), "2026-11-02T01:00:00.000Z");
  // cron-parser shifts a nonexistent spring time forward and does not replay a fall fold.
  assert.equal(nextRunAt({ cron: "30 2 * * *", timezone: "America/New_York" }, new Date("2026-03-08T06:00:00Z")), "2026-03-08T07:30:00.000Z");
  assert.equal(nextRunAt({ cron: "30 1 * * *", timezone: "America/New_York" }, new Date("2026-11-01T05:31:00Z")), "2026-11-02T06:30:00.000Z");
});

test("R5.1 invalid schedules fail instead of silently becoming minutely work", () => {
  for (const cron of ["garbage", "61 9 * * *", "@every 0s", "@every 999999999999999999999d"]) {
    assert.throws(() => nextRunAt({ cron, timezone: "UTC" }, new Date("2026-11-01T00:00:00Z")));
  }
  assert.throws(() => nextRunAt({ cron: "0 9 * * *", timezone: "Invalid/Timezone" }));
  assert.throws(() => nextRunAt({ cron: "@every 1h", timezone: "UTC" }, new Date("invalid")));
});
