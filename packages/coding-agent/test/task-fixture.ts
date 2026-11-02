import { SafeNetwork } from "@simple-coding-agent/security";
export const localSecret = "synthetic-local-operator-secret-over-32-characters";
export const localEnv = { AGENT_AUTH_USERS: JSON.stringify([{ id: "owner", role: "operator", secret: localSecret }, { id: "reader", role: "viewer", secret: "synthetic-viewer-secret-over-32-characters" }]), AGENT_LOCAL_USER: "owner", AGENT_LOCAL_SECRET: localSecret };
export const fixtureNetwork = (body = "A practical coding agent update about reliable queues and exact evidence for acceptance.") => new SafeNetwork({
  allowlist: ["https://source.test"], resolve: async () => [{ address: "8.8.8.8", family: 4 }],
  transport: async ({ url }) => ({ url: url.href, status: 200, headers: { "content-type": body.startsWith("<rss") ? "application/rss+xml" : "text/plain" }, body: new TextEncoder().encode(body) }),
});
