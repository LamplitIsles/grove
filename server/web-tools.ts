import { z } from "zod";
import { toolDefinitions } from "./tools";
import { readContext7Key } from "./web-config";
import { docsFetch, docsResolve } from "./vendor/guion-web/docs";
import {
  fetchWebLinks,
  fetchWebPage,
  FetchCapabilityError,
} from "./vendor/guion-web/fetch";

type WebToolName =
  | "web_fetch_structured"
  | "web_links"
  | "web_docs_resolve"
  | "web_docs_fetch";
export async function callWebTool(
  name: WebToolName,
  args: unknown,
  configPath?: string,
): Promise<unknown> {
  if (name === "web_fetch_structured") {
    const input = z
      .object(toolDefinitions.web_fetch_structured.shape)
      .strict()
      .parse(args);
    try {
      return await fetchWebPage(input);
    } catch (error) {
      throw webError(error);
    }
  }
  if (name === "web_links") {
    const input = z
      .object(toolDefinitions.web_links.shape)
      .strict()
      .parse(args);
    try {
      return await fetchWebLinks(input);
    } catch (error) {
      throw webError(error);
    }
  }
  const key = readContext7Key(configPath);
  try {
    const credentials = { context7ApiKey: key };
    const result =
      name === "web_docs_resolve"
        ? await docsResolve({
            ...z
              .object(toolDefinitions.web_docs_resolve.shape)
              .strict()
              .parse(args),
            credentials,
          })
        : await docsFetch({
            ...z
              .object(toolDefinitions.web_docs_fetch.shape)
              .strict()
              .parse(args),
            credentials,
          });
    return key ? redactResult(result, key) : result;
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    const message =
      error instanceof Error
        ? context7Advice(error.message)
        : "Context7 request failed";
    throw new Error(key ? message.replaceAll(key, "[redacted]") : message);
  }
}
function context7Advice(message: string): string {
  if (
    message ===
    "context7 docs: not found (HTTP 404). Run 'web docs resolve <name>' to find the correct library ID"
  )
    return "context7 docs: not found (HTTP 404). Use web_docs_resolve to find the correct library ID";
  for (const operation of ["resolve", "docs"]) {
    if (
      message ===
      `context7 ${operation}: invalid CONTEXT7_API_KEY (HTTP 401) — keys start with 'ctx7sk'`
    )
      return `context7 ${operation}: invalid Context7 key (HTTP 401) — keys start with 'ctx7sk'; replace or delete it in Settings → Web`;
    if (
      message ===
      `context7 ${operation}: rate limited (HTTP 429) — set CONTEXT7_API_KEY for higher limits`
    )
      return `context7 ${operation}: rate limited (HTTP 429) — configure a Context7 key in Settings → Web for higher limits`;
  }
  return message;
}
function webError(error: unknown): Error {
  if (error instanceof FetchCapabilityError)
    return new Error(
      JSON.stringify({
        code: error.code,
        ...(error.code === "render_unavailable"
          ? {
              message:
                "agent-browser is unavailable; install it separately to use browser rendering",
            }
          : {}),
        ...error.details,
      }),
    );
  return error instanceof Error ? error : new Error("Web request failed");
}

function redactResult(value: unknown, key: string): unknown {
  if (typeof value === "string") return value.replaceAll(key, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactResult(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name.replaceAll(key, "[redacted]"),
        redactResult(item, key),
      ]),
    );
  return value;
}
