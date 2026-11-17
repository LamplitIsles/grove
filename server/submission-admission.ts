import { createHash } from "node:crypto";
import type { Answer, MessageImage } from "../src/contracts";

export type SubmissionEnvelope =
  | { source: "user"; text: string; images?: MessageImage[] }
  | { source: "question"; answers: Answer[] };

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const submissionOwner = (userId?: string) =>
  digest(JSON.stringify(["grove-human-v1", userId ?? null]));
export const retryTokenHash = (token: string) => digest(token);

export function envelopeHash(envelope: SubmissionEnvelope) {
  const normalized =
    envelope.source === "user"
      ? [
          "user",
          envelope.text.trim(),
          (envelope.images ?? []).map((image) => [
            image.id,
            image.name,
            image.width,
            image.height,
            image.bytes,
            image.mediaType,
            image.availability ?? null,
          ]),
        ]
      : [
          "question",
          envelope.answers.map((answer) => [
            answer.questionId,
            answer.answer.trim(),
          ]),
        ];
  return digest(JSON.stringify(["grove-envelope-v1", normalized]));
}

export type Fence = {
  state: "reserved" | "claimed" | "rejected" | "superseded";
  owner: string;
  hash?: string;
  retryOf?: string;
  successor?: string;
  tokenHash?: string;
};
export function encodeFence(fence: Fence): string {
  let value: string;
  if (fence.state === "superseded")
    value = `v2:superseded:${fence.owner}:${fence.hash}:${fence.successor}${fence.retryOf === undefined ? "" : `:${Buffer.from(fence.retryOf).toString("base64url")}`}`;
  else if (fence.retryOf !== undefined)
    value = `v2:retry-${fence.state}:${fence.owner}${fence.hash ? `:${fence.hash}` : ""}:${fence.tokenHash}:${Buffer.from(fence.retryOf).toString("base64url")}`;
  else
    value = `v1:${fence.state}:${fence.owner}${fence.hash ? `:${fence.hash}` : ""}`;
  parseFence(value);
  return value;
}
export function parseFence(value: string): Fence {
  const match =
    /^v1:(reserved|claimed|rejected):([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(
      value,
    );
  if (match && (match[1] === "reserved") === (match[3] === undefined))
    return {
      state: match[1] as Fence["state"],
      owner: match[2],
      hash: match[3],
    };
  const replaced =
    /^v2:superseded:([a-f0-9]{64}):([a-f0-9]{64}):(grove-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?::([A-Za-z0-9_-]+))?$/.exec(
      value,
    );
  if (replaced) {
    const retryOf = replaced[4] && decodeRetryOf(replaced[4]);
    if (replaced[4] && !retryOf)
      throw new Error("Invalid submission reservation");
    return {
      state: "superseded",
      owner: replaced[1],
      hash: replaced[2],
      successor: replaced[3],
      retryOf,
    };
  }
  const retry =
    /^v2:retry-(reserved|claimed|rejected):([a-f0-9]{64})(?::([a-f0-9]{64}))?:([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(
      value,
    );
  if (retry && (retry[1] === "reserved") === (retry[3] === undefined)) {
    const retryOf = decodeRetryOf(retry[5]);
    if (retryOf)
      return {
        state: retry[1] as "reserved" | "claimed" | "rejected",
        owner: retry[2],
        hash: retry[3],
        tokenHash: retry[4],
        retryOf,
      };
  }
  throw new Error("Invalid submission reservation");
}

function decodeRetryOf(encoded: string) {
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  return id.length > 0 &&
    id.length <= 120 &&
    Buffer.from(id).toString("base64url") === encoded
    ? id
    : undefined;
}
