import { EndpointServiceError } from "@hypit/hypit/endpoint";
import { EndpointHttpError, retryAfterMs } from "@hypit/hypit/endpoint/http";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Responses may mention a signed asset URL. Keep the reason, not its access capability.
export function safeReason(value: string): string {
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export class ToonflowServiceError extends EndpointServiceError {}

export class ToonflowHttpError extends EndpointHttpError {
  constructor(status: number, response: { readonly headers: Headers }, bodyText: string,
    request: { readonly method: string; readonly path: string; readonly model?: string }) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON gateway failures still have HTTP evidence. */ }
    const error = record(body?.error);
    const code = text(error?.code) ?? text(error?.type) ?? text(body?.code) ?? "GENERATION_HTTP_ERROR";
    const reason = text(error?.message) ?? text(body?.message)
      ?? (body === undefined ? text(bodyText.slice(0, 2000)) : undefined);
    const requestId = text(response.headers.get("x-request-id"));
    const facts = [
      `HTTP ${status}`, code, `${request.method} ${request.path}`,
      ...(request.model === undefined ? [] : [`model=${request.model}`]),
      ...(requestId === undefined ? [] : [`request=${requestId}`]),
    ];
    super(code, `${facts.join("; ")}${reason === undefined ? "" : `: ${safeReason(reason)}`}`,
      status, retryAfterMs(response.headers));
  }
}

/** A terminal Ark task body; `undefined` when the task did not fail. */
export function taskFailure(task: Record<string, unknown>, id: string): ToonflowServiceError | undefined {
  const status = String(task.status);
  if (!["failed", "cancelled", "canceled", "expired"].includes(status)) return undefined;
  const error = record(task.error);
  const code = text(error?.code) ?? "GENERATION_TASK_FAILED";
  const reason = text(error?.message) ?? text(task.error);
  return new ToonflowServiceError(code,
    `Generation task ${id} ${status}; ${code}${reason === undefined ? "" : `: ${safeReason(reason)}`}`);
}
