import { createServer } from "node:http";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import type { SafeNetwork } from "@simple-coding-agent/security";

export async function readBrowserSource(network: SafeNetwork, url: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const lifecycle = new AbortController();
  const signal = AbortSignal.any([timeout, lifecycle.signal, ...(options.signal ? [options.signal] : [])]);
  await network.validate(url, signal);
  // Every browser request is fulfilled by SafeNetwork. The deny proxy catches unrouted browser channels.
  const denyProxy = createServer((_request, response) => response.writeHead(403).end());
  denyProxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { denyProxy.once("error", reject); denyProxy.listen(0, "127.0.0.1", resolve); });
  let browser: Browser | undefined;
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  const blockedRequests: string[] = [];
  try {
    const address = denyProxy.address();
    if (!address || typeof address === "string") throw new Error("Browser network isolation unavailable");
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: timeoutMs,
      proxy: { server: `http://127.0.0.1:${address.port}`, bypass: "<-loopback>" },
      args: ["--disable-background-networking", "--disable-quic", "--dns-prefetch-disable", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, permissions: [] });
    let pages = 0;
    context.on("page", (page) => { if (++pages > 1) void page.close(); });
    let requests = 0;
    let totalBytes = 0;
    await context.routeWebSocket("**/*", (socket) => { blockedRequests.push(socket.url()); socket.close(); });
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        if (++requests > 50 || totalBytes >= 8 * 1024 * 1024) throw new Error("Browser request budget exceeded");
        if (request.method() !== "GET") throw new Error("Read-only browser denies non-GET requests");
        const response = await network.read(request.url(), { signal, followRedirects: false });
        totalBytes += response.body.byteLength;
        if (totalBytes > 8 * 1024 * 1024) throw new Error("Browser byte budget exceeded");
        const headers: Record<string, string> = {};
        for (const key of ["content-type", "location", "content-security-policy", "access-control-allow-origin"]) {
          const value = response.headers[key];
          if (value) headers[key] = value;
        }
        await route.fulfill({ status: response.status, headers, body: Buffer.from(response.body) });
      } catch {
        blockedRequests.push(request.url());
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    if (!response?.ok()) throw new Error("Browser source navigation failed");
    await page.waitForLoadState("networkidle", { timeout: Math.min(2000, timeoutMs) }).catch(() => {});
    signal.throwIfAborted();
    return {
      title: await page.title(), url: page.url(), text: (await page.locator("body").innerText()).slice(0, 100_000),
      links: await page.locator("a[href]").evaluateAll((links) => links.slice(0, 100).flatMap((link) => {
        const href = link.getAttribute("href");
        if (!href) return [];
        try {
          const url = new URL(href, document.baseURI);
          return ["http:", "https:"].includes(url.protocol) ? [{ text: link.textContent ?? "", url: url.href }] : [];
        } catch { return []; }
      })),
      blockedRequests,
    };
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    lifecycle.abort(new Error("Browser source closed"));
    await browser?.close();
    denyProxy.closeAllConnections();
    await new Promise<void>((resolve) => denyProxy.close(() => resolve()));
  }
}
