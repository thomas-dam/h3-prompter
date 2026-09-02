import { randomUUID } from "node:crypto";

// One expensive operation at a time across all three pages and legacy routes.
export const JOB = { phase: "idle", active_request_id: null, controller: null };

export async function streamJob(req, res, work) {
  if (JOB.active_request_id) return res.status(409).json({ error: { code: "GENERATION_BUSY", message: "Another operation is running. Cancel it or wait for it to finish." } });
  JOB.active_request_id = randomUUID();
  JOB.controller = new AbortController();
  const signal = JOB.controller.signal;
  const disconnected = () => { if (!res.writableEnded) JOB.controller?.abort(); };
  res.on("close", disconnected);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const progress = (phase, detail) => { JOB.phase = phase; send({ type: "phase", phase, detail }); };
  try {
    const result = await work({ signal, progress, onDelta: (content) => send({ type: "delta", content }) });
    signal.throwIfAborted();
    send({ type: "complete", result });
  } catch (error) {
    send(signal.aborted ? { type: "cancelled" } : { type: "error", error: { code: error.code || "OPERATION_FAILED", message: error.message } });
  } finally {
    res.off("close", disconnected);
    JOB.active_request_id = null; JOB.controller = null; JOB.phase = "idle";
    res.end();
  }
}
