import { describe, expect, it, vi } from "vitest";
import { createMcpClient, MCP_PROTOCOL_VERSION } from "./client";

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createMcpClient", () => {
  it("uses browser fetch and retains the server session", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "weather" } },
          },
          { "MCP-Session-Id": "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              {
                name: "forecast",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "sunny" }] },
        }),
      );

    const source = await createMcpClient({ url: "https://mcp.example.com/mcp", fetch });
    const tools = await source.list({ signal: new AbortController().signal });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("weather:forecast");
    await expect(tools[0]!.execute({}, { signal: new AbortController().signal })).resolves.toBe("sunny");

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(4);
    expect(new Headers(calls[2]?.[1]?.headers).get("MCP-Session-Id")).toBe("session-1");
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toMatchObject({ method: "tools/call" });
  });
});
