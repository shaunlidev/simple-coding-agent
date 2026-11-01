import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

export type NetworkDocument = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

type NetworkOptions = {
  allowlist: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  transport?: typeof pinnedRequest;
};

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; }
  catch { return false; }
}

export function permittedUrl(value: string, allowlist: readonly string[]): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Network policy: protocol or credentials denied");
  const allowed = allowlist.some((entry) => {
    try { return new URL(entry).origin === url.origin; } catch { return false; }
  });
  if (!allowed) throw new Error("Network policy: origin is outside allowlist");
  url.hash = "";
  return url;
}

export function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ ...address }]);
    else callback(null, address.address, address.family);
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function pinnedRequest(input: { url: URL; address: LookupAddress; signal: AbortSignal; maxBytes: number }): Promise<NetworkDocument> {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(input.address) } });
  try {
    const response = await fetch(input.url, { dispatcher, redirect: "manual", signal: input.signal, headers: { "user-agent": "AgentOps/0.1", accept: "text/html,application/xml,text/xml,application/json,text/plain,*/*;q=0.1" } });
    const headers = Object.fromEntries(response.headers);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      return { url: input.url.href, status: response.status, headers, body: new Uint8Array() };
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > input.maxBytes) {
          await reader.cancel();
          throw new Error("Network policy: response exceeds byte limit");
        }
        chunks.push(chunk.value);
      }
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { url: input.url.href, status: response.status, headers, body };
  } finally { await dispatcher.destroy(); }
}

export class SafeNetwork {
  constructor(private readonly options: NetworkOptions) {}

  async validate(value: string, signal?: AbortSignal): Promise<{ url: URL; address: LookupAddress }> {
    const url = permittedUrl(value, this.options.allowlist);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literal = ipaddr.isValid(hostname);
    const resolving = literal
      ? Promise.resolve([{ address: hostname, family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 }])
      : (this.options.resolve ?? ((host) => lookup(host, { all: true })))(hostname);
    const addresses = await abortable(resolving, signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 10_000));
    const address = addresses[0];
    if (!address || addresses.some((candidate) => !isPublicAddress(candidate.address))) throw new Error("Network policy: private or reserved destination denied");
    return { url, address };
  }

  async read(value: string, options: { signal?: AbortSignal; followRedirects?: boolean } = {}): Promise<NetworkDocument> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let next = value;
    for (let redirects = 0; redirects <= (this.options.maxRedirects ?? 3); redirects++) {
      signal.throwIfAborted();
      const destination = await this.validate(next, signal);
      signal.throwIfAborted();
      const result = await abortable((this.options.transport ?? pinnedRequest)({ ...destination, signal, maxBytes: this.options.maxBytes ?? 2 * 1024 * 1024 }), signal);
      if (result.body.byteLength > (this.options.maxBytes ?? 2 * 1024 * 1024)) throw new Error("Network policy: response exceeds byte limit");
      if (![301, 302, 303, 307, 308].includes(result.status)) return result;
      if (!result.headers.location) throw new Error("Network policy: redirect has no location");
      next = new URL(result.headers.location, destination.url).href;
      await this.validate(next, signal);
      if (options.followRedirects === false) return result;
    }
    throw new Error("Network policy: redirect limit exceeded");
  }
}
