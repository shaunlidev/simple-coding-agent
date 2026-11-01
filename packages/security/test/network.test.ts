import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SafeNetwork, isPublicAddress, pinnedLookup } from "../src/network.ts";

const publicAddress = { address: "93.184.216.34", family: 4 };

test("R2.4 network blocks private/encoded/mapped/reserved addresses and off-list origins before transport", async () => {
  for (const address of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "192.168.1.1", "172.31.1.1", "0.0.0.0", "100.64.1.1", "198.18.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(address), false, address);
  let calls = 0;
  const network = new SafeNetwork({ allowlist: ["https://allowed.test"], resolve: async () => [publicAddress, { address: "127.0.0.1", family: 4 }], transport: async ({ url }) => { calls++; return { url: url.href, status: 200, headers: {}, body: new Uint8Array() }; } });
  for (const url of ["https://evil.test/", "https://allowed.test:444/", "file:///etc/passwd", "https://user:password@allowed.test/", "https://allowed.test/"]) await assert.rejects(network.read(url));
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/"]) await assert.rejects(new SafeNetwork({ allowlist: [new URL(url).origin] }).read(url), /destination denied/);
  assert.equal(calls, 0);
});

test("R2.4 real loopback listener receives no request, even when its origin is allowlisted", async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("private"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await assert.rejects(new SafeNetwork({ allowlist: [origin] }).read(origin), /destination denied/);
    assert.equal(requests, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("R2.4 redirect policy prevents a second request and pins the validated address", async () => {
  const calls: string[] = [];
  const network = new SafeNetwork({ allowlist: ["https://allowed.test"], resolve: async () => [publicAddress], transport: async ({ url, address }) => {
    assert.deepEqual(address, publicAddress);
    calls.push(url.href);
    return { url: url.href, status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, body: new Uint8Array() };
  } });
  await assert.rejects(network.read("https://allowed.test"), /outside allowlist/);
  assert.deepEqual(calls, ["https://allowed.test/"]);
  pinnedLookup(publicAddress)("rebinding.test", { all: false }, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, publicAddress.address); assert.equal(family, 4);
  });
});

test("R2.4 bounded reads stop oversized responses, endless redirects, slow DNS and cancellation", async () => {
  const base = { allowlist: ["https://allowed.test"], resolve: async () => [publicAddress] };
  await assert.rejects(new SafeNetwork({ ...base, maxBytes: 2, transport: async ({ url }) => ({ url: url.href, status: 200, headers: {}, body: new Uint8Array(3) }) }).read("https://allowed.test"), /byte limit/);
  let redirects = 0;
  await assert.rejects(new SafeNetwork({ ...base, maxRedirects: 1, transport: async ({ url }) => { redirects++; return { url: url.href, status: 302, headers: { location: "/again" }, body: new Uint8Array() }; } }).read("https://allowed.test"), /redirect limit/);
  assert.equal(redirects, 2);
  const timer = setTimeout(() => {}, 100);
  try {
    await assert.rejects(new SafeNetwork({ ...base, timeoutMs: 10, resolve: async () => new Promise(() => {}) }).read("https://allowed.test"), /timeout/i);
  } finally { clearTimeout(timer); }
  await assert.rejects(new SafeNetwork(base).read("https://allowed.test", { signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
});
