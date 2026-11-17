import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./workspace";
import {
  FakeRuntime,
  fixtureProjects,
  memberPresetsFixture,
  writeMemberPreset,
} from "./testing";

test("new Fast trees apply priority only to capable Orc and Worker models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-fast-"));
  const runtime = new FakeRuntime();
  const memberPresets = await memberPresetsFixture(directory, {
    worker: { model: "sol", effort: "medium" },
  });
  await writeMemberPreset(memberPresets.directory, "luna-worker", {
    worker: { model: "luna", effort: "low" },
  });
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    memberPresets,
  });
  try {
    for (const [orc, worker, preset] of [
      ["sol", "luna", "luna-worker"],
      ["luna", "sol", "codex-only"],
    ] as const) {
      await app.selectMemberPreset(preset);
      const root = await app.createOrc("alpha", {
        fast: true,
        orc: {
          backend: "codex",
          model: orc,
          effort: orc === "sol" ? "medium" : "low",
        },
      });
      const child = (await app.tool(
        runtime.agents.get(root.id)!.token,
        "worker_start",
        {
          project: "alpha",
          title: "Owned",
          spec: "#4298",
          message: "Do work",
        },
      )) as { id: string };
      expect(root.treeFast).toBe(true);
      expect(root.serviceTier).toBe(orc === "sol" ? "priority" : "default");
      expect(app.detail(child.id).serviceTier).toBe(
        worker === "sol" ? "priority" : "default",
      );
    }
  } finally {
    app.dispose();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
