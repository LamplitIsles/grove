import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { imageSchema } from "../src/chord-contract";
import type { MessageImage } from "../src/contracts";
import { RequestRefused } from "./runtime";
import { decodeHeif } from "./heif";
export const IMAGE_BYTES = 5 * 1024 * 1024;
export const MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;
export const PREVIEW_BYTES = 160_000;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export type ImageUpload = {
  agent: string;
  operation: string;
  text: string;
  fingerprints: string[];
  images: MessageImage[];
  at: number;
  committed: boolean;
  scoped?: boolean;
};
// Only opaque IDs resolve paths. Original native paths never come from browser input.
export class ImageStore {
  private uploads: ImageUpload[];
  private busy = false;
  constructor(
    readonly directory: string,
    private referenced: (upload: ImageUpload) => boolean = () => false,
    cleanupOnStart = true,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifest = join(directory, "index.json");
    this.uploads = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8"))
      : [];
    if (cleanupOnStart) this.cleanup();
  }
  private save() {
    const temporary = join(this.directory, "index.tmp");
    writeFileSync(temporary, JSON.stringify(this.uploads), { mode: 0o600 });
    renameSync(temporary, join(this.directory, "index.json"));
  }
  cleanup(now = Date.now()) {
    const remove = this.uploads.filter(
      (u) =>
        !u.committed && now - u.at > 24 * 60 * 60 * 1000 && !this.referenced(u),
    );
    this.uploads = this.uploads.filter((u) => !remove.includes(u));
    for (const u of remove)
      for (const image of u.images) {
        rmSync(join(this.directory, image.id), { force: true });
        rmSync(join(this.directory, image.id + ".preview"), { force: true });
      }
    this.save();
  }
  discardScoped(agent: string, operation: string) {
    const upload = this.uploads.find(
      (item) =>
        item.agent === agent && item.operation === operation && item.scoped,
    );
    if (!upload) return;
    if (upload.committed || this.referenced(upload))
      throw new Error("Image preparation is already bound");
    for (const image of upload.images) {
      rmSync(join(this.directory, image.id), { force: true });
      rmSync(join(this.directory, image.id + ".preview"), { force: true });
    }
    this.uploads = this.uploads.filter((item) => item !== upload);
    this.save();
  }
  async upload(
    agent: string,
    operation: string,
    text: string,
    files: File[],
    scoped = false,
  ) {
    if (this.busy)
      throw new Error("Image preparation busy. Try again shortly.");
    this.busy = true;
    try {
      this.cleanup();
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(operation) || text.length > 100_000)
        throw new Error("Invalid image operation");
      if (!files.length || files.length > 5)
        throw new Error("Choose up to 5 images");
      if (files.some((f) => !f.size || f.size > IMAGE_BYTES))
        throw new Error("Each image must be at most 5 MiB");
      if (files.reduce((n, f) => n + f.size, 0) > MESSAGE_IMAGE_BYTES)
        throw new Error("Images must total at most 20 MiB");
      const buffers = await Promise.all(
        files.map(async (f) => Buffer.from(await f.arrayBuffer())),
      );
      const fingerprints = buffers.map((b, i) =>
        hash(Buffer.concat([Buffer.from(files[i].name.slice(0, 200)), b])),
      );
      const prior = this.uploads.find(
        (u) => u.agent === agent && u.operation === operation,
      );
      if (prior) {
        if (
          prior.text !== text ||
          JSON.stringify(prior.fingerprints) !== JSON.stringify(fingerprints)
        )
          throw new Error("Operation ID is bound to different content");
        if (scoped && !prior.scoped) {
          prior.scoped = true;
          this.save();
        }
        return prior.images;
      }
      const orphans = this.uploads.filter(
        (u) => !u.committed && !this.referenced(u),
      );
      if (
        orphans.length >= 100 ||
        orphans.reduce(
          (n, u) => n + u.images.reduce((n, i) => n + i.bytes, 0),
          0,
        ) +
          buffers.reduce((n, b) => n + b.length, 0) >
          200 * 1024 * 1024
      )
        throw new Error("Temporary image storage full. Try again later.");
      const prepared = [];
      for (let i = 0; i < buffers.length; i++) {
        let bytes: Buffer = buffers[i];
        let convertedHeif = false;
        const decode = () =>
          sharp(bytes, {
            limitInputPixels: 40_000_000,
            failOn: "warning",
          }).timeout({ seconds: 10 });
        let meta;
        try {
          meta = await decode().metadata();
        } catch {
          throw new Error("Image is damaged or exceeds 40 megapixels");
        }
        if (meta.format === "heif") {
          try {
            bytes = await decodeHeif(bytes, IMAGE_BYTES);
            convertedHeif = true;
            meta = await decode().metadata();
          } catch {
            throw new Error(
              "HEIF image is damaged, unsupported or exceeds image limits",
            );
          }
        }
        if (
          !["png", "jpeg", "webp", "gif"].includes(meta.format ?? "") ||
          (meta.pages ?? 1) !== 1
        )
          throw new Error("Choose HEIF, PNG, JPEG, WebP or non-animated GIF");
        if (
          !meta.width ||
          !meta.height ||
          meta.width > 16383 ||
          meta.height > 16383
        )
          throw new Error("Image dimensions exceed 16383 pixels");
        // Full decoding verifies truncated data too. Adopt a lossless WebP only if
        // smaller AND decoded RGBA is identical (including alpha/screenshot detail).
        const raw = await decode().ensureAlpha().raw().toBuffer();
        let original = bytes;
        let mediaType = `image/${meta.format === "jpeg" ? "jpeg" : meta.format}`;
        if (!convertedHeif && (!meta.orientation || meta.orientation === 1)) {
          const webp = await decode()
            .webp({ lossless: true, effort: 3 })
            .toBuffer();
          if (webp.length < bytes.length) {
            const roundtrip = await sharp(webp).ensureAlpha().raw().toBuffer();
            if (raw.equals(roundtrip)) {
              original = webp;
              mediaType = "image/webp";
            }
          }
        }
        let preview = await decode()
          .autoOrient()
          .resize({
            width: 480,
            height: 480,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toBuffer();
        if (preview.length > PREVIEW_BYTES)
          preview = await decode()
            .autoOrient()
            .resize({
              width: 320,
              height: 320,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 50 })
            .toBuffer();
        if (preview.length > PREVIEW_BYTES)
          throw new Error("Could not prepare a bounded image preview");
        const id = hash(`${agent}\n${operation}\n${i}\n${fingerprints[i]}`);
        const image = imageSchema.parse({
          id,
          name: files[i].name.slice(0, 200),
          width: meta.width,
          height: meta.height,
          bytes: original.length,
          mediaType,
        });
        prepared.push({ image, original, preview });
      }
      for (const p of prepared) {
        writeFileSync(join(this.directory, p.image.id), p.original, {
          mode: 0o600,
        });
        writeFileSync(
          join(this.directory, p.image.id + ".preview"),
          p.preview,
          { mode: 0o600 },
        );
      }
      const images = prepared.map((p) => p.image);
      this.uploads.push({
        agent,
        operation,
        text,
        fingerprints,
        images,
        at: Date.now(),
        committed: false,
        ...(scoped ? { scoped: true } : {}),
      });
      this.save();
      return images;
    } finally {
      this.busy = false;
    }
  }
  validate(
    agent: string,
    operation: string,
    text: string,
    images: MessageImage[],
  ) {
    const upload = this.uploads.find(
      (u) => u.agent === agent && u.operation === operation,
    );
    if (
      !upload ||
      upload.text !== text ||
      JSON.stringify(upload.images) !== JSON.stringify(images)
    )
      throw new RequestRefused(
        "Images do not belong to this conversation and operation",
      );
    return upload;
  }
  commit(
    agent: string,
    operation: string,
    text: string,
    images: MessageImage[],
    markCommitted = true,
  ) {
    const upload = this.validate(agent, operation, text, images);
    const paths = images.map((image) =>
      join(this.directory, imageSchema.parse(image).id),
    );
    if (paths.some((p) => !existsSync(p)))
      throw new Error(
        "Message image is missing. Restore the message and choose it again.",
      );
    if (markCommitted) {
      upload.committed = true;
      this.save();
    }
    return paths;
  }
  read(agent: string, id: string, preview: boolean) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image reference");
    const image = this.uploads
      .find((u) => u.agent === agent && u.images.some((i) => i.id === id))
      ?.images.find((i) => i.id === id);
    if (!image) throw new Error("Image does not belong to this conversation");
    const path = join(this.directory, id + (preview ? ".preview" : ""));
    if (!existsSync(path)) return null;
    return {
      bytes: readFileSync(path),
      mediaType: preview ? "image/webp" : image.mediaType,
    };
  }
  uploadFor(agent: string, id: string) {
    return this.uploads.find(
      (upload) =>
        upload.agent === agent &&
        upload.images.some((image) => image.id === id),
    );
  }
}
