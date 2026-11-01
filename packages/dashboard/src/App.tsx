import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useMemo } from "react";
import { fetchSnapshot, patchSchedule, runNow, type DeliveredContentItem, type EvalGate, type RuntimeEvent, type RuntimeSchedule, type RuntimeSnapshot, type RuntimeSpan, type RuntimeStep } from "./api.js";

const snapshotKey = ["runtime-snapshot"] as const;

function formatNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en", options).format(value);
}

function formatTime(value?: string) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPercent(value: number) {
  return `${formatNumber(value * 100, { maximumFractionDigits: 1 })}%`;
}

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

function Cockpit(props: { snapshot: RuntimeSnapshot; onRunNow: () => void; isRunning: boolean }) {
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
        <button className="primaryButton" onClick={props.onRunNow} disabled={props.isRunning}>
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
  const { metrics, latestRun } = props.snapshot;
  return (
    <div className="metricGrid">
      <MetricTile label="Success rate" value={formatPercent(metrics.successRate)} detail="Completed runs / terminal runs" tone="ok" />
      <MetricTile label="P95 latency" value={`${formatNumber(metrics.p95LatencyMs)} ms`} detail="Latest projected runtime" tone={metrics.p95LatencyMs > 3000 ? "warn" : "live"} />
      <MetricTile label="P50 latency" value={`${formatNumber(metrics.p50LatencyMs)} ms`} detail="Median span duration" tone="live" />
      <MetricTile label="Cost" value={`$${metrics.costUsd.toFixed(4)}`} detail={`${metrics.inputTokens} in / ${metrics.outputTokens} out tokens`} />
      <MetricTile label="Error rate" value={formatPercent(metrics.errorRate)} detail={`${latestRun?.errorCount ?? 0} errors in latest run`} tone={metrics.errorRate > 0 ? "bad" : "ok"} />
      <MetricTile label="Tool failures" value={formatNumber(metrics.toolFailures)} detail={`${latestRun?.toolCallCount ?? 0} tool-like calls`} tone={metrics.toolFailures > 0 ? "bad" : "ok"} />
      <MetricTile label="Eval pass rate" value={formatPercent(metrics.evalPassRate)} detail={`${props.snapshot.evals.length} gates reported`} tone="ok" />
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
          <span className="duration">{formatNumber(step.durationMs ?? 0)} ms</span>
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
              <td>{formatNumber(span.durationMs)} ms</td>
              <td>${(span.costUsd ?? 0).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContentPipeline(props: { snapshot: RuntimeSnapshot }) {
  const pipeline = props.snapshot.pipeline;
  return (
    <div>
      <div className="pipelineStats">
        <MetricTile label="Fetched" value={formatNumber(pipeline.fetched)} detail="Raw candidates" />
        <MetricTile label="Deduped" value={formatNumber(pipeline.deduped)} detail={`${pipeline.cleaned} cleaned`} tone="ok" />
        <MetricTile label="Delivered" value={formatNumber(pipeline.delivered)} detail={`${pipeline.failedSources.length} failed sources`} tone={pipeline.failedSources.length > 0 ? "warn" : "ok"} />
      </div>
      <div className="contentList">
        {props.snapshot.contentItems.map((item) => <ContentItem item={item} key={item.id} />)}
      </div>
      {props.snapshot.contentItems.length === 0 ? <EmptyState title="No delivered items" detail="Run the content pipeline to populate delivery output." /> : null}
    </div>
  );
}

function ContentItem(props: { item: DeliveredContentItem }) {
  return (
    <article className="contentItem">
      <div className="contentItemHeader">
        <strong>{props.item.title}</strong>
        <span className={`statusPill ${statusClass(props.item.status)}`}>{props.item.status}</span>
      </div>
      <p>{props.item.summary}</p>
      <small>{props.item.source} · score {formatNumber(props.item.score)} · {props.item.reason}</small>
      <div className="tagCloud evidenceTags">
        {props.item.evidence.map((evidence) => <span key={evidence}>{evidence}</span>)}
      </div>
    </article>
  );
}

function Scheduler(props: { schedules: RuntimeSchedule[]; triggerReasons: Map<string, string>; onToggle: (schedule: RuntimeSchedule) => void; isPending: boolean }) {
  return (
    <div className="scheduleList">
      {props.schedules.map((schedule) => (
        <article className="scheduleRow" key={schedule.id}>
          <div>
            <strong>{schedule.title}</strong>
            <small>{schedule.cron} · {schedule.timezone} · next {formatTime(schedule.nextRunAt)}</small>
            <small>last {formatTime(schedule.lastRunAt)} · trigger {props.triggerReasons.get(schedule.id) ?? "not triggered yet"}</small>
          </div>
          <div className="rowActions">
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

function Memory(props: { snapshot: RuntimeSnapshot }) {
  const sourceWeights = Object.entries(props.snapshot.memory.sourceWeights) as Array<[string, number]>;
  return (
    <div className="splitGrid">
      <div>
        <h3>Preference memory</h3>
        <div className="tagCloud">
          {props.snapshot.memory.interests.map((interest) => <span key={interest}>{interest}</span>)}
        </div>
        <p className="mutedText">Blocked: {props.snapshot.memory.blockedTopics.join(", ")}</p>
      </div>
      <div>
        <h3>Feedback loop</h3>
        <ul className="compactList">
          {props.snapshot.memory.recentFeedback.map((feedback) => (
            <li key={`${feedback.itemId}-${feedback.timestamp}`}>
              <strong>{feedback.signal.replace("_", " ")}</strong>
              <small>{feedback.itemId} · {formatTime(feedback.timestamp)}</small>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>Source weights</h3>
        <ul className="compactList">
          {sourceWeights.map(([source, weight]) => (
            <li key={source}>
              <strong>{source}</strong>
              <small>{weight.toFixed(1)}x ranking weight</small>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3>Lessons</h3>
        <ul className="compactList">
          {props.snapshot.memory.recentLessons.map((lesson) => (
            <li key={`${lesson.title}-${lesson.timestamp}`}>
              <strong>{lesson.title}</strong>
              <small>{lesson.principle}</small>
            </li>
          ))}
        </ul>
      </div>
      <div className="wideCell">
        <h3>Preference diffs</h3>
        <ul className="compactList">
          {props.snapshot.memory.preferenceDiffs.slice(0, 6).map((diff) => (
            <li key={`${diff.field}-${diff.key}-${diff.timestamp}`}>
              <strong>{diff.field}: {diff.key}</strong>
              <small>{String(diff.before ?? "new")} {"->"} {String(diff.after ?? "removed")} · {formatTime(diff.timestamp)}</small>
            </li>
          ))}
        </ul>
      </div>
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
      <MetricTile label="Secret scan" value={security.secretScan} detail="Responses and events are redacted" tone={security.secretScan === "passed" ? "ok" : "bad"} />
      <MetricTile label="Sandbox" value={security.sandbox} detail="High-risk actions require review" tone={security.sandbox === "enabled" ? "ok" : "warn"} />
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

export function App() {
  const queryClient = useQueryClient();
  const snapshot = useQuery<RuntimeSnapshot, Error>({ queryKey: snapshotKey, queryFn: fetchSnapshot, refetchInterval: 10_000 });
  const runNowMutation = useMutation({
    mutationFn: runNow,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: snapshotKey });
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
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: snapshotKey });
    };
    stream.addEventListener("snapshot", refresh);
    stream.addEventListener("runtime-event", refresh);
    stream.addEventListener("runtime-error", refresh);
    stream.onerror = refresh;
    return () => stream.close();
  }, [queryClient]);

  const data: RuntimeSnapshot | undefined = snapshot.data;
  const pipelineCount = useMemo(() => data?.events.filter((event) => event.type.startsWith("pipeline.")).length ?? 0, [data]);
  const triggerReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const event of data?.events ?? []) {
      if (event.type !== "scheduler.task_due") continue;
      const scheduleId = typeof event.payload.scheduleId === "string" ? event.payload.scheduleId : typeof event.payload.taskId === "string" ? event.payload.taskId : undefined;
      if (!scheduleId || reasons.has(scheduleId)) continue;
      reasons.set(scheduleId, String(event.payload.reason ?? event.payload.trigger ?? event.payload.action ?? "manual"));
    }
    return reasons;
  }, [data]);

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
      <Cockpit snapshot={data} onRunNow={() => runNowMutation.mutate()} isRunning={runNowMutation.isPending} />
      {runNowMutation.isError ? <div className="alert">Run now failed: {runNowMutation.error.message}</div> : null}
      {scheduleMutation.isError ? <div className="alert">Schedule update failed: {scheduleMutation.error.message}</div> : null}

      <Metrics snapshot={data} />

      <div className="layoutGrid">
        <Card title="Run Trace" eyebrow={data.latestRun?.id ?? "No run selected"}>
          {data.steps.length > 0 ? <Steps steps={data.steps} /> : <EmptyState title="No steps yet" detail="Run the agent to populate the trace." />}
        </Card>

        <Card title="Scheduler" eyebrow="Triggers" action={<span className="countBadge">{data.schedules.length}</span>}>
          <Scheduler schedules={data.schedules} triggerReasons={triggerReasons} onToggle={(schedule) => scheduleMutation.mutate(schedule)} isPending={scheduleMutation.isPending} />
        </Card>

        <Card title="Content Pipeline" eyebrow={`${pipelineCount} events`}>
          <ContentPipeline snapshot={data} />
        </Card>

        <Card title="Event Stream" eyebrow="Live via SSE">
          <EventStream events={data.events} />
        </Card>

        <Card title="Memory" eyebrow="Preferences and feedback">
          <Memory snapshot={data} />
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
