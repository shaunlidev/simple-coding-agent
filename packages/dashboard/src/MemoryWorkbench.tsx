import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Check, Download, FlaskConical, Plus, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { useState } from "react";
import { activatePractice, addKnowledge, approveMemoryClear, evaluatePractice, fetchMemory, fetchPractices, proposePractice, requestMemoryClear, reviewPractice, rollbackPractice, savePreferences, searchKnowledge, type DeliveredContentItem, type MemoryState, type PracticeEvidence, type PracticeList, type PracticeRule, type PracticeVersion } from "./api.js";

async function refreshMemory(client: QueryClient) {
  await client.invalidateQueries({ queryKey: ["memory-export"] });
  await client.invalidateQueries({ queryKey: ["memory-practices"] });
  await client.invalidateQueries({ queryKey: ["runtime-snapshot"] });
}
const csv = (value: FormDataEntryValue | null) => String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const ruleLabel = (rule: PracticeRule) => rule.kind === "minimum_quotes" ? `At least ${rule.count} quotes` : rule.kind === "source_delivery_cap" ? `At most ${rule.maximum} new items per source` : `${rule.sourceId}: ${rule.delta > 0 ? "+" : ""}${rule.delta} score`;

function Preferences({ profile, canOperate }: { profile: MemoryState; canOperate: boolean }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = useMutation({ mutationFn: savePreferences, onSuccess: async () => { await refreshMemory(client); setEditing(false); } });
  if (!editing) return <div className="memoryBlock">
    <dl className="memoryProfile"><dt>Interests</dt><dd>{profile.interests.join(", ") || "None"}</dd><dt>Blocked topics</dt><dd>{profile.blockedTopics.join(", ") || "None"}</dd><dt>Source weights</dt><dd>{Object.entries(profile.sourceWeights).map(([source, weight]) => `${source}: ${weight}`).join(", ") || "Default: 1"}</dd></dl>
    <button className="secondaryButton" disabled={!canOperate} onClick={() => setEditing(true)}>Edit preferences</button>
  </div>;
  return <form className="memoryForm" onSubmit={(event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const sourceWeights = Object.fromEntries(Object.keys(profile.sourceWeights).map((source) => [source, Number(form.get(`weight:${source}`))]));
    const source = String(form.get("newSource") ?? "").trim();
    if (source) sourceWeights[source] = Number(form.get("newWeight"));
    save.mutate({ interests: csv(form.get("interests")), blockedTopics: csv(form.get("blocked")), sourceWeights });
  }}>
    <label>Interests<input name="interests" defaultValue={profile.interests.join(", ")} maxLength={4000} /></label>
    <label>Blocked topics<input name="blocked" defaultValue={profile.blockedTopics.join(", ")} maxLength={4000} /></label>
    {Object.entries(profile.sourceWeights).map(([source, weight]) => <label key={source}>Weight: {source}<input name={`weight:${source}`} type="number" min={0} max={3} step={0.1} defaultValue={weight} required /></label>)}
    <label>New source ID<input name="newSource" maxLength={64} /></label><label>New source weight<input name="newWeight" type="number" min={0} max={3} step={0.1} defaultValue={1} /></label>
    <div className="rowActions"><button className="primaryButton" disabled={save.isPending}><Save size={16} aria-hidden="true" /> Save preferences</button><button type="button" className="secondaryButton" disabled={save.isPending} onClick={() => setEditing(false)}>Cancel</button></div>
    {save.isError ? <p role="alert">{save.error.message}</p> : null}
  </form>;
}

function Knowledge({ canOperate }: { canOperate: boolean }) {
  const client = useQueryClient();
  const memory = useQuery({ queryKey: ["memory-export"], queryFn: fetchMemory });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const results = useQuery({ queryKey: ["memory-search", query], queryFn: () => searchKnowledge(query), enabled: Boolean(query) });
  const add = useMutation({ mutationFn: addKnowledge, onSuccess: async () => { setContent(""); setUrl(""); await refreshMemory(client); await client.invalidateQueries({ queryKey: ["memory-search"] }); } });
  return <div className="memoryBlock">
    <form className="searchRow" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}><label>Search notes<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={1000} /></label><button className="iconButton" aria-label="Search notes" title="Search notes" disabled={!search.trim() || results.isFetching}><Search size={18} aria-hidden="true" /></button></form>
    {results.isFetching ? <p role="status">Searching...</p> : null}
    {results.isError ? <p role="alert">{results.error.message}</p> : null}
    {query ? <ul className="memoryList">{results.data?.results.map((hit) => <li key={hit.id}><p>{hit.content}</p><small>{hit.id} | {hit.source.actor} | {hit.source.trust}</small>{typeof hit.metadata.url === "string" ? <small>{hit.metadata.url}</small> : null}</li>)}{results.data?.results.length === 0 ? <li>No matching notes</li> : null}</ul> : <ul className="memoryList">{memory.data?.entries.filter((entry) => entry.kind === "knowledge").map((entry) => <li key={entry.id}><p>{entry.content}</p><small>{entry.id} | {String(entry.metadata.actor ?? "unknown")}</small></li>)}</ul>}
    {canOperate ? <form className="memoryForm" onSubmit={(event) => { event.preventDefault(); add.mutate({ content, metadata: url ? { url } : {} }); }}>
      <label className="wideCell">Knowledge note<textarea required rows={3} maxLength={4000} value={content} onChange={(event) => setContent(event.target.value)} /></label>
      <label className="wideCell">Reference URL<input type="url" maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <button className="secondaryButton" disabled={add.isPending}><Plus size={16} aria-hidden="true" /> Add note</button>
      {add.isError ? <p role="alert">{add.error.message}</p> : null}
    </form> : null}
  </div>;
}

function PracticeEntry({ version, list, canOperate, onNewVersion }: { version: PracticeVersion; list: PracticeList; canOperate: boolean; onNewVersion: (version: PracticeVersion) => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [confirm, setConfirm] = useState(false);
  const review = list.reviews.find((entry) => entry.version_id === version.id);
  const evaluation = list.evaluations.find((entry) => entry.report.versionId === version.id);
  const active = list.state.version_id === version.id;
  const reviewed = useMutation({ mutationFn: reviewPractice, onSuccess: () => refreshMemory(client) });
  const evaluated = useMutation({ mutationFn: evaluatePractice, onSuccess: () => refreshMemory(client) });
  const activated = useMutation({ mutationFn: activatePractice, onSuccess: async () => { setConfirm(false); await refreshMemory(client); } });
  const pending = reviewed.isPending || evaluated.isPending || activated.isPending;
  const error = reviewed.error ?? evaluated.error ?? activated.error;
  return <article className="practiceEntry" aria-label={version.definition.title}>
    <div className="practiceHeader"><h3>{version.definition.title}</h3><span className={`statusPill ${active ? "is-ok" : review?.decision === "rejected" ? "is-bad" : "is-muted"}`}>{active ? "Active" : review?.decision ?? "Awaiting review"}</span></div>
    <p>{version.definition.principle}</p><ul>{version.definition.rules.map((rule, index) => <li key={index}>{ruleLabel(rule)}</li>)}</ul>
    <small>Version {version.id} | {version.actor}</small>
    <details className="executionDetail"><summary>Evidence ({version.definition.evidence.length})</summary>{version.definition.evidence.map((evidence, index) => <div key={index}><p>{evidence.summary}</p><small>{evidence.source} | {evidence.signal ?? "run result"} | {evidence.runId}</small><small>Hash {evidence.hash}</small></div>)}</details>
    {review ? <p>Review: {review.decision} by {review.actor}. {review.reason}</p> : canOperate ? <form className="memoryForm" onSubmit={(event) => { event.preventDefault(); reviewed.mutate({ id: version.id, decision, reason }); }}>
      <label>Review decision<select value={decision} onChange={(event) => setDecision(event.target.value === "rejected" ? "rejected" : "approved")}><option value="approved">Approve</option><option value="rejected">Reject</option></select></label>
      <label>Review reason<input required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button className="secondaryButton" disabled={pending}>Record review</button>
    </form> : null}
    {evaluation ? <details className="executionDetail" open><summary>Regression report: {evaluation.report.passed ? "passed" : "failed"}</summary><small>{evaluation.report.evidenceKind} | {evaluation.report.purpose} | baseline {evaluation.report.baselineRevision}</small><ul className="memoryList">{evaluation.report.checks.map((check, index) => <li key={index}><strong>{check.passed ? "Pass" : "Fail"}: {check.name}</strong><small>Expected: {check.expected}</small><small>Observed: {check.actual}</small></li>)}</ul></details> : null}
    <div className="rowActions">
      <button className="secondaryButton" disabled={!canOperate || pending || review?.decision !== "approved"} onClick={() => evaluated.mutate(version.id)}><FlaskConical size={16} aria-hidden="true" /> Evaluate</button>
      <button className="secondaryButton" disabled={!canOperate || pending || !evaluation?.report.passed || evaluation.report.baselineRevision !== list.state.revision} onClick={() => setConfirm(true)}><Check size={16} aria-hidden="true" /> {active ? "Revalidate activation" : "Activate"}</button>
      <button className="secondaryButton" disabled={!canOperate || pending} onClick={() => onNewVersion(version)}>New version</button>
    </div>
    {confirm && evaluation ? <div className="confirmation" role="group" aria-label="Confirm practice activation"><p>Activate version {version.id} for new runs?</p><div className="rowActions"><button className="primaryButton" disabled={pending} onClick={() => activated.mutate({ id: version.id, evaluationId: evaluation.id, expectedRevision: list.state.revision })}>Confirm activation</button><button className="secondaryButton" onClick={() => setConfirm(false)}>Cancel</button></div></div> : null}
    {pending ? <p role="status">Updating practice...</p> : null}{error ? <p role="alert">{error.message}</p> : null}
  </article>;
}

function Practices({ canOperate, items }: { canOperate: boolean; items: DeliveredContentItem[] }) {
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["memory-practices"], queryFn: fetchPractices });
  const memory = useQuery({ queryKey: ["memory-export"], queryFn: fetchMemory });
  const [title, setTitle] = useState(""); const [principle, setPrinciple] = useState("");
  const [kind, setKind] = useState<PracticeRule["kind"]>("minimum_quotes");
  const [value, setValue] = useState(2); const [source, setSource] = useState("");
  const [parent, setParent] = useState<string | undefined>(undefined);
  const [retainedRules, setRetainedRules] = useState<PracticeRule[]>([]);
  const [evidenceKey, setEvidenceKey] = useState(""); const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const evidenceOptions: Array<{ key: string; label: string; reference: PracticeEvidence }> = [
    ...(memory.data?.feedback ?? []).map((entry) => ({ key: entry.id, label: `${entry.signal.replaceAll("_", " ")} | ${entry.item_id} | ${entry.actor}`, reference: { kind: "feedback" as const, feedbackId: entry.id } })),
    ...items.map((item) => ({ key: `${item.runId}:${item.id}`, label: `${item.title} | run result`, reference: { kind: "run_result" as const, runId: item.runId, contentId: item.id } })),
  ];
  const evidence = evidenceOptions.find((option) => option.key === (evidenceKey || evidenceOptions[0]?.key));
  const propose = useMutation({ mutationFn: proposePractice, onSuccess: async () => { setTitle(""); setPrinciple(""); setParent(undefined); setRetainedRules([]); await refreshMemory(client); } });
  const rollback = useMutation({ mutationFn: rollbackPractice, onSuccess: async () => { setRollbackConfirm(false); await refreshMemory(client); } });
  if (list.isPending) return <p role="status">Loading practices...</p>;
  if (list.isError) return <p role="alert">{list.error.message}</p>;
  return <div className="memoryBlock">
    <div className="practiceHeader"><p>Active version: {list.data.state.version_id ?? "None"}</p><button className="iconButton" title="Roll back practice" aria-label="Roll back practice" disabled={!canOperate || !list.data.state.version_id || rollback.isPending} onClick={() => setRollbackConfirm(true)}><RotateCcw size={18} aria-hidden="true" /></button></div>
    {rollbackConfirm ? <div className="confirmation" role="group" aria-label="Confirm rollback"><p>Restore the previous eligible practice?</p><div className="rowActions"><button className="primaryButton" disabled={rollback.isPending} onClick={() => rollback.mutate(list.data.state.revision)}>Confirm rollback</button><button className="secondaryButton" onClick={() => setRollbackConfirm(false)}>Cancel</button></div></div> : null}
    {rollback.isError ? <p role="alert">{rollback.error.message}</p> : null}
    {canOperate ? <form className="memoryForm" aria-label="Practice proposal" onSubmit={(event) => {
      event.preventDefault(); if (!evidence) return;
      const rule: PracticeRule = kind === "minimum_quotes" ? { kind, count: value } : kind === "source_delivery_cap" ? { kind, maximum: value } : { kind, sourceId: source, delta: value };
      propose.mutate({ title, principle, rules: [rule, ...retainedRules], evidence: [evidence.reference], ...(parent ? { parentId: parent } : {}) });
    }}>
      {parent ? <p className="wideCell">Parent version: {parent}</p> : null}
      {retainedRules.map((rule, index) => <div className="rowActions wideCell" key={index}><span>Retained rule: {ruleLabel(rule)}</span><button type="button" className="iconButton" aria-label={`Remove retained rule ${index + 1}`} title="Remove retained rule" onClick={() => setRetainedRules(retainedRules.filter((_, position) => position !== index))}><X size={16} aria-hidden="true" /></button></div>)}
      <label>Practice title<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Rule<select value={kind} onChange={(event) => { const next = event.target.value; if (next === "minimum_quotes" || next === "source_delivery_cap" || next === "source_rank_bias") { setKind(next); setValue(next === "source_rank_bias" ? 5 : 2); } }}><option value="minimum_quotes">Minimum supporting quotes</option><option value="source_delivery_cap">New items per source</option><option value="source_rank_bias">Source score adjustment</option></select></label>
      <label>Rule value<input type="number" step={1} min={kind === "source_rank_bias" ? -10 : 1} max={kind === "minimum_quotes" ? 3 : 10} required value={value} onChange={(event) => setValue(Number(event.target.value))} /></label>
      {kind === "source_rank_bias" ? <label>Source ID<input required maxLength={64} value={source} onChange={(event) => setSource(event.target.value)} /></label> : null}
      <label className="wideCell">Principle<textarea required maxLength={2000} rows={2} value={principle} onChange={(event) => setPrinciple(event.target.value)} /></label>
      <label className="wideCell">Supporting evidence<select required value={evidence?.key ?? ""} onChange={(event) => setEvidenceKey(event.target.value)}>{evidenceOptions.length === 0 ? <option value="">No recorded result or feedback</option> : evidenceOptions.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
      <button className="secondaryButton" disabled={propose.isPending || !evidence}><Plus size={16} aria-hidden="true" /> Propose practice</button>
      {propose.isError ? <p role="alert">{propose.error.message}</p> : null}
    </form> : null}
    {list.data.versions.map((version) => <PracticeEntry key={version.id} version={version} list={list.data} canOperate={canOperate} onNewVersion={(previous) => { setParent(previous.id); setRetainedRules(previous.definition.rules.slice(1)); setTitle(previous.definition.title); setPrinciple(previous.definition.principle); const rule = previous.definition.rules[0]; setKind(rule.kind); setValue(rule.kind === "minimum_quotes" ? rule.count : rule.kind === "source_delivery_cap" ? rule.maximum : rule.delta); setSource(rule.kind === "source_rank_bias" ? rule.sourceId : ""); }} />)}
    {list.data.versions.length === 0 ? <p>No practice versions</p> : null}
  </div>;
}

export function MemoryWorkbench({ canOperate, items, runId }: { canOperate: boolean; items: DeliveredContentItem[]; runId?: string }) {
  const client = useQueryClient();
  const memory = useQuery({ queryKey: ["memory-export"], queryFn: fetchMemory });
  const [tab, setTab] = useState("Preferences");
  const request = useMutation({ mutationFn: requestMemoryClear });
  const clear = useMutation({ mutationFn: approveMemoryClear, onSuccess: async () => { request.reset(); await refreshMemory(client); await client.invalidateQueries({ queryKey: ["memory-search"] }); } });
  const download = useMutation({ mutationFn: fetchMemory, onSuccess: (data) => { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "agent-memory.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } });
  return <div className="memoryWorkbench">
    <div className="memoryToolbar"><div className="memoryTabs" role="group" aria-label="Memory views">{["Preferences", "Knowledge", "Practices", "History"].map((name) => <button key={name} aria-pressed={name === tab} onClick={() => setTab(name)}>{name}</button>)}</div>
      <button className="iconButton" aria-label="Export memory" title="Export memory" disabled={download.isPending} onClick={() => download.mutate()}><Download size={18} aria-hidden="true" /></button>
      <button className="iconButton dangerAction" aria-label="Clear memory" title="Clear memory" disabled={!canOperate || !runId || request.isPending || clear.isPending} onClick={() => { clear.reset(); if (runId) request.mutate(runId); }}><Trash2 size={18} aria-hidden="true" /></button>
    </div>
    {request.data && request.variables ? <div className="confirmation" role="group" aria-label="Confirm memory clear"><p>Clear live preferences, notes, feedback and active practices? Historical run inputs and audit remain.</p><div className="rowActions"><button className="primaryButton" disabled={clear.isPending} onClick={() => clear.mutate({ runId: request.variables!, approvalId: request.data.id })}>Approve and clear</button><button className="iconButton" aria-label="Cancel clear" title="Cancel clear" disabled={clear.isPending} onClick={() => request.reset()}><X size={18} aria-hidden="true" /></button></div></div> : null}
    {request.error || clear.error || download.error ? <p role="alert">{(request.error ?? clear.error ?? download.error)?.message}</p> : null}
    {memory.isPending ? <p role="status">Loading memory...</p> : memory.isError ? <p role="alert">{memory.error.message}</p> : <>
      {tab === "Preferences" ? <Preferences profile={memory.data.memory} canOperate={canOperate} /> : null}
      {tab === "Knowledge" ? <Knowledge canOperate={canOperate} /> : null}
      {tab === "Practices" ? <Practices items={items} canOperate={canOperate} /> : null}
      {tab === "History" ? <div className="memoryBlock">
        <h3>Effective feedback</h3><ul className="memoryList">{memory.data.feedback.map((record) => <li key={record.id}><strong>{record.signal.replaceAll("_", " ")}</strong><small>{record.item_id} | {record.actor} | {record.created_at}</small></li>)}</ul>
        <h3>Preference diffs</h3><ul className="memoryList">{memory.data.memory.preferenceDiffs.map((diff, index) => <li key={index}><strong>{diff.field}: {diff.key}</strong><small>{String(diff.before ?? "new")} to {String(diff.after ?? "removed")} | {diff.timestamp}</small></li>)}</ul>
        <h3>Lessons</h3><ul className="memoryList">{memory.data.memory.recentLessons.map((lesson, index) => <li key={index}><strong>{lesson.title}</strong><p>{lesson.principle}</p><small>{lesson.evidence} | {lesson.timestamp}</small></li>)}</ul>
        <h3>Practice releases</h3><ul className="memoryList">{memory.data.practices.activations.map((release) => <li key={release.id}><strong>Revision {release.revision}: {release.action}</strong><small>{release.from_id ?? "None"} to {release.to_id ?? "None"}</small><small>{release.actor} | {release.created_at}</small></li>)}</ul>
      </div> : null}
    </>}
  </div>;
}
