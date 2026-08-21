import { describe, expect, it, vi } from "vitest";
import { createMcpClient, MCP_PROTOCOL_VERSION } from "./client";

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createMcpClient", () => {
  it("speaks legacy 2025-06-18 MCP and retains the server session", async () => {
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
      )
      .mockResolvedValueOnce(new Response(null, { status: 405 }));

    const source = await createMcpClient({ url: "https://mcp.example.com/mcp", fetch });
    const tools = await source.list({ signal: new AbortController().signal });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("weather:forecast");
    await expect(tools[0]!.execute({}, { signal: new AbortController().signal })).resolves.toBe(
      "sunny",
    );

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(4);
    const initHeaders = new Headers(calls[0]?.[1]?.headers);
    expect(initHeaders.get("MCP-Protocol-Version")).toBeNull();
    expect(new Headers(calls[1]?.[1]?.headers).get("MCP-Protocol-Version")).toBe("2025-06-18");
    expect(new Headers(calls[1]?.[1]?.headers).get("MCP-Session-Id")).toBe("session-1");
    expect(new Headers(calls[2]?.[1]?.headers).get("MCP-Session-Id")).toBe("session-1");
    expect(new Headers(calls[2]?.[1]?.headers).get("MCP-Protocol-Version")).toBe("2025-06-18");
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toMatchObject({ method: "tools/call" });

    source.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(5);
    expect(calls[4]?.[1]?.method).toBe("DELETE");
    expect(new Headers(calls[4]?.[1]?.headers).get("MCP-Session-Id")).toBe("session-1");
  });

  it("supports the final legacy 2025-11-25 revision", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "weather" },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [{ name: "forecast", inputSchema: { type: "object", properties: {} } }],
          },
        }),
      );

    const source = await createMcpClient({
      url: "https://mcp.example.com/mcp",
      protocolVersion: "2025-11-25",
      fetch,
    });
    await expect(source.list({ signal: new AbortController().signal })).resolves.toHaveLength(1);

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(new Headers(calls[1]?.[1]?.headers).get("MCP-Protocol-Version")).toBe("2025-11-25");
    expect(new Headers(calls[2]?.[1]?.headers).get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("follows tools/list pagination cursors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "weather" },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [{ name: "a", inputSchema: { type: "object", properties: {} } }],
            nextCursor: "page-2",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: {
            tools: [{ name: "b", inputSchema: { type: "object", properties: {} } }],
          },
        }),
      );

    const source = await createMcpClient({ url: "https://mcp.example.com/mcp", fetch });
    const tools = await source.list({ signal: new AbortController().signal });

    expect(tools.map((tool) => tool.name)).toEqual(["weather:a", "weather:b"]);
    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(4);
    const firstListBody = JSON.parse(String(calls[2]?.[1]?.body));
    expect(firstListBody.method).toBe("tools/list");
    expect(firstListBody.params).toBeUndefined();
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toMatchObject({
      method: "tools/list",
      params: { cursor: "page-2" },
    });
  });

  it("resumes a disconnected 2025-11-25 SSE request with Last-Event-ID", async () => {
    const finalResponse = {
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "forecast", inputSchema: { type: "object", properties: {} } }] },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-11-25", serverInfo: { name: "weather" } },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(sseResponse("retry: 1\nid: stream-1\n\n"))
      .mockResolvedValueOnce(sseResponse(`data: ${JSON.stringify(finalResponse)}\n\n`));

    const source = await createMcpClient({
      url: "https://mcp.example.com/mcp",
      protocolVersion: "2025-11-25",
      fetch,
    });
    await expect(source.list({ signal: new AbortController().signal })).resolves.toHaveLength(1);

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[3]?.[1]?.method).toBe("GET");
    expect(new Headers(calls[3]?.[1]?.headers).get("Last-Event-ID")).toBe("stream-1");
    expect(new Headers(calls[3]?.[1]?.headers).get("Accept")).toBe("text/event-stream");
  });

  it("speaks stateless 2026 MCP with per-request metadata and mirrored headers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "weather", version: "1.0.0" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            resultType: "complete",
            tools: [
              {
                name: "forecast",
                inputSchema: {
                  type: "object",
                  properties: {
                    region: { type: "string", "x-mcp-header": "Region" },
                    city: { type: "string" },
                  },
                  required: ["region", "city"],
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { resultType: "complete", content: [{ type: "text", text: "sunny" }] },
        }),
      );

    const source = await createMcpClient({
      url: "https://mcp.example.com/mcp",
      protocolVersion: "2026-07-28",
      fetch,
    });
    const tools = await source.list({ signal: new AbortController().signal });
    await expect(
      tools[0]!.execute(
        { region: "us-west", city: "Seattle" },
        {
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("sunny");

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ method: "server/discover" });
    expect(tools[0]?.name).toBe("weather:forecast");

    for (const call of calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
      expect(headers.get("Mcp-Method")).toBe(String(JSON.parse(String(call[1]?.body)).method));
      expect(headers.get("MCP-Session-Id")).toBeNull();
    }

    expect(JSON.parse(String(calls[1]?.[1]?.body)).params._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    const callHeaders = new Headers(calls[2]?.[1]?.headers);
    expect(callHeaders.get("Mcp-Name")).toBe("forecast");
    expect(callHeaders.get("Mcp-Param-Region")).toBe("us-west");
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "forecast",
        arguments: { region: "us-west", city: "Seattle" },
      },
    });
  });
});
