import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchSession, login, logout } from "./api.js";
import { App } from "./App.js";

const sessionKey = ["auth-session"];

export function AuthGate() {
  const client = useQueryClient();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const session = useQuery({ queryKey: sessionKey, queryFn: fetchSession, retry: false, refetchInterval: 30_000 });
  const signIn = useMutation({ mutationFn: login, onSuccess: (value) => {
    setSecret("");
    client.clear();
    client.setQueryData(sessionKey, value);
  } });
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => {
    client.clear();
    client.setQueryData(sessionKey, null);
  } });
  useEffect(() => {
    const expired = () => { client.clear(); client.setQueryData(sessionKey, null); };
    window.addEventListener("agent-auth-expired", expired);
    return () => window.removeEventListener("agent-auth-expired", expired);
  }, [client]);

  if (session.isPending) return <main className="authShell"><p role="status">Connecting...</p></main>;
  if (session.isError) return <main className="authShell"><h1>Connection unavailable</h1><button className="secondaryButton" onClick={() => void session.refetch()}>Retry</button></main>;
  if (!session.data) return (
    <main className="authShell">
      <h1>Agent Ops</h1>
      <form onSubmit={(event) => { event.preventDefault(); signIn.mutate({ id, secret }); }}>
        <label htmlFor="identity">User ID</label>
        <input id="identity" name="username" autoComplete="username" value={id} onChange={(event) => setId(event.target.value)} maxLength={64} required />
        <label htmlFor="credential">Access secret</label>
        <input id="credential" name="password" type="password" autoComplete="current-password" value={secret} onChange={(event) => setSecret(event.target.value)} maxLength={256} required />
        {signIn.isError ? <p role="alert">Sign-in failed. Check your credentials and try again.</p> : null}
        <button className="primaryButton" disabled={signIn.isPending} type="submit">{signIn.isPending ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
  return <>
    <header className="accountBar"><strong>Agent Ops</strong><span>{session.data.user.id} ({session.data.user.role})</span><button className="secondaryButton" disabled={signOut.isPending} onClick={() => signOut.mutate()}>Sign out</button></header>
    {signOut.isError ? <p role="alert" className="alert">Sign-out failed. Try again.</p> : null}
    <App canOperate={session.data.user.role === "operator"} />
  </>;
}
