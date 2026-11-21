import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MessageFile, MessageImage } from "../src/contracts";
import { IMAGE_BYTES, MESSAGE_IMAGE_BYTES, type ImageStore } from "./images";

export const FILE_BYTES = 100_000_000;
export const MESSAGE_FILE_BYTES = 200_000_000;
const MAX_TEMP_BYTES = 512_000_000;
const MAX_TEMP_OPERATIONS = 100;
const DAY = 24 * 60 * 60 * 1000;
const safeName = (name: string) =>
  [...name].every((character) => {
    const code = character.codePointAt(0)!;
    return (
      code >= 32 &&
      code !== 127 &&
      (code < 0xd800 || code > 0xdfff) &&
      character !== "/" &&
      character !== "\\"
    );
  });
const entrySchema = z
  .object({
    kind: z.enum(["image", "file"]),
    name: z
      .string()
      .min(1)
      .max(200)
      .refine(safeName, "Invalid attachment name"),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export const attachmentManifestSchema = z
  .object({
    text: z.string().max(100_000),
    mode: z.enum(["direct", "follow_up"]),
    attachments: z.array(entrySchema).min(1).max(11),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const kind of ["image", "file"] as const) {
      const entries = value.attachments.filter((entry) => entry.kind === kind);
      const count = kind === "image" ? 5 : 6;
      const single = kind === "image" ? IMAGE_BYTES : FILE_BYTES;
      const total = kind === "image" ? MESSAGE_IMAGE_BYTES : MESSAGE_FILE_BYTES;
      if (
        entries.length > count ||
        entries.some(
          (e) => e.bytes > single || (kind === "image" && !e.bytes),
        ) ||
        entries.reduce((sum, e) => sum + e.bytes, 0) > total
      )
        ctx.addIssue({
          code: "custom",
          message: `${kind} attachment limit exceeded`,
        });
    }
  });
export type AttachmentManifest = z.infer<typeof attachmentManifestSchema>;
export type AttachmentStage = {
  agent: string;
  operation: string;
  owner: string;
  manifest: AttachmentManifest;
  at: number;
  uploaded: boolean[];
  fingerprints: (string | null)[];
  images?: MessageImage[];
  files?: MessageFile[];
};
const key = (agent: string, operation: string) =>
  createHash("sha256")
    .update(JSON.stringify([agent, operation]))
    .digest("hex");

/** Private, operation-bound upload preparation. Publication is owned by Workspace. */
export class AttachmentStore {
  private busy = new Set<string>();
  private discarded = new Map<string, { owner: string; at: number }>();
  constructor(
    readonly directory: string,
    private images: ImageStore,
    private referenced: (stage: AttachmentStage) => boolean = () => false,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.cleanup();
  }
  private path(agent: string, operation: string) {
    return join(this.directory, key(agent, operation));
  }
  has(agent: string, operation: string) {
    return existsSync(join(this.path(agent, operation), "manifest.json"));
  }
  private read(agent: string, operation: string): AttachmentStage {
    const path = join(this.path(agent, operation), "manifest.json");
    if (!existsSync(path)) throw new Error("Attachment preparation not found");
    const stage = JSON.parse(readFileSync(path, "utf8")) as AttachmentStage;
    if (stage.agent !== agent || stage.operation !== operation)
      throw new Error("Attachment identity mismatch");
    return stage;
  }
  get(agent: string, operation: string) {
    return this.read(agent, operation);
  }
  private save(stage: AttachmentStage) {
    const dir = this.path(stage.agent, stage.operation);
    const temporary = join(
      dir,
      `manifest-${randomBytes(8).toString("hex")}.tmp`,
    );
    writeFileSync(temporary, JSON.stringify(stage), { mode: 0o600 });
    renameSync(temporary, join(dir, "manifest.json"));
  }
  cleanup(now = Date.now()) {
    for (const [name, tombstone] of this.discarded)
      if (now - tombstone.at > DAY && !this.busy.has(name))
        this.discarded.delete(name);
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name) || this.busy.has(name)) continue;
      const dir = join(this.directory, name);
      try {
        const stage = JSON.parse(
          readFileSync(join(dir, "manifest.json"), "utf8"),
        ) as AttachmentStage;
        if (now - stage.at > DAY && !this.referenced(stage)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* Preserve unknown state for inspection. */
      }
    }
  }
  begin(agent: string, operation: string, owner: string, input: unknown) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(operation))
      throw new Error("Invalid attachment operation");
    const manifest = attachmentManifestSchema.parse(input);
    if (this.wasDiscarded(agent, operation))
      throw new Error("Attachment preparation was discarded");
    const dir = this.path(agent, operation);
    if (existsSync(dir)) {
      const stage = this.authorize(agent, operation, owner);
      if (JSON.stringify(stage.manifest) !== JSON.stringify(manifest))
        throw new Error("Operation ID is bound to different content");
      return;
    }
    this.cleanup();
    let bytes = 0,
      count = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const stage = JSON.parse(
          readFileSync(join(this.directory, name, "manifest.json"), "utf8"),
        ) as AttachmentStage;
        if (!this.referenced(stage)) {
          count++;
          bytes += stage.manifest.attachments.reduce(
            (sum, item) => sum + item.bytes,
            0,
          );
        }
      } catch {
        throw new Error("Temporary attachment storage unavailable");
      }
    }
    if (
      count >= MAX_TEMP_OPERATIONS ||
      bytes + manifest.attachments.reduce((sum, item) => sum + item.bytes, 0) >
        MAX_TEMP_BYTES
    )
      throw new Error("Temporary attachment storage full");
    mkdirSync(dir, { mode: 0o700 });
    try {
      this.save({
        agent,
        operation,
        owner,
        manifest,
        at: Date.now(),
        uploaded: manifest.attachments.map(() => false),
        fingerprints: manifest.attachments.map(() => null),
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  wasDiscarded(agent: string, operation: string, owner?: string) {
    const discarded = this.discarded.get(key(agent, operation));
    return !!discarded && (owner === undefined || discarded.owner === owner);
  }
  private removeDiscarded(agent: string, operation: string) {
    this.images.discardScoped(agent, operation);
    rmSync(this.path(agent, operation), { recursive: true, force: true });
  }
  discard(
    agent: string,
    operation: string,
    owner: string,
    allowMissing = false,
  ) {
    if (this.wasDiscarded(agent, operation, owner)) {
      if (!this.busy.has(key(agent, operation)) && this.has(agent, operation))
        this.removeDiscarded(agent, operation);
      return;
    }
    if (!this.has(agent, operation)) {
      if (!allowMissing || this.wasDiscarded(agent, operation))
        throw new Error("Attachment preparation not found");
      this.discarded.set(key(agent, operation), { owner, at: Date.now() });
      return;
    }
    this.authorize(agent, operation, owner);
    this.discarded.set(key(agent, operation), { owner, at: Date.now() });
    if (!this.busy.has(key(agent, operation)))
      this.removeDiscarded(agent, operation);
  }
  authorize(agent: string, operation: string, owner: string) {
    const stage = this.read(agent, operation);
    if (this.wasDiscarded(agent, operation))
      throw new Error("Attachment preparation was discarded");
    if (stage.owner !== owner)
      throw new Error("Attachment preparation belongs to another user");
    return stage;
  }
  validate(
    agent: string,
    operation: string,
    owner: string,
    text: string,
    mode: AttachmentManifest["mode"],
    images: MessageImage[],
    files: MessageFile[],
    retry = false,
  ) {
    const matches = (stage: AttachmentStage) =>
      stage.agent === agent &&
      stage.owner === owner &&
      stage.manifest.text === text &&
      stage.manifest.mode === mode &&
      JSON.stringify(stage.images) === JSON.stringify(images) &&
      JSON.stringify(stage.files) === JSON.stringify(files);
    let stage: AttachmentStage | undefined;
    if (retry && this.has(agent, operation)) {
      const direct = this.authorize(agent, operation, owner);
      if (matches(direct)) stage = direct;
    }
    if (retry && !stage) {
      for (const name of readdirSync(this.directory)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const candidate = JSON.parse(
          readFileSync(join(this.directory, name, "manifest.json"), "utf8"),
        ) as AttachmentStage;
        if (matches(candidate)) {
          stage = candidate;
          break;
        }
      }
    } else if (!retry) {
      stage = this.authorize(agent, operation, owner);
    }
    if (!stage || !matches(stage))
      throw new Error(
        "Attachments do not belong to this conversation and operation",
      );
    return stage;
  }
  filePath(stage: AttachmentStage, id: string) {
    let fileIndex = 0;
    for (const [index, entry] of stage.manifest.attachments.entries()) {
      if (entry.kind !== "file") continue;
      const file = stage.files?.[fileIndex++];
      if (file?.id !== id) continue;
      const path = join(
        this.path(stage.agent, stage.operation),
        `${index}.data`,
      );
      if (!existsSync(path)) throw new Error("Message attachment is missing");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== file.bytes)
        throw new Error("Message attachment is missing");
      return path;
    }
    throw new Error("Message attachment does not belong to this operation");
  }
  async verifyFiles(stage: AttachmentStage, selectedId?: string) {
    let fileIndex = 0;
    for (const [index, entry] of stage.manifest.attachments.entries()) {
      if (entry.kind !== "file") continue;
      const file = stage.files?.[fileIndex++];
      if (selectedId && file?.id !== selectedId) continue;
      const fingerprint = stage.fingerprints[index];
      if (!file || !fingerprint)
        throw new Error("Attachment evidence is unavailable");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(this.filePath(stage, file.id)))
        digest.update(chunk);
      if (digest.digest("hex") !== fingerprint)
        throw new Error("Message attachment content changed");
    }
  }
  async put(
    agent: string,
    operation: string,
    owner: string,
    index: number,
    body: ReadableStream<Uint8Array> | null,
  ) {
    const stage = this.authorize(agent, operation, owner);
    const entry = stage.manifest.attachments[index];
    if (!Number.isInteger(index) || !entry)
      throw new Error("Invalid attachment index");
    if (stage.images || stage.files || stage.uploaded[index])
      throw new Error("Attachment already uploaded");
    const lock = key(agent, operation);
    if (this.busy.has(lock)) throw new Error("Attachment preparation busy");
    this.busy.add(lock);
    const dir = this.path(agent, operation),
      temporary = join(dir, `${index}.part`),
      target = join(dir, `${index}.data`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      file = await open(temporary, "w", 0o600);
      reader = body?.getReader();
      let size = 0;
      const digest = createHash("sha256");
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          digest.update(part.value);
          if (size > entry.bytes)
            throw new Error("Attachment exceeds declared size");
          let offset = 0;
          while (offset < part.value.byteLength) {
            const written = (await file.write(part.value, offset)).bytesWritten;
            if (!written) throw new Error("Could not write attachment");
            offset += written;
          }
        }
      if (size !== entry.bytes) throw new Error("Attachment upload truncated");
      await file.close();
      file = undefined;
      if (entry.kind === "file") chmodSync(temporary, 0o400);
      renameSync(temporary, target);
      stage.uploaded[index] = true;
      stage.fingerprints[index] = digest.digest("hex");
      this.save(stage);
    } catch (error) {
      failed = true;
      failure = error;
      try {
        await reader?.cancel?.();
      } catch {
        /* The connection may already be closed. */
      }
    } finally {
      let cleanupError: unknown;
      try {
        await file?.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        rmSync(temporary, { force: true });
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        reader?.releaseLock?.();
      } catch {
        // Bun's native HTTP reader can throw when released after completion.
      }
      this.busy.delete(lock);
      if (this.wasDiscarded(agent, operation)) {
        try {
          this.removeDiscarded(agent, operation);
        } catch (error) {
          cleanupError ??= error;
        }
        if (!failed && !cleanupError)
          cleanupError = new Error("Attachment preparation was discarded");
      }
      if (!failed && cleanupError) {
        failed = true;
        failure = cleanupError;
      }
    }
    if (failed) throw failure;
  }
  async complete(agent: string, operation: string, owner: string) {
    const stage = this.authorize(agent, operation, owner);
    if (stage.images && stage.files)
      return { images: stage.images, files: stage.files };
    if (stage.uploaded.some((uploaded) => !uploaded))
      throw new Error("Upload every attachment first");
    const lock = key(agent, operation);
    if (this.busy.has(lock)) throw new Error("Attachment preparation busy");
    this.busy.add(lock);
    try {
      const dir = this.path(agent, operation);
      const imageFiles: File[] = [];
      const files: MessageFile[] = [];
      for (const [index, entry] of stage.manifest.attachments.entries()) {
        if (entry.kind === "image")
          imageFiles.push(
            new File(
              [await Bun.file(join(dir, `${index}.data`)).arrayBuffer()],
              entry.name,
            ),
          );
        else
          files.push({
            id: createHash("sha256")
              .update(
                `${key(agent, operation)}:${index}:${stage.fingerprints[index]}`,
              )
              .digest("hex"),
            name: entry.name,
            bytes: entry.bytes,
          });
      }
      const images = imageFiles.length
        ? await this.images.upload(
            agent,
            operation,
            stage.manifest.text,
            imageFiles,
            true,
          )
        : [];
      stage.images = images;
      stage.files = files;
      this.save(stage);
      for (const [index, entry] of stage.manifest.attachments.entries()) {
        if (entry.kind === "image")
          rmSync(join(dir, `${index}.data`), { force: true });
      }
      return { images, files };
    } finally {
      this.busy.delete(lock);
      if (this.wasDiscarded(agent, operation))
        this.removeDiscarded(agent, operation);
    }
  }
}
