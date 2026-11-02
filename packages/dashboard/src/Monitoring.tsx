import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { approveOutputPrune, fetchMonitoring, requestOutputPrune, type PruneOperation } from "./api.js";

const labels: Record<string, string> = { heartbeat_stale: "Heartbeat stale", worker_fault: "Worker fault", error_burst: "Run failures" };
const time = (value: string | null) => value ? new Date(value).toLocaleString("en", { hour12: false }) : "Not recorded";

function OutputRetention({ runId }: { runId?: string }) {
  const client = useQueryClient();
  const [pending, setPending] = useState<(PruneOperation & { approvalId: string }) | null>(null);
  const [cursor, setCursor] = useState(0);
  const requested = useMutation({ mutationFn: async (operation: PruneOperation) => { const approval = await requestOutputPrune(operation); setPending({ ...operation, approvalId: approval.id }); } });
  const prune = useMutation({ mutationFn: approveOutputPrune, onSuccess: async (receipt) => { setPending(null); setCursor(receipt.examinedThrough); await client.invalidateQueries({ queryKey: ["runtime-snapshot"] }); } });
  return <details className="outputRetention"><summary>Output retention</summary>
    <form className="retentionForm" onSubmit={(event) => {
      event.preventDefault(); if (!runId) return;
      const form = new FormData(event.currentTarget);
      requested.mutate({ runId, args: { key: crypto.randomUUID(), before: new Date(String(form.get("before"))).toISOString(), maxRows: Number(form.get("maxRows")), afterSequence: cursor } });
    }}>
      <label>Output before (UTC)<input name="before" type="date" required max={new Date().toISOString().slice(0, 10)} disabled={Boolean(pending)} /></label>
      <label>Batch limit<input name="maxRows" type="number" min={1} max={5000} defaultValue={500} required disabled={Boolean(pending)} /></label>
      <label>After sequence<input type="number" min={0} max={Number.MAX_SAFE_INTEGER} value={cursor} onChange={(event) => setCursor(Number(event.target.value))} disabled={Boolean(pending)} /></label>
      <button className="secondaryButton" disabled={!runId || Boolean(pending) || requested.isPending}><Trash2 size={16} aria-hidden="true" /> Request cleanup</button>
    </form>
    {!runId ? <p>A started run is required for approval.</p> : null}
    {pending ? <div className="retentionApproval" role="group" aria-label="Output cleanup approval">
      <p>Delete eligible output deltas before {time(pending.args.before)}. Up to {pending.args.maxRows} candidates after sequence {pending.args.afterSequence}. Run evidence is retained.</p>
      <div className="rowActions"><button className="secondaryButton" onClick={() => prune.mutate(pending)} disabled={prune.isPending}><Check size={16} aria-hidden="true" /> Approve cleanup</button><button className="iconButton" title="Cancel cleanup" aria-label="Cancel cleanup" onClick={() => setPending(null)} disabled={prune.isPending}><X size={16} aria-hidden="true" /></button></div>
    </div> : null}
    {requested.error || prune.error ? <p role="alert">{(requested.error ?? prune.error)?.message}</p> : null}
    {prune.data ? <p role="status">Deleted {prune.data.deleted} of {prune.data.examined} examined deltas. Cursor {prune.data.examinedThrough}. Receipt {prune.data.deletedIdsHash.slice(0, 12)}.</p> : null}
  </details>;
}

export function Monitoring({ canOperate, runId }: { canOperate: boolean; runId?: string }) {
  const state = useQuery({ queryKey: ["worker-monitoring"], queryFn: fetchMonitoring, refetchInterval: 2000 });
  const health = state.data?.health;
  return <section className="monitoringBand" aria-label="Worker monitoring">
    <header><h2>Worker monitoring</h2><button className="iconButton" aria-label="Refresh monitoring" title="Refresh monitoring" disabled={state.isFetching} onClick={() => { void state.refetch(); }}><RefreshCw size={16} aria-hidden="true" /></button></header>
    {state.isError ? <p role="alert">Monitoring unavailable: {state.error.message}</p> : !health ? <p role="status">Loading worker state...</p> : <>
      <dl className="monitorReadings">
        <div><dt>Readiness</dt><dd data-testid="worker-readiness" className={health.ready ? "monitorGood" : "monitorBad"}>{health.ready ? "Ready" : "Not ready"}</dd></div>
        <div><dt>Heartbeat</dt><dd data-testid="worker-heartbeat">{health.worker.heartbeat}</dd></div>
        <div><dt>Worker</dt><dd data-testid="worker-phase">{health.worker.phase}</dd></div>
        <div><dt>Database</dt><dd>{health.database}</dd></div>
        <div><dt>Monitor</dt><dd>{health.monitor.freshness}</dd></div>
        <div><dt>Last heartbeat</dt><dd>{time(health.worker.lastHeartbeatAt)}</dd></div>
      </dl>
      {health.reasons.length ? <p className="monitorReasons">{health.reasons.map((reason) => reason.replaceAll("_", " ")).join("; ")}{health.worker.phase === "faulted" ? ". Drain and restart the worker." : ""}</p> : null}
      <details className="monitorAlerts"><summary>Recent alerts ({state.data?.alerts.length ?? 0})</summary>
        <ol>{state.data?.alerts.slice().reverse().map((alert) => <li key={alert.sequence}>
          <span className={alert.edge === "open" ? "monitorBad" : "monitorGood"}>{labels[alert.condition] ?? alert.condition}: {alert.edge}</span><time dateTime={alert.observedAt}>{time(alert.observedAt)}</time>
          <small>{alert.evidence.source} / {alert.evidence.severity} / generation {alert.generation} / rule {alert.evidence.ruleVersion} / event {alert.evidence.watermark}{alert.condition === "error_burst" ? ` / ${alert.evidence.failedRuns} failed runs` : ""}</small>
          {alert.evidence.runIds.length ? <small>Runs: {alert.evidence.runIds.join(", ")}{alert.evidence.sampleTruncated ? " (latest 20)" : ""}</small> : null}
        </li>)}</ol>
        {!state.data?.alerts.length ? <p>No alert transitions recorded.</p> : null}
      </details>
    </>}
    {canOperate ? <OutputRetention runId={runId} /> : null}
  </section>;
}
