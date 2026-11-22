import { z } from "zod";
export const sessionTitle = z.string().trim().min(1).max(120);
const message = z.string().trim().min(1).max(100_000);
const workerId = z.string().min(1);
const reviewerId = z.string().min(1);
const profile = z.enum(["standards", "spec", "high_risk_spec"]);
const target = {
  spec: z.string().trim().min(1).max(500),
  fixedPoint: z.string().trim().min(1).max(500),
  reviewedHead: z.string().trim().min(1).max(500),
};
const researcherId = z.string().min(1);
const question = z.string().trim().min(1).max(10_000);
const renderShape = {
  render: z.enum(["http", "browser"]).optional(),
  waitMs: z.number().int().min(0).max(30_000).optional(),
};
export const webToolNames = [
  "web_fetch_structured",
  "web_links",
  "web_docs_resolve",
  "web_docs_fetch",
] as const;
export const toolDefinitions = {
  web_fetch_structured: {
    description:
      'Read an HTTP(S) page with structured Markdown navigation. HTTP is default and can reach Grove machine localhost and private networks. Browser rendering permits public targets only and is limited to the target domain and allowed CDNs; explicit render="browser" requires waitMs 0–30000 and an installed agent-browser. No automatic fallback. This is distinct from Pi DeepSeek web_fetch.',
    shape: {
      url: z.string(),
      mode: z.enum(["auto", "full", "tree"]).optional(),
      section_id: z.string().min(1).optional(),
      ...renderShape,
    },
  },
  web_links: {
    description:
      'Extract HTTP(S) links from a page. HTTP is default and can reach Grove machine localhost and private networks. Browser rendering permits public targets only and is limited to the target domain and allowed CDNs; explicit render="browser" requires waitMs 0–30000 and agent-browser.',
    shape: {
      url: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      ...renderShape,
    },
  },
  web_docs_resolve: {
    description:
      "Find Context7 libraries by name; anonymous when no instance key is configured.",
    shape: { query: z.string().min(1) },
  },
  web_docs_fetch: {
    description: "Read Context7 documentation for a resolved library ID.",
    shape: {
      library_id: z.string().min(1),
      topic: z.string().optional(),
      tokens: z.number().int().optional(),
    },
  },
  orc_handoff: {
    description:
      "Mark this turn's user handoff only after delivering the result and waiting for the user's next instruction. No notification until successful completion with no pending work. Do not use for progress, waiting for members or product questions (use request_user_input_async). Does not send, stop or close anything. Unknown outcomes must be inspected, never automatically replayed.",
    shape: { summary: z.string().trim().min(1).max(300) },
  },
  researcher_start: {
    description:
      "Start an owned Researcher for one bounded question in a registered project. Captures application configuration. Includes dispatch; inspect list/read after unknown admission before retrying.",
    shape: {
      project: z.string().min(1),
      title: sessionTitle,
      question,
      message,
    },
  },
  researcher_list: {
    description: "List your open Researchers, questions and state.",
    shape: {},
  },
  researcher_read: {
    description:
      "Read your Researcher and its evidence conversation; paginate with nextBefore. Does not poll.",
    shape: {
      researcherId,
      before: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  researcher_send: {
    description:
      "Follow up the same research question, steering when busy or starting when idle. questionIds answers only specific delegated questions. Closing accepts only existing answers; inspect unknown delivery before retrying.",
    shape: {
      researcherId,
      message,
      questionIds: z.array(z.string().min(1)).max(100).optional(),
    },
  },
  researcher_close: {
    description:
      "Request durable asynchronous closure with existing work/question/report guards. closing=true means accepted. confirmInterrupted acknowledges an inspected unknown turn; native release failure can be retried.",
    shape: { researcherId, confirmInterrupted: z.boolean().optional() },
  },
  researcher_report: {
    description:
      "Return natural-language progress, questions or evidence to owning Orc for your assigned question. Include verified facts/sources, interpretations, conflicts, unknowns and leads; Orc owns synthesis and archival.",
    shape: { question, message },
  },
  reviewer_start: {
    description:
      "Start an independent read-only Reviewer in a registered project. Optional worktree selects an existing absolute linked root of that project on the tree's device. Captures profile configuration and prompt. Includes initial dispatch; inspect reviewer_list/read after uncertain admission, never replay blindly.",
    shape: {
      project: z.string().min(1),
      worktree: z.string().min(1).optional(),
      profile,
      title: sessionTitle,
      ...target,
      message,
    },
  },
  reviewer_list: {
    description:
      "List your open Reviewers and their saved review targets, state and questions.",
    shape: {},
  },
  reviewer_read: {
    description:
      "Read your Reviewer conversation and target; paginate with nextBefore. Does not poll.",
    shape: {
      reviewerId,
      before: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  reviewer_send: {
    description:
      "Continue the same Reviewer for re-review with an explicit fixed point and reviewed HEAD. questionIds answers only specific delegated questions. Pending closure accepts only such answers; target cannot change during closure. Inspect uncertain state before retrying.",
    shape: {
      reviewerId,
      ...target,
      message,
      questionIds: z.array(z.string().min(1)).max(100).optional(),
    },
  },
  reviewer_close: {
    description:
      "Request durable asynchronous Reviewer closure. Does not interrupt. Existing question/report/delivery guards apply; closing=true means accepted. Explicit confirmInterrupted resolves an inspected unknown turn, not deliveries.",
    shape: { reviewerId, confirmInterrupted: z.boolean().optional() },
  },
  reviewer_report: {
    description:
      "Report natural-language progress/questions/conclusion to owning Orc. spec, fixedPoint and reviewedHead must match the assigned target; report preserves Reviewer identity, profile, spec, fixed point and HEAD. Never claim unperformed validation.",
    shape: { message, ...target },
  },
  worker_start: {
    description:
      "Start one implementation Worker for one registered project and one spec. Optional worktree selects an existing absolute linked root of that project on the tree's device. Uses the instance's current member model preset. Return the Worker ID for subsequent operations.",
    shape: {
      project: z.string().min(1),
      worktree: z.string().min(1).optional(),
      title: sessionTitle,
      spec: z.string().trim().min(1).max(500),
      message,
    },
  },
  worker_list: {
    description:
      "List your Workers with current state, project, questions and continuous working timestamp.",
    shape: {},
  },
  worker_read: {
    description:
      "Read complete natural-language Worker messages. Omit before to start at the newest page; use nextBefore for earlier history. Never polls new messages. Includes current Worker state.",
    shape: {
      workerId,
      before: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  worker_send: {
    description:
      "Send instructions to your Worker. Steers when busy, starts when idle. Include questionIds only for specific delegated questions this message answers. A Worker awaiting closure only accepts answers to existing delegated questions.",
    shape: {
      workerId,
      message,
      questionIds: z.array(z.string().min(1)).max(100).optional(),
    },
  },
  worker_close: {
    description:
      "Request closure of your Worker. Closes immediately when ready; otherwise returns closing=true with a waiting reason and automatically closes after the current turn, questions and report deliveries resolve. Does not interrupt work. No new tasks are accepted after this request; answers to existing delegated questions remain allowed. Inspect worker_list or worker_read for pending closure reasons; do not retry closure just because work is still running. If the backend restarted or disconnected, inspect the interrupted Worker and explicitly confirmInterrupted to resolve an unknown turn outcome; delivery and question guards still apply.",
    shape: { workerId, confirmInterrupted: z.boolean().optional() },
  },
  worker_report: {
    description:
      "Deliver a natural-language progress update, question or completion report to your owning Orc. The host routes delivery; you do not need to inspect Orc state.",
    shape: { message },
  },
};
export const roleTools = {
  orc: [
    "orc_handoff",
    "researcher_start",
    "researcher_list",
    "researcher_read",
    "researcher_send",
    "researcher_close",
    "worker_start",
    "worker_list",
    "worker_read",
    "worker_send",
    "worker_close",
    "reviewer_start",
    "reviewer_list",
    "reviewer_read",
    "reviewer_send",
    "reviewer_close",
    ...webToolNames,
  ],
  worker: ["worker_report", ...webToolNames],
  reviewer: ["reviewer_report", ...webToolNames],
  researcher: ["researcher_report", ...webToolNames],
} as const;
