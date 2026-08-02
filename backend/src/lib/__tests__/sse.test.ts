import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { startSseStream } from "../sse";

/**
 * These tests exercise `startSseStream` against a minimal EventEmitter-based
 * mock of Express `req`/`res`. `startSseStream` only touches a small, well
 * defined slice of the Node HTTP surface (timeouts, a couple of headers,
 * `write`, `writableEnded`/`destroyed`, and the `req` "close" event), so a hand
 * rolled double keeps the tests deterministic and fast under fake timers.
 */

interface MockRes {
    res: Response;
    writes: string[];
    setWritableEnded: (v: boolean) => void;
    setDestroyed: (v: boolean) => void;
}

function makeReq(): Request & EventEmitter {
    const req = new EventEmitter() as EventEmitter & Partial<Request>;
    req.setTimeout = vi.fn().mockReturnThis() as unknown as Request["setTimeout"];
    // A socket with the two methods startSseStream calls on it.
    (req as unknown as { socket: unknown }).socket = {
        setTimeout: vi.fn(),
        setNoDelay: vi.fn(),
    };
    return req as unknown as Request & EventEmitter;
}

function makeRes(): MockRes {
    const writes: string[] = [];
    let writableEnded = false;
    let destroyed = false;

    const res = {
        setTimeout: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn((line: string) => {
            writes.push(line);
            return true;
        }),
        get writableEnded() {
            return writableEnded;
        },
        get destroyed() {
            return destroyed;
        },
    } as unknown as Response;

    return {
        res,
        writes,
        setWritableEnded: (v: boolean) => {
            writableEnded = v;
        },
        setDestroyed: (v: boolean) => {
            destroyed = v;
        },
    };
}

describe("startSseStream", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("emits a heartbeat comment at the configured interval", () => {
        const req = makeReq();
        const { res, writes } = makeRes();

        startSseStream(req, res, { heartbeatMs: 1000 });

        expect(writes).toHaveLength(0);

        vi.advanceTimersByTime(1000);
        expect(writes).toEqual([": keepalive\n\n"]);

        vi.advanceTimersByTime(2000);
        expect(writes).toEqual([
            ": keepalive\n\n",
            ": keepalive\n\n",
            ": keepalive\n\n",
        ]);
    });

    it("clears the interval AND aborts the signal when the client disconnects", () => {
        const req = makeReq();
        const { res, writes } = makeRes();

        const stream = startSseStream(req, res, { heartbeatMs: 1000 });
        expect(stream.signal.aborted).toBe(false);

        // Client goes away mid-stream: the response has NOT finished, so the
        // abort signal must fire (that is the "client went away" contract).
        req.emit("close");
        expect(stream.signal.aborted).toBe(true);

        // Interval is cleared: no further heartbeats regardless of elapsed time.
        vi.advanceTimersByTime(10_000);
        expect(writes).toHaveLength(0);
    });

    it("does NOT abort the signal on a clean completion (close after res.end)", () => {
        const req = makeReq();
        const mock = makeRes();

        const stream = startSseStream(req, mock.res, { heartbeatMs: 1000 });

        // Normal path: handler finishes writing, res.end() runs (writableEnded),
        // THEN close() is called. Aborting here would falsely look like a cancel.
        mock.setWritableEnded(true);
        stream.close();

        expect(stream.signal.aborted).toBe(false);
    });

    it("close() is idempotent and stops further writes", () => {
        const req = makeReq();
        const { res, writes } = makeRes();

        const stream = startSseStream(req, res, { heartbeatMs: 1000 });

        expect(() => {
            stream.close();
            stream.close();
        }).not.toThrow();

        stream.write("data: ignored\n\n");
        vi.advanceTimersByTime(5000);
        expect(writes).toHaveLength(0);
    });

    it("write is a no-op after the response has ended", () => {
        const req = makeReq();
        const mock = makeRes();

        const stream = startSseStream(req, mock.res, { heartbeatMs: 1000 });

        mock.setWritableEnded(true);
        stream.write("data: after-end\n\n");

        expect(mock.res.write).not.toHaveBeenCalled();
        expect(mock.writes).toHaveLength(0);
    });

    it("write is a no-op after the response is destroyed (F4: no ERR_STREAM_DESTROYED)", () => {
        const req = makeReq();
        const mock = makeRes();

        startSseStream(req, mock.res, { heartbeatMs: 1000 });

        // Socket torn down abruptly (client reset / proxy drop) before req
        // "close" lands. A write here would reject asynchronously with
        // ERR_STREAM_DESTROYED and crash the process (no unhandledRejection
        // handler), so the heartbeat that fires next must be a no-op.
        mock.setDestroyed(true);
        vi.advanceTimersByTime(1000);

        expect(mock.res.write).not.toHaveBeenCalled();
        expect(mock.writes).toHaveLength(0);
    });
});
