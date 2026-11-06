// An answer's body read to at most a bound (the eleventh review round, 2026-11-04, C11-11): the relayers' and the endpoints' answers had been read
// whole — only the snapshot had a bound — so one hostile relayer or endpoint streaming without end exhausted the tab. A declared length past the
// bound is not read at all; a stream past it is cancelled there.
export class AnswerTooLarge extends Error {
  constructor(readonly max: number) {
    super(`the answer is too large (more than ${max} bytes): not read`);
    this.name = "AnswerTooLarge";
  }
}

export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new AnswerTooLarge(max);
  }
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (text.length > max) throw new AnswerTooLarge(max);
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AnswerTooLarge(max);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
