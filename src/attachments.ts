import { z } from "zod";
import { createContext } from "svelte";
import type { SvelteMap } from "svelte/reactivity";
import { fileSchema, imageSchema } from "./chord-contract";
import type { MessageFile, MessageImage } from "./contracts";
import type { LocalConnection } from "./connection";

export type AttachmentDraft = {
  id: string;
  file: File;
  kind: "image" | "file";
  preview?: Blob;
};
export type AttachmentRefs = { images?: MessageImage[]; files?: MessageFile[] };
export type AttachmentTransfer = {
  controller: AbortController;
  progress?: { index: number; total: number };
};
export type AttachmentDraftState = {
  items?: AttachmentDraft[];
  transfer?: AttachmentTransfer;
  notice?: string;
  intaking?: boolean;
};
export const [getAttachmentDrafts, setAttachmentDrafts] =
  createContext<SvelteMap<string, AttachmentDraftState>>();

export const isHeif = (file: File) =>
  /\.(heic|heif)$/i.test(file.name) || /^image\/(heic|heif)$/.test(file.type);
export const attachmentKind = (file: File): AttachmentDraft["kind"] =>
  isHeif(file) ||
  /^image\/(png|jpeg|webp|gif)$/.test(file.type) ||
  /\.(png|jpe?g|webp|gif)$/i.test(file.name)
    ? "image"
    : "file";

export function attachmentError(items: AttachmentDraft[]) {
  const images = items.filter((item) => item.kind === "image");
  const files = items.filter((item) => item.kind === "file");
  if (images.length > 5) return "Choose up to 5 images per message.";
  if (images.some(({ file }) => !file.size || file.size > 5 * 1024 * 1024))
    return "Each image must be at most 5 MiB.";
  if (images.reduce((size, { file }) => size + file.size, 0) > 20 * 1024 * 1024)
    return "Images must total at most 20 MiB.";
  if (files.length > 6) return "Choose up to 6 files per message.";
  if (files.some(({ file }) => file.size > 100_000_000))
    return "Each file must be at most 100 MB.";
  if (files.reduce((size, { file }) => size + file.size, 0) > 200_000_000)
    return "Files must total at most 200 MB.";
  if (items.some(({ file }) => !file.name || file.name.length > 200))
    return "Choose files with names of at most 200 characters.";
  return "";
}

export async function imagePreview(file: File): Promise<Blob | undefined> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    if (!isHeif(file)) throw error;
    // Safari can read HEIC via an image element even if bitmap decoding fails.
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      const decoded = await image.decode().then(
        () => true,
        () => false,
      );
      if (decoded)
        return await previewImage(
          image,
          image.naturalWidth,
          image.naturalHeight,
        );
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    return await previewImage(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function previewImage(
  source: CanvasImageSource,
  width: number,
  height: number,
) {
  if (width * height > 40_000_000 || width > 16383 || height > 16383)
    throw new Error("Image exceeds 40 megapixels or 16383 pixels per side.");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare image preview.");
  for (const [side, quality] of [
    [480, 0.8],
    [320, 0.5],
  ]) {
    const scale = Math.min(1, side / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (blob && blob.size <= 160_000) return blob;
  }
  throw new Error("Could not prepare a bounded image preview.");
}

const preparedSchema = z.object({
  agent: z.string(),
  operation: z.string(),
  images: z.array(imageSchema).max(5),
  files: z.array(fileSchema).max(6),
});

export async function discardAttachments(
  connection: LocalConnection,
  agent: string,
  operation: string,
) {
  const query = new URLSearchParams({ agent, operation });
  await connection.media(agent, `/api/attachments?${query}`, {
    method: "DELETE",
    timeoutMs: 5_000,
  });
}

export async function uploadAttachments(
  connection: LocalConnection,
  agent: string,
  operation: string,
  text: string,
  mode: "direct" | "follow_up",
  items: AttachmentDraft[],
  signal: AbortSignal,
  onprogress: (index: number) => void,
): Promise<AttachmentRefs> {
  if (!items.length) return {};
  const query = new URLSearchParams({ agent, operation });
  const call = async (
    suffix: string,
    init: RequestInit,
    timeoutMs?: number,
  ) => {
    const reply = await connection.media(
      agent,
      `/api/attachments${suffix}?${query}`,
      { ...init, signal, timeoutMs },
    );
    const response: unknown = await reply.json();
    if (
      !response ||
      typeof response !== "object" ||
      !("agent" in response) ||
      response.agent !== agent ||
      !("operation" in response) ||
      response.operation !== operation
    )
      throw new Error("Attachment operation identity changed.");
    return response;
  };
  await call("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      mode,
      attachments: items.map(({ kind, file }) => ({
        kind,
        name: file.name,
        bytes: file.size,
      })),
    }),
  });
  for (const [index, item] of items.entries()) {
    onprogress(index);
    const response = await call(
      `/${index}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: item.file,
      },
      30 * 60_000,
    );
    if (!("index" in response) || response.index !== index)
      throw new Error("Attachment upload index changed.");
  }
  onprogress(items.length);
  const prepared = preparedSchema.parse(
    await call("/complete", { method: "POST" }, 10 * 60_000),
  );
  if (
    prepared.images.length !==
      items.filter((item) => item.kind === "image").length ||
    prepared.files.length !==
      items.filter((item) => item.kind === "file").length
  )
    throw new Error("Some attachments were not prepared.");
  return { images: prepared.images, files: prepared.files };
}

export function fileSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  const [value, unit] =
    bytes < 1_000_000 ? [bytes / 1000, "KB"] : [bytes / 1_000_000, "MB"];
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}
