# @moongazer/mcp

Browser-native MCP tool source for moongazer agent loops. The client supports
Streamable HTTP revisions `2025-06-18`, `2025-11-25`, and `2026-07-28`.

```ts
import { createMcpClient } from "@moongazer/mcp";

const mcp = await createMcpClient({
  url: "https://mcp.example.com/mcp",
  protocolVersion: "2026-07-28",
});
```

The default remains `2025-06-18` for compatibility with the original package.
The two 2025 revisions use the legacy `initialize` handshake and preserve an
optional `Mcp-Session-Id`. `2025-11-25` also resumes an interrupted
request-scoped SSE stream with `Last-Event-ID`. The 2026 revision is stateless:
protocol identity is sent in request `_meta` and mirrored HTTP headers, and no
session is created.

Pass the returned source to a moongazer agent:

```ts
const agent = createAgent({
  transport,
  toolSources: [mcp],
});
```

Only MCP tools are bridged. Resources, prompts, sampling, elicitation, and
modern `input_required` results are outside this package's scope. Tool listing
is refreshed at run boundaries; this package does not maintain a long-lived
subscription stream.
