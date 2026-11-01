import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";

// Acceptance-only TLS terminator. It forwards solely to this container's loopback API.
createServer({ key: readFileSync("/verification/key.pem"), cert: readFileSync("/verification/cert.pem") }, (incoming, outgoing) => {
  const upstream = request({ hostname: "127.0.0.1", port: 4175, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, "x-forwarded-proto": "https" } }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
}).listen(4443, "0.0.0.0");
