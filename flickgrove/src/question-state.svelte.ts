import type { Agent } from "./contracts";
import { storagePrefix } from "./api";

// Disclosure belongs to this visit. Answer drafts remain in the existing
// Peer-qualified question store. Text drafts take precedence over auto-opening.
export const questionPanels = $state<Record<string, boolean>>({});
const composerDrafts = new Map<string, { text: string }>();
export function registerComposerDraft(id: string, text: string) {
  const draft = { text };
  composerDrafts.set(id, draft);
  return {
    update(value: string) {
      draft.text = value;
    },
    dispose() {
      if (composerDrafts.get(id) === draft) composerDrafts.delete(id);
    },
  };
}
function hasComposerText(id: string): boolean {
  const live = composerDrafts.get(id);
  if (live) return live.text.length > 0;
  try {
    return (
      (localStorage.getItem(`${storagePrefix}/composer/${id}`) ?? "").length > 0
    );
  } catch {
    return false;
  }
}
export function setQuestionPanel(id: string, open: boolean) {
  questionPanels[id] = open;
}
let selected: string | null = null;
let items = new Set<string>();
export function observeQuestions(
  agents: Agent[],
  selectedId: string | null,
  entering = false,
) {
  for (const id of Object.keys(questionPanels))
    if (!agents.some((a) => a.id === id)) delete questionPanels[id];
  const agent = agents.find((a) => a.id === selectedId);
  const enteringVisit = entering || selected !== selectedId;
  if (enteringVisit) {
    selected = selectedId;
    items = new Set();
  }
  if (!agent) return;
  const pending = agent.questions.filter((q) => q.state === "unanswered");
  const next = new Set(pending.map((q) => q.itemId));
  const hasText = hasComposerText(agent.id);
  if (enteringVisit && hasText) setQuestionPanel(agent.id, false);
  else if (
    !hasText &&
    ((enteringVisit && (agent.unansweredCount ?? pending.length) > 0) ||
      [...next].some((id) => !items.has(id)))
  )
    setQuestionPanel(agent.id, true);
  items = next;
}
