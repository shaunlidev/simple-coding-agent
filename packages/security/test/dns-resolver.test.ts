import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareResolver, SafeNetwork } from "../src/network.ts";

function resolver(answer: (type: number) => string, wrongQuestion = false) {
  return createCloudflareResolver(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://cloudflare-dns.com");
    assert.equal(init?.redirect, "error");
    const type = Number(url.searchParams.get("type"));
    return Response.json({ Status: 0, TC: false, Question: [{ name: wrongQuestion ? "other.test" : url.searchParams.get("name"), type }], Answer: [{ type, data: answer(type) }] });
  });
}

test("explicit trusted DNS returns both address families; source transport still uses pinned public address", async () => {
  let requests = 0;
  const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: resolver((type) => type === 1 ? "8.8.8.8" : "2606:4700:4700::1111"), transport: async ({ url, address }) => {
    requests++; assert.equal(address.address, "8.8.8.8");
    return { url: url.href, status: 200, headers: {}, body: new Uint8Array() };
  } });
  assert.equal((await network.read("https://source.test")).status, 200);
  assert.equal(requests, 1);
});

test("trusted DNS cannot authorize private mixed-family answers or off-allowlist origins", async () => {
  let requests = 0;
  const network = new SafeNetwork({ allowlist: ["https://source.test"], resolve: resolver((type) => type === 1 ? "8.8.8.8" : "::1"), transport: async () => { requests++; throw new Error("must not connect"); } });
  await assert.rejects(network.read("https://source.test"), /private or reserved/);
  await assert.rejects(network.read("https://offlist.test"), /outside allowlist/);
  assert.equal(requests, 0);
});

test("DNS malformed responses, wrong questions and oversized bodies fail closed", async () => {
  await assert.rejects(resolver(() => "8.8.8.8", true)("source.test"), /question mismatch/);
  await assert.rejects(createCloudflareResolver(async () => Response.json({ Status: 3, TC: false }))("source.test"));
  await assert.rejects(createCloudflareResolver(async () => new Response("x".repeat(65537)))("source.test"), /byte limit/);
});
