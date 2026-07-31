import { describe, expect, it } from "vitest";
import { JsonRpcConnection, RpcError } from "./connection";
import type { DuplexLike, JsonRpcConnectionOptions } from "./connection";

/** In-memory transport: collect data callbacks, record everything written. */
function setup(options?: JsonRpcConnectionOptions) {
  const dataCbs = new Set<(chunk: Uint8Array | string) => void>();
  let out = "";
  const transport: DuplexLike = {
    onData(cb) {
      dataCbs.add(cb);
    },
    write(data) {
      out += data;
    },
    close() {
      dataCbs.clear();
    },
  };
  const conn = new JsonRpcConnection(transport, options);
  const emit = (s: string): void => {
    for (const cb of dataCbs) cb(s);
  };
  const written = (): string => out;
  return { conn, emit, written };
}

/** Parse the newline-delimited output back into message objects. */
function sentMessages(written: string): Record<string, unknown>[] {
  return written
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("JsonRpcConnection - requests", () => {
  it("resolves a request with the server's result", async () => {
    const { conn, emit } = setup();
    const p = conn.request<string>("ping");
    emit('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');
    await expect(p).resolves.toBe("pong");
  });

  it("rejects with an RpcError carrying code/message/data", async () => {
    const { conn, emit } = setup();
    const p = conn.request("boom");
    emit('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope","data":{"k":1}}}\n');
    await expect(p).rejects.toMatchObject({
      name: "RpcError",
      code: -32000,
      message: "nope",
      data: { k: 1 },
    });
    expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it("correlates by id and ignores responses for unknown ids", async () => {
    const { conn, emit } = setup();
    const p = conn.request<string>("ping"); // id 1
    // A stray response for a different id is ignored.
    emit('{"jsonrpc":"2.0","id":999,"result":"stale"}\n');
    emit('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');
    await expect(p).resolves.toBe("pong");
  });
});

describe("JsonRpcConnection - notifications", () => {
  it("writes an outbound notification with no id", () => {
    const { conn, written } = setup();
    conn.notify("notifications/initialized", {});
    expect(sentMessages(written())).toEqual([
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    ]);
  });

  it("dispatches inbound notifications to the registered handler", () => {
    const { conn, emit } = setup();
    const calls: unknown[] = [];
    conn.onNotification("notifications/progress", (p) => {
      calls.push(p);
    });
    emit('{"jsonrpc":"2.0","method":"notifications/progress","params":{"p":50}}\n');
    expect(calls).toEqual([{ p: 50 }]);
  });

  it("ignores inbound notifications with no registered handler", () => {
    const { emit } = setup();
    expect(() =>
      emit('{"jsonrpc":"2.0","method":"notifications/whatever","params":{}}\n'),
    ).not.toThrow();
  });
});

describe("JsonRpcConnection - reverse requests", () => {
  it("responds method-not-found when no handler is registered", async () => {
    const { emit, written } = setup();
    emit('{"jsonrpc":"2.0","id":7,"method":"sampling/createMessage","params":{}}\n');
    await tick();
    expect(sentMessages(written())).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601, message: "method not found: sampling/createMessage" },
      },
    ]);
  });

  it("responds with the handler's result", async () => {
    const { conn, emit, written } = setup();
    conn.onRequest(async (req) => ({ echo: req.params }));
    emit('{"jsonrpc":"2.0","id":5,"method":"ping","params":{"x":1}}\n');
    await tick();
    expect(sentMessages(written())).toEqual([
      { jsonrpc: "2.0", id: 5, result: { echo: { x: 1 } } },
    ]);
  });

  it("responds with an internal-error when the handler throws", async () => {
    const { conn, emit, written } = setup();
    conn.onRequest(() => {
      throw new Error("boom");
    });
    emit('{"jsonrpc":"2.0","id":3,"method":"ping","params":null}\n');
    await tick();
    expect(sentMessages(written())).toEqual([
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "boom" } },
    ]);
  });
});

describe("JsonRpcConnection - abort & timeout", () => {
  it("rejects with 'aborted' and sends notifications/cancelled on abort", async () => {
    const { conn, written } = setup();
    const controller = new AbortController();
    const p = conn.request("long", undefined, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(sentMessages(written())).toEqual([
      { jsonrpc: "2.0", id: 1, method: "long" },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1, reason: "Cancelled by client" },
      },
    ]);
  });

  it("rejects an already-aborted signal immediately", async () => {
    const { conn } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(conn.request("x", undefined, { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });

  it("rejects a request that exceeds its timeout", async () => {
    const { conn } = setup({ defaultTimeout: 20 });
    await expect(conn.request("slow")).rejects.toThrow(/timed out/);
  });

  it("honors a per-request timeout override", async () => {
    const { conn } = setup({ defaultTimeout: 10000 });
    await expect(conn.request("slow", undefined, { timeout: 20 })).rejects.toThrow(/timed out/);
  });
});

describe("JsonRpcConnection - framing robustness", () => {
  it("reassembles a response split across chunks", async () => {
    const { conn, emit } = setup();
    const p = conn.request<string>("ping");
    const full = '{"jsonrpc":"2.0","id":1,"result":"pong"}\n';
    emit(full.slice(0, 10));
    emit(full.slice(10));
    await expect(p).resolves.toBe("pong");
  });

  it("ignores a malformed line without throwing", () => {
    const { conn, emit } = setup();
    expect(() => emit("not json\n")).not.toThrow();
    const calls: unknown[] = [];
    conn.onNotification("n", (p) => {
      calls.push(p);
    });
    emit('{"jsonrpc":"2.0","method":"n","params":{"ok":true}}\n');
    expect(calls).toEqual([{ ok: true }]);
  });

  it("ignores messages that are not jsonrpc 2.0", async () => {
    const { conn, emit } = setup();
    const p = conn.request<string>("ping");
    emit('{"id":1,"result":"bad"}\n'); // missing jsonrpc
    emit('{"jsonrpc":"2.0","id":1,"result":"good"}\n');
    await expect(p).resolves.toBe("good");
  });
});

describe("JsonRpcConnection - lifecycle", () => {
  it("rejects pending requests when the connection closes", async () => {
    const { conn } = setup();
    const p = conn.request("pending");
    conn.close();
    await expect(p).rejects.toThrow("connection closed");
  });

  it("rejects new requests made after close", async () => {
    const { conn } = setup();
    conn.close();
    await expect(conn.request("late")).rejects.toThrow("connection closed");
  });

  it("does not write after close", () => {
    const { conn, written } = setup();
    conn.close();
    conn.notify("x", {});
    expect(written()).toBe("");
  });

  it("close is idempotent", () => {
    const { conn } = setup();
    expect(() => {
      conn.close();
      conn.close();
    }).not.toThrow();
  });

  it("reports isClosed", () => {
    const { conn } = setup();
    expect(conn.isClosed).toBe(false);
    conn.close();
    expect(conn.isClosed).toBe(true);
  });
});
