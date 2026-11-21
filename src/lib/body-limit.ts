/** Error raised when an inbound body exceeds its byte limit. */
export class BodyLimitError extends Error {
  readonly status: number;

  constructor(message: string, status = 413) {
    super(message);
    this.name = "BodyLimitError";
    this.status = status;
  }
}

type BodySource = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Read a request body incrementally with a byte cap. Oversized bodies are rejected
 * as soon as the cap is crossed and the stream is cancelled, so a large payload is
 * never buffered in full. The returned string is the exact UTF-8 decoding of the
 * received bytes, which signed webhooks need for raw-body HMAC verification.
 */
export async function readBoundedText(
  source: BodySource,
  maxBytes: number,
  tooLargeMessage = "Request body is too large.",
): Promise<string> {
  const declared = Number(source.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyLimitError(tooLargeMessage);

  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyLimitError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* The stream may already be cancelled. */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
