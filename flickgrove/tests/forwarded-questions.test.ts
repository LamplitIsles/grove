import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../server/workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixtureSync,
} from "../server/testing";
import { projectConversation } from "../src/conversation-projection";
import type { Detail, Message, Delivery } from "../src/contracts";

test("confirmed forwarded member questions are hidden across live and native history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-forwarded-question-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    reviewerSnapshot: async () => ({ prompt: "Read only" }),
    researcherSnapshot: async () => ({ prompt: "Research" }),
    memberPresets: memberPresetsFixtureSync(directory),
  });
  try {
    const orc = await app.createOrc("alpha");
    const owner = runtime.agents.get(orc.id)!.token;
    const worker = (await app.tool(owner, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "fixture",
      message: "Implement",
    })) as Detail;
    const reviewer = (await app.tool(owner, "reviewer_start", {
      project: "alpha",
      title: "Reviewer",
      profile: "standards",
      spec: "fixture",
      fixedPoint: "base",
      reviewedHead: "head",
      message: "Review",
    })) as Detail;
    const researcher = (await app.tool(owner, "researcher_start", {
      project: "alpha",
      title: "Researcher",
      question: "Investigate?",
      message: "Research",
    })) as Detail;
    const members = [worker, reviewer, researcher];
    for (const member of members) {
      runtime.emit(member.id, {
        type: "item",
        turnId: app.detail(member.id).turnId!,
        item: {
          id: `ask-${member.role}`,
          type: "agentMessage",
          delivery: "async",
          text: `Question from ${member.role}`,
          questions: [{ question: `Choose for ${member.role}?` }],
        },
      });
    }
    for (let i = 0; i < 300; i++) {
      if (
        app
          .detail(orc.id)
          .deliveries.filter(
            (d) => d.id.startsWith("report:") && d.status === "sent",
          ).length === 3
      )
        break;
      await Bun.sleep(10);
    }
    await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
      message: "Ordinary report",
    });
    const questionIds = members.map((m) => `report:${m.id}:ask-${m.role}`);
    const check = (messages: Message[], deliveries: Delivery[] = []) => {
      const rows = projectConversation(messages, deliveries);
      for (const questionId of questionIds) {
        expect(
          messages.some(
            (message) =>
              message.clientId === questionId ||
              message.delivery?.id === questionId,
          ),
        ).toBe(true);
        expect(
          rows.some(
            (row) =>
              row.type === "message" &&
              (row.message.clientId === questionId ||
                row.message.delivery?.id === questionId),
          ),
        ).toBe(false);
      }
      expect(
        rows.some(
          (row) =>
            row.type === "message" &&
            row.message.text.includes("Ordinary report"),
        ),
      ).toBe(false);
    };
    let live = app.detail(orc.id);
    check(live.messages, live.deliveries);
    runtime.emit(orc.id, {
      type: "item",
      turnId: app.detail(orc.id).turnId!,
      item: {
        id: "answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "Orc result",
      },
    });
    live = app.detail(orc.id);
    check(live.messages, live.deliveries);
    const history = await app.agentHistory(orc.id);
    check(history.messages);
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
