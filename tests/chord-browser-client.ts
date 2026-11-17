import { openGrove, RequestRejected } from "../src/chord-client";

// This entry is served only by the test-owned browser fixture.
const state = {
  client: null as Awaited<ReturnType<typeof openGrove>> | null,
  views: [] as unknown[],
  offline: 0,
  pending: null as Promise<string> | null,
};

Object.assign(globalThis, {
  probe: {
    state,
    async connect() {
      const socket = new WebSocket(
        `${location.origin.replace("http:", "ws:")}/api/socket`,
        "grove.v1",
      );
      state.client = await openGrove(
        socket,
        (view) => state.views.push(view),
        () => state.offline++,
      );
    },
    call(
      member: Parameters<NonNullable<typeof state.client>["call"]>[0],
      input: unknown,
    ) {
      if (!state.client) throw new Error("No client");
      return state.client.call(member, input);
    },
    async rejected() {
      try {
        await state.client!.call("select", { ids: ["foreign:missing"] });
        return false;
      } catch (error) {
        return error instanceof RequestRejected;
      }
    },
    startSend(id: string) {
      state.pending = state
        .client!.call("send", {
          id,
          text: "owned browser",
          operationId: "browser-once",
        })
        .then(
          () => "resolved",
          (error: unknown) =>
            error instanceof RequestRejected ? "rejected" : "unknown",
        );
    },
    close() {
      state.client!.close();
    },
    outcome() {
      return state.pending;
    },
  },
});
