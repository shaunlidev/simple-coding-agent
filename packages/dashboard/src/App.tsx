import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchRun, fetchRuns, fetchSnapshot, patchSchedule, runNow, type DeliveredContentItem, type EvalGate, type RuntimeEvent, type RuntimeSchedule, type RuntimeSnapshot, type RuntimeSpan, type RuntimeStep } from "./api.js";
import { fetchTasks, cancelRun, runSchedule } from "./api.js";
import { TaskConfig } from "./TaskConfig.js";
import { ScheduleConfig } from "./ScheduleConfig.js";
import { FeedbackControls } from "./FeedbackControls.js";
import { MemoryWorkbench } from "./MemoryWorkbench.js";
import { Monitoring } from "./Monitoring.js";
import { Download } from "lucide-react";
import { fetchTrace } from "./api.js";

const snapshotKey = ["runtime-snapshot"] as const;

function formatNumber(value: number | null | undefined, options: Intl.NumberFormatOptions = {}) {
  return value === null || value === undefined ? "Unknown" : new Intl.NumberFormat("en", options).format(value);
}

function formatTime(value?: string, timezone?: string) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    ...(timezone ? { timeZone: timezone } : {}),
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPercent(value: number | null) {
  return value === null ? "No samples" : `${formatNumber(value * 100, { maximumFractionDigits: 1 })}%`;
}

function formatDuration(value: number | null | undefined) { return value == null ? "Unknown" : `${formatNumber(value)} ms`; }
function formatCost(value: number | null, status: string) { return value === null ? status.replaceAll("_", " ") : `$${value.toFixed(6)}`; }

function eventDetail(event: RuntimeEvent) {
  const detail = event.payload.detail ?? event.payload.reason ?? event.payload.count ?? event.payload.action;
  return detail === undefined ? event.type : String(detail);
}

function statusClass(status: string) {
  if (["passed", "completed", "ok", "idle"].includes(status)) return "is-ok";
  if (["running", "planned", "skipped"].includes(status)) return "is-live";
  if (["failed", "error", "critical", "denied"].includes(status)) return "is-bad";
  return "is-muted";
}

function Card(props: { title: string; eyebrow?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
          <h2>{props.title}</h2>
        </div>
        {props.action ? <div className="panelAction">{props.action}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

function MetricTile(props: { label: string; value: string; detail: string; tone?: "ok" | "warn" | "bad" | "live" }) {
  return (
    <div className={`metricTile ${props.tone ? `tone-${props.tone}` : ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </div>
  );
}

function Cockpit(props: { snapshot: RuntimeSnapshot; onRunNow: () => void; isRunning: boolean; canOperate: boolean; taskSelector: React.ReactNode; hasTask: boolean }) {
  const run = props.snapshot.latestRun;
  return (
    <section className="cockpit">
      <div className="cockpitCopy">
        <p className="eyebrow">Agent Operations Dashboard</p>
        <h1>{props.snapshot.agent.name}</h1>
        <div className="statusLine">
          <span className={`statusPill ${statusClass(props.snapshot.agent.status)}`}>{props.snapshot.agent.status}</span>
          <span>{props.snapshot.agent.mode} mode</span>
          <span>{props.snapshot.events.length} runtime events loaded</span>
        </div>
      </div>
      <div className="cockpitControls">
        {props.taskSelector}
        <button className="primaryButton" onClick={props.onRunNow} disabled={props.isRunning || !props.canOperate || !props.hasTask} title={props.canOperate ? undefined : "Operator permission required"}>
          {props.isRunning ? "Starting..." : "Run now"}
        </button>
        <div className="runSummary">
          <span>Latest run</span>
          <strong>{run?.title ?? "No run yet"}</strong>
          <small>{run ? `${run.status} · ${formatTime(run.startedAt)}` : "Waiting for runtime data"}</small>
        </div>
      </div>
    </section>
  );
}

function Metrics(props: { snapshot: RuntimeSnapshot }) {
  const { metrics } = props.snapshot;
  return (
    <div className="metricGrid">
      <MetricTile label="Success rate" value={formatPercent(metrics.successRate)} detail={`${metrics.completedRuns} / ${metrics.terminalRuns} terminal runs, 24h live`} />
      <MetricTile label="Run P95" value={formatDuration(metrics.runLatency.p95Ms)} detail={`${metrics.runLatency.samples} run samples, 24h live`} />
      <MetricTile label="Run P50" value={formatDuration(metrics.runLatency.p50Ms)} detail={`${metrics.runLatency.samples} run samples, nearest rank`} />
      <MetricTile label="Tool P95" value={formatDuration(metrics.toolLatency.p95Ms)} detail={`${metrics.toolLatency.samples} tool samples, 24h live`} />
      <MetricTile label="Estimated cost" value={formatCost(metrics.costUsd, metrics.accounting.costStatus)} detail={metrics.accounting.costStatus === "partial" ? `$${metrics.accounting.knownCostUsd.toFixed(6)} known; ${metrics.accounting.unknownCostCalls} unknown calls` : `${formatNumber(metrics.inputTokens)} in / ${formatNumber(metrics.outputTokens)} out, 24h live`} />
      <MetricTile label="Error rate" value={formatPercent(metrics.errorRate)} detail={`${metrics.failedRuns} failed / ${metrics.terminalRuns} terminal runs, 24h`} tone={metrics.errorRate !== null && metrics.errorRate > 0 ? "bad" : undefined} />
      <MetricTile label="Tool failures" value={formatNumber(metrics.toolFailures)} detail={`${metrics.toolCalls} observed tool calls, 24h live`} tone={metrics.toolFailures > 0 ? "bad" : undefined} />
      <MetricTile label="Eval pass rate" value={formatPercent(metrics.evalPassRate)} detail={`${metrics.evalReports} latest non-skipped reports`} />
    </div>
  );
}

function Steps(props: { steps: RuntimeStep[] }) {
  return (
    <ol className="stepList">
      {props.steps.map((step) => (
        <li key={step.id}>
          <span className={`dot ${statusClass(step.status)}`} />
          <div>
            <strong>{step.name}</strong>
            <small>{step.detail}</small>
          </div>
          <span className="duration">{formatDuration(step.durationMs)}</span>
        </li>
      ))}
    </ol>
  );
}

function TraceTable(props: { spans: RuntimeSpan[] }) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {props.spans.map((span) => (
            <tr key={span.id}>
              <td>{span.type}</td>
              <td>
                <strong>{span.name}</strong>
                <small>{span.summary}</small>
                <small>{span.traceId} · {span.spanId}</small>
              </td>
              <td><span className={`statusPill ${statusClass(span.status)}`}>{span.status}</span></td>
              <td>{formatDuration(span.durationMs)}</td>
              <td>{formatCost(span.costUsd, span.costStatus)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentPipeline(props: { snapshot: RuntimeSnapshot; canOperate: boolean }) {
  const pipeline = props.snapshot.pipeline;
  return (
    <div>
      <div className="pipelineStats">
        <MetricTile label="Fetched" value={formatNumber(pipeline.fetched)} detail="Raw candidates" />
        <MetricTile label="Deduped" value={formatNumber(pipeline.deduped)} detail={`${pipeline.cleaned} cleaned`} tone="ok" />
        <MetricTile label="Delivered" value={formatNumber(pipeline.delivered)} detail={`${pipeline.failedSources.length} failed sources`} tone={pipeline.failedSources.length > 0 ? "warn" : "ok"} />
      </div>
      <div className="contentList">
        {props.snapshot.contentItems.map((item) => <ContentItem item={item} key={item.id} canOperate={props.canOperate} />)}
      </div>
      {pipeline.outcome === "no_new_items" ? <p role="status">No new items. Nothing new was added to the inbox.</p> : null}
      {pipeline.outcome === "legacy_incomplete" ? <p role="status">Legacy results may be incomplete.</p> : null}
      {props.snapshot.contentItems.length === 0 ? <EmptyState title="No delivered items" detail="Run the content pipeline to populate delivery output." /> : null}
    </div>
  );
}

function ContentItem(props: { item: DeliveredContentItem; canOperate: boolean }) {
  const sourceUrl = props.item.url && /^https?:\/\//i.test(props.item.url) ? props.item.url : undefined;
  return (
    <article className="contentItem" aria-label={props.item.title}>
      <div className="contentItemHeader">
        <strong>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{props.item.title}</a> : props.item.title}</strong>
        <span className={`statusPill ${statusClass(props.item.status)}`}>{props.item.status}</span>
      </div>
      <p>{props.item.summary}</p>
      <small>{props.item.source} · score {formatNumber(props.item.score)} · {props.item.reason}</small>
      <div className="tagCloud evidenceTags">
        {props.item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}
      </div>
      {props.item.citations?.length ? <details className="executionDetail"><summary>Source quotes ({props.item.citations.length})</summary>{props.item.citations.map((citation, index) => <div key={index}><blockquote>{citation.quote}</blockquote><small>{citation.readUrl}</small></div>)}</details> : null}
      <FeedbackControls itemId={props.item.id} canOperate={props.canOperate} />
    </article>
  );
}

function Scheduler(props: { schedules: RuntimeSchedule[]; onToggle: (schedule: RuntimeSchedule) => void; onRun: (schedule: RuntimeSchedule) => void; isPending: boolean }) {
  return (
    <div className="scheduleList">
      {props.schedules.map((schedule) => (
        <article className="scheduleRow" key={schedule.id}>
          <div>
            <strong>{schedule.title}</strong>
            <small>{schedule.cron} · {schedule.timezone} · next <time dateTime={schedule.nextRunAt}>{formatTime(schedule.nextRunAt, schedule.timezone)}</time></small>
            <small>last <time dateTime={schedule.lastRunAt}>{formatTime(schedule.lastRunAt, schedule.timezone)}</time> · trigger {schedule.lastTrigger ?? "not recorded"}{schedule.lastTriggerReason && schedule.lastTriggerReason !== schedule.lastTrigger ? ` (${schedule.lastTriggerReason})` : ""}</small>
            {schedule.lastScheduledFor ? <small>scheduled for {formatTime(schedule.lastScheduledFor, schedule.timezone)}</small> : null}
          </div>
          <div className="rowActions">
            <button className="secondaryButton" disabled={props.isPending} onClick={() => props.onRun(schedule)}>Run schedule</button>
            <span className={`statusPill ${schedule.enabled ? "is-ok" : "is-muted"}`}>{schedule.enabled ? "enabled" : "paused"}</span>
            <button className="secondaryButton" disabled={props.isPending} onClick={() => props.onToggle(schedule)}>
              {schedule.enabled ? "Pause" : "Resume"}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function EvalGates(props: { evals: EvalGate[] }) {
  return (
    <div className="evalGrid">
      {props.evals.map((gate) => (
        <article key={gate.id} className="evalCard">
          <span className={`statusPill ${statusClass(gate.status)}`}>{gate.status}</span>
          <strong>{gate.name}</strong>
          <small>{gate.evidence}</small>
          <meter min="0" max="1" value={gate.score} />
        </article>
      ))}
    </div>
  );
}

function Security(props: { snapshot: RuntimeSnapshot }) {
  const { security } = props.snapshot;
  return (
    <div className="securityGrid">
      <MetricTile label="Tool policy" value={security.toolPolicy.replace("_", " ")} detail={security.approvals.replaceAll("_", " ")} tone="ok" />
      <MetricTile label="Secret scan" value={security.secretScan.replaceAll("_", " ")} detail="Latest recorded scan" tone={security.secretScan === "failed" ? "bad" : undefined} />
      <MetricTile label="Sandbox" value={security.sandbox.replaceAll("_", " ")} detail="No OS isolation attestation" tone="warn" />
      <div className="denialBox">
        <h3>Recent denials</h3>
        {security.denials.map((denial) => (
          <p key={denial.id}><strong>{denial.tool}</strong>: {denial.reason}</p>
        ))}
      </div>
    </div>
  );
}

function EventStream(props: { events: RuntimeEvent[] }) {
  return (
    <div className="eventList">
      {props.events.slice(0, 18).map((event) => (
        <article key={event.id} className="eventRow">
          <time>{formatTime(event.timestamp)}</time>
          <div>
            <strong>{event.type}</strong>
            <small>{event.source} · {eventDetail(event)}</small>
          </div>
          <span className={`statusPill ${statusClass(event.severity)}`}>{event.severity}</span>
        </article>
      ))}
    </div>
  );
}

function EmptyState(props: { title: string; detail: string }) {
  return (
    <div className="emptyState">
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </div>
  );
}

function RunTrace({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const trace = useQuery({ queryKey: ["runtime-trace", runId], queryFn: () => fetchTrace(runId), enabled: open, refetchInterval: open ? 10_000 : false });
  const download = useMutation({ mutationFn: () => fetchTrace(runId), onSuccess: (data) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${data.runId}-trace.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  return <details className="executionDetail" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Run trace</summary>
    <button className="iconButton" aria-label="Export trace" title="Export trace" disabled={download.isPending} onClick={() => download.mutate()}><Download size={18} aria-hidden="true" /></button>
    {trace.isError || download.isError ? <p role="alert">{(trace.error ?? download.error)?.message}</p> : null}
    {trace.isPending ? <p role="status">Loading trace...</p> : trace.data?.spans.length ? <TraceTable spans={trace.data.spans} /> : <p>No trace recorded</p>}
    {trace.data?.omittedFromOtlp.length ? <p>{trace.data.omittedFromOtlp.length} spans without an exportable end time</p> : null}
  </details>;
}

function RunHistory({ canOperate }: { canOperate: boolean }) {
  const client = useQueryClient();
  const cancel = useMutation({ mutationFn: cancelRun, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["runtime-run"] }); await client.invalidateQueries({ queryKey: ["runtime-runs"] }); await client.invalidateQueries({ queryKey: snapshotKey }); } });
  const runs = useQuery({ queryKey: ["runtime-runs"], queryFn: fetchRuns, refetchInterval: 10_000 });
  const [selected, setSelected] = useState("");
  const id = selected || runs.data?.runs[0]?.id || "";
  const detail = useQuery({ queryKey: ["runtime-run", id], queryFn: () => fetchRun(id), enabled: Boolean(id), refetchInterval: 10_000 });
  if (runs.isError) return <p role="alert">Run history unavailable.</p>;
  return <div className="runHistory">
    <label htmlFor="run-history">Run history</label>
    <select id="run-history" value={id} onChange={(event) => setSelected(event.target.value)}>
      {!runs.data?.runs.length ? <option value="">No runs</option> : null}
      {runs.data?.runs.map((run) => <option key={run.id} value={run.id}>{formatTime(run.startedAt)} · {run.status} · {run.id.slice(-8)}</option>)}
    </select>
    {detail.isError ? <p role="alert">Run details unavailable.</p> : null}
    {detail.data ? <div aria-label="Historical run result">
      <p className="runIdentity">{detail.data.run.id}</p>
      <p>{detail.data.run.status} · {detail.data.result?.deliveredCount ?? 0} delivered</p>
      <p>{detail.data.run.mode} · Cost: {formatCost(detail.data.run.costUsd, detail.data.run.accounting.costStatus)} · {formatNumber(detail.data.run.inputTokens)} input / {formatNumber(detail.data.run.outputTokens)} output tokens</p>
      {detail.data.run.accounting.costStatus === "partial" ? <p>${detail.data.run.accounting.knownCostUsd.toFixed(6)} known; {detail.data.run.accounting.unknownCostCalls} calls with unknown cost</p> : null}
      <RunTrace runId={detail.data.run.id} />
      {canOperate && ["queued", "running", "cancelling"].includes(detail.data.run.status) ? <button disabled={cancel.isPending || detail.data.run.status === "cancelling"} onClick={() => cancel.mutate(detail.data.run.id)}>{detail.data.run.status === "cancelling" ? "Cancelling..." : "Cancel run"}</button> : null}
      {cancel.isError ? <p role="alert">{cancel.error.message}</p> : null}
      {detail.data.result?.outcome === "no_new_items" ? <p role="status">No new items</p> : null}
      {detail.data.result?.outcome === "legacy_incomplete" ? <p role="status">Legacy results may be incomplete.</p> : null}
      {detail.data.result?.items.map((item) => <ContentItem key={item.id} item={item} canOperate={canOperate} />)}
      {detail.data.memoryContext ? <details className="executionDetail"><summary>Memory context</summary><small>Hash {detail.data.memoryContext.hash}</small><pre>{JSON.stringify(detail.data.memoryContext.context, null, 2)}</pre></details> : null}
      {detail.data.events.filter((event) => ["agent.tool.started", "agent.tool.completed", "agent.model.completed", "run.failed"].includes(event.type)).map((event) => <details key={event.id} className="executionDetail">
        <summary>{event.type === "agent.tool.started" ? `Tool call: ${String(event.payload.tool)}` : event.type === "agent.tool.completed" ? `Tool result: ${String(event.payload.tool)}` : event.type === "agent.model.completed" ? `Model: ${String(event.payload.model)} (${String(event.payload.status)})` : "Run failure"}</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>)}
    </div> : null}
  </div>;
}

export function App({ canOperate }: { canOperate: boolean }) {
  const queryClient = useQueryClient();
  const pendingRunKey = useRef<string | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState("");
  const tasks = useQuery({ queryKey: ["content-tasks"], queryFn: fetchTasks });
  const scheduledRun = useMutation({ mutationFn: runSchedule, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: snapshotKey }); await queryClient.invalidateQueries({ queryKey: ["runtime-runs"] }); } });
  const taskId = selectedTask || tasks.data?.tasks[0]?.definition.id;
  const snapshot = useQuery<RuntimeSnapshot, Error>({ queryKey: snapshotKey, queryFn: fetchSnapshot, refetchInterval: 10_000 });
  const runNowMutation = useMutation({
    mutationFn: () => runNow(pendingRunKey.current ??= crypto.randomUUID(), taskId),
    onSuccess: async () => {
      pendingRunKey.current = undefined;
      await queryClient.invalidateQueries({ queryKey: snapshotKey });
      await queryClient.invalidateQueries({ queryKey: ["runtime-runs"] });
    },
  });
  const scheduleMutation = useMutation({
    mutationFn: (schedule: RuntimeSchedule) => patchSchedule(schedule.id, { enabled: !schedule.enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: snapshotKey });
    },
  });

  useEffect(() => {
    const stream = new EventSource("/api/events/stream");
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: snapshotKey });
        void queryClient.invalidateQueries({ queryKey: ["runtime-runs"] });
        void queryClient.invalidateQueries({ queryKey: ["runtime-run"] });
        void queryClient.invalidateQueries({ queryKey: ["memory-export"] });
        void queryClient.invalidateQueries({ queryKey: ["memory-practices"] });
      }, 100);
    };
    stream.addEventListener("snapshot", refresh);
    stream.addEventListener("runtime-event", refresh);
    stream.addEventListener("runtime-error", refresh);
    stream.onerror = refresh;
    return () => { clearTimeout(refreshTimer); stream.close(); };
  }, [queryClient]);

  const data: RuntimeSnapshot | undefined = snapshot.data;
  const pipelineCount = useMemo(() => data?.events.filter((event) => event.type.startsWith("pipeline.")).length ?? 0, [data]);

  if (snapshot.isLoading) {
    return <main className="shell"><EmptyState title="Loading runtime" detail="Connecting to the Agent Ops API." /></main>;
  }

  if (snapshot.isError || !data) {
    return (
      <main className="shell">
        <EmptyState title="API offline" detail="Start the Fastify server on 127.0.0.1:4175, then reload the dashboard." />
      </main>
    );
  }

  return (
    <main className="shell">
      <Cockpit snapshot={data} onRunNow={() => runNowMutation.mutate()} isRunning={runNowMutation.isPending} canOperate={canOperate} hasTask={Boolean(taskId || tasks.data?.demoMode)} taskSelector={
        <label className="taskSelector">Task<select aria-label="Task" value={taskId ?? ""} onChange={(event) => { setSelectedTask(event.target.value); pendingRunKey.current = undefined; }}>
          {!tasks.data?.tasks.length ? <option value="">{tasks.data?.demoMode ? "Explicit demo" : "No configured tasks"}</option> : null}
          {tasks.data?.tasks.map((task) => <option key={task.definition.id} value={task.definition.id}>{task.definition.title}</option>)}
        </select></label>
      } />
      <TaskConfig defaultModel={tasks.data?.defaultModel ?? "deepseek-v4-pro"} canOperate={canOperate} onCreated={(id) => { setSelectedTask(id); pendingRunKey.current = undefined; }} />
      {tasks.isError ? <p role="alert">Task configuration unavailable: {tasks.error.message}</p> : null}
      {runNowMutation.isError ? <div className="alert">Run now failed: {runNowMutation.error.message}</div> : null}
      {scheduleMutation.isError ? <div className="alert">Schedule update failed: {scheduleMutation.error.message}</div> : null}

      <Metrics snapshot={data} />
      <Monitoring canOperate={canOperate} runId={data.latestRun?.startedAt ? data.latestRun.id : undefined} />

      <div className="layoutGrid">
        <Card title="Runs">
          <RunHistory canOperate={canOperate} />
        </Card>
        <Card title="Run Trace" eyebrow={data.latestRun?.id ?? "No run selected"}>
          {data.steps.length > 0 ? <Steps steps={data.steps} /> : <EmptyState title="No steps yet" detail="Run the agent to populate the trace." />}
        </Card>

        <Card title="Scheduler" eyebrow="Triggers" action={<span className="countBadge">{data.schedules.length}</span>}>
          <ScheduleConfig tasks={tasks.data?.tasks ?? []} canOperate={canOperate} />
          {scheduledRun.isError ? <p role="alert">{scheduledRun.error.message}</p> : null}
          <Scheduler schedules={data.schedules} onToggle={(schedule) => scheduleMutation.mutate(schedule)} onRun={(schedule) => scheduledRun.mutate({ id: schedule.id, key: crypto.randomUUID() })} isPending={scheduleMutation.isPending || scheduledRun.isPending || !canOperate} />
        </Card>

        <Card title="Content Pipeline" eyebrow={`${pipelineCount} events`}>
          <ContentPipeline snapshot={data} canOperate={canOperate} />
        </Card>

        <Card title="Event Stream" eyebrow="Live via SSE">
          <EventStream events={data.events} />
        </Card>

        <Card title="Memory" eyebrow="Preferences and feedback">
          <MemoryWorkbench canOperate={canOperate} items={data.contentItems} runId={data.latestRun?.startedAt ? data.latestRun.id : undefined} />
        </Card>

        <Card title="Eval Harness" eyebrow="Acceptance gates">
          <EvalGates evals={data.evals} />
        </Card>

        <Card title="Observability" eyebrow="Spans, cost, latency">
          <TraceTable spans={data.spans} />
        </Card>

        <Card title="Security" eyebrow="Policy posture">
          <Security snapshot={data} />
        </Card>
      </div>
    </main>
  );
}
