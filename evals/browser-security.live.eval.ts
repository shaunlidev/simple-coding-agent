import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SafeNetwork } from "@simple-coding-agent/security";
import { readBrowserSource } from "@simple-coding-agent/runtime";

test("R2.4 actual Chromium blocks private HTTP, websocket, POST and off-list subrequests", { skip: process.env.RUN_BROWSER_LIVE !== "1" }, async () => {
  let privateHits = 0;
  const privateServer = createServer((_request, response) => { privateHits++; response.end("private"); });
  privateServer.on("upgrade", (_request, socket) => { privateHits++; socket.destroy(); });
  await new Promise<void>((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
  const address = privateServer.address();
  assert.ok(address && typeof address === "object");
  const privateUrl = `http://127.0.0.1:${address.port}`;
  const transported: string[] = [];
  const html = `<!doctype html><title>Source fixture</title><body><h1>Actual browser fixture</h1><script>
    document.body.append(' Dynamic content executed');
    fetch('${privateUrl}/private').catch(() => {});
    fetch('https://off-list.test/steal').catch(() => {});
    fetch('https://allowed.test/write', {method:'POST',body:'denied'}).catch(() => {});
    const socket = new WebSocket('ws://127.0.0.1:${address.port}/socket'); socket.onerror = () => {};
    const image = new Image(); image.src = '${privateUrl}/image'; document.body.append(image);
  </script><a href="/article">An allowed article</a></body>`;
  const network = new SafeNetwork({ allowlist: ["https://allowed.test", privateUrl], resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: async ({ url }) => {
    transported.push(url.href);
    return { url: url.href, status: 200, headers: { "content-type": "text/html" }, body: new TextEncoder().encode(html) };
  } });
  try {
    const result = await readBrowserSource(network, "https://allowed.test/article");
    assert.match(result.text, /Dynamic content executed/);
    assert.equal(privateHits, 0);
    assert.deepEqual(transported, ["https://allowed.test/article"]);
    for (const rejected of [privateUrl, "https://off-list.test", "https://allowed.test/write", "ws://127.0.0.1"]) assert.equal(result.blockedRequests.some((url) => url.startsWith(rejected)), true, rejected);
  } finally { privateServer.closeAllConnections(); await new Promise<void>((resolve) => privateServer.close(() => resolve())); }
});
