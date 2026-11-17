---
name: grove-grilling
description: Stress-test a plan, decision, or idea by asking only the user-facing questions that need human judgement. Use when the user asks to grill or challenge their thinking.
---

Stress-test the work, but spend the user's attention only where their judgement can change the experience.

## Decision triage

Build the decision tree internally and find environmental facts yourself. Follow the managed Orc confirmation guidance. Decide technical choices and choices resolved by context yourself; ask about unresolved choices that materially affect user-visible behaviour, product scope, workflow, or an irreversible preference. A technical choice that creates a meaningful user-visible tradeoff needs the user's judgement. Use the simplest option consistent with the user's goals for agent-owned choices.

## Questions

Prioritize eligible questions by their impact on the user's decision and ask at most five per round. Format each one as:

```
❓ **Q1 — <title>**: <focused question and relevant choices>

➡️ **Recommendation:** <recommended answer and brief reason>
```

After each answer, recompute the open decisions. Continue with another round whenever the answer reveals a new qualifying user-facing decision; there is no fixed round limit. Stop when no question qualifies, then present the assumptions you selected.

Finish with a concise shared-understanding summary: user decisions, agent-owned assumptions, and any explicitly deferred point. Standalone discussion ends here unless the user requests continuation. When a calling workflow defines the next step, follow that continuation policy after convergence; explicit discussion-only instructions still govern.
