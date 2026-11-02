import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentEnvironment } from "./index.js";

const userSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), role: z.enum(["viewer", "operator"]), secret: z.string().min(32).max(256) }).strict();
const usersSchema = z.array(userSchema).max(50).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Duplicate identity");
export type AuthIdentity = Pick<z.infer<typeof userSchema>, "id" | "role">;

export function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export function parseAuthUsers(env: AgentEnvironment) {
  let users: Array<z.infer<typeof userSchema>>;
  try { users = usersSchema.parse(JSON.parse(env.AGENT_AUTH_USERS)); }
  catch { throw new Error("AGENT_AUTH_USERS must contain unique id, viewer/operator role and a 32-character secret per identity"); }
  if (env.NODE_ENV === "production" && !users.some((user) => user.role === "operator")) throw new Error("Production requires a configured operator in AGENT_AUTH_USERS");
  return users;
}

export function authenticateLocalIdentity(env: AgentEnvironment, credentials: { id?: string; secret?: string }): AuthIdentity {
  const user = parseAuthUsers(env).find((candidate) => candidate.id === credentials.id);
  const matches = equalSecret(credentials.secret ?? "", user?.secret ?? "invalid-unconfigured-identity-credential");
  if (!user || !matches || !credentials.secret) throw Object.assign(new Error("Local authentication failed; configure AGENT_LOCAL_USER and AGENT_LOCAL_SECRET for an AGENT_AUTH_USERS identity"), { statusCode: 401 });
  return { id: user.id, role: user.role };
}

export function requireOperator(identity: AuthIdentity): void {
  if (identity.role !== "operator") throw Object.assign(new Error("Operator permission is required"), { statusCode: 403 });
}
