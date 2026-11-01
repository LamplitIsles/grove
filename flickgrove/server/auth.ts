import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { and, eq, gt } from "drizzle-orm";
import {
  betterAuth,
  getCurrentAdapter,
  type BetterAuthPlugin,
} from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import * as schema from "./schema";
import type { WorkspaceStore } from "./workspace-store";

const lifetime = 10 * 60_000;
const random = () => randomBytes(32).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const invalid = () =>
  new APIError("UNAUTHORIZED", { message: "Code is invalid or expired" });
const colors = [
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#84cc16",
  "#f43f5e",
  "#eab308",
  "#d946ef",
  "#10b981",
];
const pairingPlugin = {
  id: "grove-pairing",
  schema: {
    authPairing: {
      fields: {
        codeHash: { type: "string", required: true },
        kind: { type: "string", required: true },
        targetUserId: { type: "string", required: false },
        expiresAt: { type: "date", required: true },
        generation: { type: "string", required: true },
      },
    },
  },
} satisfies BetterAuthPlugin;
type Pairing = {
  id: string;
  generation: string;
  userId: string;
  name: string;
  kind: "bootstrap" | "invite" | "recovery";
};
export type Human = { id: string; name: string; color: string };
export type HumanSession = {
  user: Human;
  sessionId: string;
  expiresAt: number;
};

export class GroveAuth {
  private readonly sqlite: Database;
  private readonly secret: string;
  private readonly auth;
  private readonly listeners = new Set<
    (userId: string, sessionId?: string) => void
  >();
  private readonly userListeners = new Set<() => void>();
  constructor(
    private readonly store: WorkspaceStore,
    directory: string,
    readonly origin: string,
  ) {
    const path = join(directory, "auth-secret");
    try {
      writeFileSync(path, random(), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error("Authentication secret must be a private regular file");
    this.secret = readFileSync(path, "utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.secret))
      throw new Error("Invalid authentication secret");
    const dbPath = join(directory, "workspace.sqlite");
    const dbInfo = lstatSync(dbPath);
    if (!dbInfo.isFile())
      throw new Error("Workspace database must be a regular file");
    chmodSync(dbPath, 0o600);
    this.sqlite = new Database(dbPath);
    this.sqlite.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    this.auth = betterAuth({
      database: this.sqlite,
      baseURL: origin,
      secret: this.secret,
      telemetry: { enabled: false },
      trustedOrigins: [origin],
      advanced: {
        defaultCookieAttributes: {
          httpOnly: true,
          sameSite: "strict",
          secure: origin.startsWith("https:"),
        },
      },
      session: { cookieCache: { enabled: false } },
      user: {
        additionalFields: {
          color: { type: "string", required: true, input: false },
        },
      },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/sign-out") {
            const session = await getSessionFromCtx(ctx);
            if (session)
              await ctx.context.adapter.delete({
                model: "session",
                where: [{ field: "id", value: session.session.id }],
              });
          }
          if (
            ctx.path === "/passkey/generate-register-options" ||
            ctx.path === "/passkey/verify-registration"
          ) {
            const session = await getSessionFromCtx(ctx);
            if (!session && !this.pair(ctx.headers?.get("cookie")))
              throw invalid();
            if (ctx.path === "/passkey/verify-registration") {
              if (session && ctx.body?.createSession === true)
                throw new APIError("BAD_REQUEST", {
                  message: "Adding a passkey must keep the current session",
                });
              if (!session && ctx.body?.createSession !== true)
                throw new APIError("BAD_REQUEST", {
                  message: "Pairing requires a new session",
                });
            }
          }
        }),
      },
      plugins: [
        pairingPlugin,
        passkey({
          rpID: new URL(origin).hostname,
          rpName: "FlickGrove",
          origin,
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          registration: {
            requireSession: false,
            resolveUser: ({ ctx }) => {
              const pair = this.pair(ctx.headers?.get("cookie"));
              if (!pair) throw invalid();
              return {
                id: pair.userId,
                name: pair.name,
                displayName: pair.name,
              };
            },
            afterVerification: async ({ ctx, user, verification }) => {
              if (!verification.registrationInfo?.userVerified)
                throw new APIError("UNAUTHORIZED");
              const session = await getSessionFromCtx(ctx);
              if (session) {
                if (session.user.id !== user.id)
                  throw new APIError("UNAUTHORIZED");
                return;
              }
              const pair = this.pair(ctx.headers?.get("cookie"));
              if (!pair || pair.userId !== user.id) throw invalid();
              const adapter = await getCurrentAdapter(ctx.context.adapter);
              const consumed = await adapter.consumeOne({
                model: "authPairing",
                where: [
                  { field: "id", value: pair.id },
                  { field: "generation", value: pair.generation },
                  { field: "kind", value: pair.kind },
                  { field: "expiresAt", operator: "gt", value: new Date() },
                ],
              });
              if (
                !consumed ||
                (pair.kind === "recovery" &&
                  (consumed as { targetUserId?: string }).targetUserId !==
                    pair.userId)
              )
                throw invalid();
              if (
                pair.kind === "bootstrap" &&
                (await adapter.count({ model: "user" }))
              )
                throw invalid();
              if (pair.kind === "recovery") {
                const target = await adapter.findOne({
                  model: "user",
                  where: [{ field: "id", value: pair.userId }],
                });
                if (!target) throw invalid();
                for (const model of ["passkey", "session"])
                  await adapter.deleteMany({
                    model,
                    where: [{ field: "userId", value: pair.userId }],
                  });
              } else {
                const count = await adapter.count({ model: "user" });
                await adapter.create({
                  model: "user",
                  forceAllowId: true,
                  data: {
                    id: pair.userId,
                    name: pair.name,
                    email: `${pair.userId}@grove.invalid`,
                    emailVerified: false,
                    color: colors[count % colors.length],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
              }
            },
          },
          authentication: {
            afterVerification: ({ verification }) => {
              if (!verification.authenticationInfo.userVerified)
                throw new APIError("UNAUTHORIZED");
            },
          },
        }),
      ],
    });
  }
  onRevoke(listener: (userId: string, sessionId?: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onUsersChanged(listener: () => void) {
    this.userListeners.add(listener);
    return () => this.userListeners.delete(listener);
  }
  private revoke(userId: string, sessionId?: string) {
    for (const listener of this.listeners) listener(userId, sessionId);
  }
  private sign(value: string) {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
  private pair(cookie: string | null | undefined): Pairing | undefined {
    const values = (cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("grove_pair="));
    if (values.length !== 1) return;
    const [body, signature] = values[0]!.slice(11).split(".");
    if (!body || !signature) return;
    const expected = Buffer.from(this.sign(body)),
      supplied = Buffer.from(signature);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return;
    try {
      const pair = JSON.parse(
        Buffer.from(body, "base64url").toString(),
      ) as Pairing;
      const row = this.store.db
        .select()
        .from(schema.authPairing)
        .where(
          and(
            eq(schema.authPairing.id, pair.id),
            eq(schema.authPairing.generation, pair.generation),
            gt(schema.authPairing.expiresAt, new Date().toISOString()),
          ),
        )
        .get();
      if (
        !row ||
        row.kind !== pair.kind ||
        (row.kind === "recovery" && row.targetUserId !== pair.userId)
      )
        return;
      return pair;
    } catch {
      return;
    }
  }
  issue(kind: Pairing["kind"], targetUserId?: string) {
    if (
      kind === "bootstrap" &&
      this.store.db
        .select({ id: schema.authUsers.id })
        .from(schema.authUsers)
        .get()
    )
      throw new Error("Grove already has users");
    if (kind === "recovery" && (!targetUserId || !this.user(targetUserId)))
      throw new Error("User not found");
    const code = random(),
      expiresAt = new Date(Date.now() + lifetime).toISOString();
    this.store.db
      .insert(schema.authPairing)
      .values({
        id: crypto.randomUUID(),
        codeHash: hash(code),
        kind,
        targetUserId: targetUserId ?? null,
        expiresAt,
        generation: random(),
      })
      .run();
    return { code, expiresAt };
  }
  users(): Human[] {
    return this.store.db
      .select({
        id: schema.authUsers.id,
        name: schema.authUsers.name,
        color: schema.authUsers.color,
      })
      .from(schema.authUsers)
      .all();
  }
  user(id: string) {
    return this.users().find((u) => u.id === id);
  }
  sessionActive(sessionId: string): boolean {
    return !!this.store.db
      .select({ id: schema.authSessions.id })
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.id, sessionId),
          gt(schema.authSessions.expiresAt, new Date().toISOString()),
        ),
      )
      .get();
  }
  async session(headers: Headers): Promise<HumanSession | null> {
    const session = await this.auth.api.getSession({ headers });
    if (!session) return null;
    const user = this.user(session.user.id);
    return user
      ? {
          user,
          sessionId: session.session.id,
          expiresAt: new Date(session.session.expiresAt).getTime(),
        }
      : null;
  }
  async handle(
    request: Request,
    profileChanged: (user: Human) => void = () => {},
  ): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    const json = (body: unknown, status = 200, headers?: HeadersInit) =>
      Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", ...headers },
      });
    const session = await this.session(request.headers);
    if (path === "/api/auth/status" && request.method === "GET")
      return json(
        session
          ? { state: "signed_in", user: session.user, colors }
          : { state: this.users().length ? "signed_out" : "setup" },
      );
    if (path === "/api/auth/profile" && request.method === "POST") {
      if (!session) return json({ error: "Authentication required" }, 401);
      const body = (await request.json().catch(() => null)) as unknown;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "name" && key !== "color")
      )
        return json({ error: "Invalid profile" }, 400);
      const { name, color } = body as { name?: unknown; color?: unknown };
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 80 ||
        typeof color !== "string" ||
        !colors.includes(color)
      )
        return json({ error: "Enter a valid nickname and color" }, 400);
      if (!this.sessionActive(session.sessionId))
        return json({ error: "Authentication required" }, 401);
      const user = this.store.db
        .update(schema.authUsers)
        .set({ name: name.trim(), color, updatedAt: new Date().toISOString() })
        .where(eq(schema.authUsers.id, session.user.id))
        .returning({
          id: schema.authUsers.id,
          name: schema.authUsers.name,
          color: schema.authUsers.color,
        })
        .get();
      if (!user) return json({ error: "Authentication required" }, 401);
      profileChanged(user);
      for (const listener of this.userListeners) listener();
      return json({ user });
    }
    if (path === "/api/auth/invitations" && request.method === "POST") {
      if (!session) return json({ error: "Authentication required" }, 401);
      return json(this.issue("invite"));
    }
    if (path === "/api/auth/pair" && request.method === "POST") {
      if (session) return json({ error: "Sign out before pairing" }, 400);
      const body = (await request.json().catch(() => null)) as {
        code?: unknown;
        nickname?: unknown;
      } | null;
      if (
        typeof body?.code !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.code)
      )
        return json({ error: "Code is invalid or expired" }, 401);
      const row = this.store.db
        .select()
        .from(schema.authPairing)
        .where(
          and(
            eq(schema.authPairing.codeHash, hash(body.code)),
            gt(schema.authPairing.expiresAt, new Date().toISOString()),
          ),
        )
        .get();
      if (!row) return json({ error: "Code is invalid or expired" }, 401);
      const existing = row.targetUserId
        ? this.user(row.targetUserId)
        : undefined;
      const name =
        row.kind === "recovery"
          ? existing?.name
          : typeof body.nickname === "string"
            ? body.nickname.trim()
            : "";
      if (!name || name.length > 80)
        return json({ error: "Enter a nickname" }, 400);
      const value: Pairing = {
        id: row.id,
        generation: row.generation,
        kind: row.kind,
        userId: existing?.id ?? crypto.randomUUID(),
        name,
      };
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
      return json({ ok: true }, 200, {
        "Set-Cookie": `grove_pair=${encoded}.${this.sign(encoded)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}${this.origin.startsWith("https:") ? "; Secure" : ""}`,
      });
    }
    const allowed = new Set([
      "/api/auth/passkey/generate-register-options",
      "/api/auth/passkey/verify-registration",
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
      "/api/auth/sign-out",
    ]);
    if (!allowed.has(path)) return json({ error: "Action not found" }, 404);
    const pair = this.pair(request.headers.get("cookie"));
    const response = await this.auth.handler(request);
    if (
      response.ok &&
      path === "/api/auth/passkey/verify-registration" &&
      !session &&
      (pair?.kind === "bootstrap" || pair?.kind === "invite")
    )
      for (const listener of this.userListeners) listener();
    if (response.ok && path === "/api/auth/sign-out" && session)
      this.revoke(session.user.id, session.sessionId);
    if (
      response.ok &&
      path === "/api/auth/passkey/verify-registration" &&
      !session &&
      pair?.kind === "recovery"
    )
      this.revoke(pair.userId);
    return response;
  }
  close() {
    this.sqlite.close();
  }
}
