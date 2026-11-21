import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { orientation } from "exifr";
// libheif-js distributes Emscripten builds without TypeScript declarations.
// @ts-expect-error server-only WASM bundle has no declarations
import heifModule from "libheif-js/wasm-bundle.js";

type HeifImage = {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  free(): void;
  display(
    data: { width: number; height: number; data: Uint8ClampedArray },
    callback: (value: unknown) => void,
  ): void;
};
parentPort!.once(
  "message",
  async ({ bytes, maxBytes }: { bytes: Uint8Array; maxBytes: number }) => {
    let decoder:
      | { decoder: unknown; decode(bytes: Uint8Array): HeifImage[] }
      | undefined;
    let images: HeifImage[] = [];
    const heif = await heifModule;
    try {
      decoder = new heif.HeifDecoder();
      images = decoder!.decode(bytes);
      const image = images.find((entry) => entry.is_primary());
      if (!image) throw new Error("Image is damaged or unsupported");
      // libheif applies HEIF transforms itself. Some older iPhone files carry
      // only EXIF orientation; apply that fallback only when the primary item has
      // no irot or imir property, otherwise it would rotate twice.
      const context = decoder!.decoder as { $$?: { ptr?: number } };
      const ids: number[] =
        heif.heif_js_context_get_list_of_top_level_image_IDs(decoder!.decoder);
      const primary = images.indexOf(image);
      const pointer = context.$$?.ptr;
      if (
        !pointer ||
        ids.length !== images.length ||
        ids[primary] === undefined
      )
        throw new Error("Could not inspect HEIF orientation");
      const hasTransform = ["irot", "imir"].some(
        (type) =>
          heif.heif_item_get_properties_of_type(
            pointer,
            ids[primary],
            heif.fourcc(type),
            0,
            0,
          ) > 0,
      );
      let exifOrientation = 1;
      if (!hasTransform) {
        const exif = (await sharp(Buffer.from(bytes)).metadata()).exif;
        if (exif?.subarray(0, 6).equals(Buffer.from("Exif\0\0")))
          exifOrientation = (await orientation(exif.subarray(6))) ?? 1;
      }
      const width = image.get_width(),
        height = image.get_height();
      if (
        !width ||
        !height ||
        width > 16383 ||
        height > 16383 ||
        width * height > 40_000_000
      )
        throw new Error("Image dimensions exceed limits");
      const data = new Uint8ClampedArray(width * height * 4);
      await new Promise<void>((resolve, reject) =>
        image.display({ width, height, data }, (value) =>
          value ? resolve() : reject(new Error("Could not decode HEIF image")),
        ),
      );
      let outputImage = sharp(Buffer.from(data), {
        raw: { width, height, channels: 4 },
      });
      switch (exifOrientation) {
        case 2:
          outputImage = outputImage.flop();
          break;
        case 3:
          outputImage = outputImage.rotate(180);
          break;
        case 4:
          outputImage = outputImage.flip();
          break;
        case 5:
          outputImage = outputImage.flip().rotate(90);
          break;
        case 6:
          outputImage = outputImage.rotate(90);
          break;
        case 7:
          outputImage = outputImage.flop().rotate(90);
          break;
        case 8:
          outputImage = outputImage.rotate(270);
          break;
      }
      let output = await outputImage
        .clone()
        .webp({ lossless: true, effort: 3 })
        .toBuffer();
      for (const quality of [85, 70, 50, 30, 15]) {
        if (output.length <= maxBytes) break;
        output = await outputImage
          .clone()
          .webp({ quality, effort: 3 })
          .toBuffer();
      }
      if (output.length > maxBytes)
        throw new Error("Could not prepare a bounded HEIF image");
      parentPort!.postMessage({ output });
    } catch (error) {
      parentPort!.postMessage({
        error:
          error instanceof Error
            ? error.message
            : "Could not decode HEIF image",
      });
    } finally {
      for (const image of images) image.free();
      if (decoder?.decoder) heif.heif_context_free(decoder.decoder);
    }
  },
);
