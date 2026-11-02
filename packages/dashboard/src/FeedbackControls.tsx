import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, MousePointerClick, ThumbsDown, X } from "lucide-react";
import { useRef } from "react";
import { fetchMemory, fetchSession, saveFeedback, type FeedbackSignal } from "./api.js";

const actions = [{ signal: "clicked", label: "Useful", Icon: MousePointerClick }, { signal: "saved", label: "Save", Icon: Bookmark }, { signal: "not_interested", label: "Not interested", Icon: ThumbsDown }, { signal: "dismissed", label: "Dismiss", Icon: X }] as const;

export function FeedbackControls({ itemId, canOperate }: { itemId: string; canOperate: boolean }) {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ["auth-session"], queryFn: fetchSession });
  const memory = useQuery({ queryKey: ["memory-export"], queryFn: fetchMemory });
  const pending = useRef<{ signal: FeedbackSignal; key: string } | undefined>(undefined);
  const current = memory.data?.feedback.find((record) => record.item_id === itemId && record.actor === session.data?.user.id)?.signal;
  const save = useMutation({ mutationFn: (signal: FeedbackSignal) => {
    if (pending.current?.signal !== signal) pending.current = { signal, key: crypto.randomUUID() };
    return saveFeedback({ itemId, signal, requestKey: pending.current.key });
  }, onSuccess: async () => {
    pending.current = undefined;
    await client.invalidateQueries({ queryKey: ["memory-export"] });
    await client.invalidateQueries({ queryKey: ["runtime-snapshot"] });
    await client.invalidateQueries({ queryKey: ["memory-practices"] });
  } });
  return <div className="feedbackControls" aria-label="Content feedback">
    <div className="rowActions">{actions.map(({ signal, label, Icon }) => <button key={signal} type="button" className="iconButton" aria-label={label} title={canOperate ? label : "Operator permission required"} aria-pressed={current === signal} disabled={!canOperate || save.isPending || memory.isPending || memory.isError} onClick={() => save.mutate(signal)}><Icon size={18} aria-hidden="true" /></button>)}</div>
    {save.isPending ? <small role="status">Saving feedback...</small> : current ? <small role="status">Your feedback: {current.replaceAll("_", " ")}</small> : null}
    {save.isError ? <p role="alert">{save.error.message}</p> : memory.isError ? <p role="alert">Feedback state unavailable</p> : null}
  </div>;
}
