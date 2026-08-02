import type { Request, Response } from "express";

export function startSseStream(
    req: Request,
    res: Response,
    options: { heartbeatMs?: number } = {},
) {
    const heartbeatMs = options.heartbeatMs ?? 15000;
    let closed = false;

    // Disable all socket-level timeouts so long-running tool calls (e.g.
    // TrustFoundry agentic search) don't get killed mid-stream.
    req.setTimeout(0);
    res.setTimeout(0);
    if (req.socket) {
        req.socket.setTimeout(0);
        req.socket.setNoDelay(true);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    // NOTE: `Connection` is a hop-by-hop header that only applies to HTTP/1.x.
    // Under HTTP/2 it is forbidden — Node's http2 layer throws
    // ERR_HTTP2_INVALID_CONNECTION_HEADERS if a handler sets it. This app is
    // served over HTTP/1.1 (Express `http`), so it's correct here; if this were
    // ever fronted by a *direct* HTTP/2 origin (not a terminating proxy), drop
    // this line.
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => {
        // F4 hardening: also bail if the response is destroyed. A write to a
        // destroyed ServerResponse surfaces the failure ASYNCHRONOUSLY as an
        // ERR_STREAM_DESTROYED rejection. The backend installs no
        // `process.on("unhandledRejection")` handler, so that rejection would
        // crash the whole process. `writableEnded` only catches a clean
        // res.end(); `destroyed` catches an abruptly torn-down socket (client
        // reset, proxy drop) where the heartbeat interval could still fire once
        // before `req`'s "close" event lands.
        if (closed || res.writableEnded || res.destroyed) return;
        res.write(line);
    };

    const heartbeat = setInterval(() => {
        write(": keepalive\n\n");
    }, heartbeatMs);

    const abort = new AbortController();

    const stop = () => {
        closed = true;
        clearInterval(heartbeat);
        // F5: only abort when the response has NOT finished. This preserves the
        // precise "signal aborted === the client went away" contract that
        // downstream LLM calls rely on. On the client-disconnect path (req
        // "close" fires mid-stream) the response is still open, so we abort and
        // stop burning tokens. On the normal-completion path the handler calls
        // res.end() *before* close(), so `writableEnded` is true and we must
        // NOT abort — otherwise a successful stream would look like a cancel.
        if (!res.writableEnded && !abort.signal.aborted) abort.abort();
    };

    req.on("close", stop);

    return {
        write,
        signal: abort.signal,
        close: () => {
            stop();
            req.off("close", stop);
        },
    };
}
