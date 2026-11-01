import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { saveTask, type ContentTask } from "./api.js";

export function TaskConfig({ defaultModel, onCreated, canOperate }: { defaultModel: string; onCreated: (id: string) => void; canOperate: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<ContentTask["sources"][number]["kind"]>("url");
  const save = useMutation({ mutationFn: saveTask, onSuccess: async (record) => {
    await client.invalidateQueries({ queryKey: ["content-tasks"] });
    onCreated(record.definition.id);
    setOpen(false); setTitle(""); setInstruction(""); setUrl("");
  } });
  if (!canOperate) return null;
  return <section className="taskConfig">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Cancel" : "New task"}</button>
    {open ? <form onSubmit={(event) => {
      event.preventDefault();
      save.mutate({ id: crypto.randomUUID(), title, instruction, model: defaultModel, sources: [{ id: "source-1", kind, url }] });
    }}>
      <label>Task name<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Research request<textarea required maxLength={2000} rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
      <label>Source type<select value={kind} onChange={(event) => { const value = event.target.value; if (value === "rss" || value === "url" || value === "browser") setKind(value); }}>
        <option value="url">Web page</option><option value="rss">RSS / Atom</option><option value="browser">Browser page</option>
      </select></label>
      <label>Source URL<input required type="url" maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <button className="primaryButton" type="submit" disabled={save.isPending}>{save.isPending ? "Saving..." : "Create task"}</button>
      {save.isError ? <p role="alert">{save.error.message}</p> : null}
    </form> : null}
  </section>;
}
