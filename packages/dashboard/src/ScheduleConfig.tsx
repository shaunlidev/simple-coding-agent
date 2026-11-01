import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createSchedule, type ContentTaskRecord, type RuntimeSchedule } from "./api.js";

export function ScheduleConfig({ tasks, canOperate }: { tasks: ContentTaskRecord[]; canOperate: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [title, setTitle] = useState("");
  const [expression, setExpression] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [policy, setPolicy] = useState<RuntimeSchedule["overlapPolicy"]>("skip");
  const save = useMutation({ mutationFn: createSchedule, onSuccess: async () => { setOpen(false); setTitle(""); await client.invalidateQueries({ queryKey: ["runtime-snapshot"] }); } });
  if (!canOperate) return null;
  return <div className="taskConfig">
    <button type="button" disabled={!tasks.length} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Cancel schedule" : "New schedule"}</button>
    {open ? <form onSubmit={(event) => {
      event.preventDefault();
      save.mutate({ id: crypto.randomUUID(), taskId: taskId || tasks[0]?.definition.id || "", title, cron: expression, timezone, overlapPolicy: policy });
    }}>
      <label>Schedule name<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Scheduled task<select required value={taskId || tasks[0]?.definition.id || ""} onChange={(event) => setTaskId(event.target.value)}>{tasks.map(({ definition }) => <option key={definition.id} value={definition.id}>{definition.title}</option>)}</select></label>
      <label>Cron or interval<input required value={expression} onChange={(event) => setExpression(event.target.value)} /></label>
      <label>Timezone<input required value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
      <label>Overlap policy<select value={policy} onChange={(event) => { const value = event.target.value; if (value === "skip" || value === "queue" || value === "cancel_previous") setPolicy(value); }}>
        <option value="skip">Skip</option><option value="queue">Queue</option><option value="cancel_previous">Cancel previous</option>
      </select></label>
      <button type="submit" className="primaryButton" disabled={save.isPending}>{save.isPending ? "Saving..." : "Create schedule"}</button>
      {save.isError ? <p role="alert">{save.error.message}</p> : null}
    </form> : null}
  </div>;
}
