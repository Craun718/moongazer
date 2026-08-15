/**
 * MCP revisions supported by this package.
 *
 * The 2025 revisions are legacy revisions: they begin with an `initialize`
 * handshake and may use `Mcp-Session-Id`. The 2026 revision is modern:
 * protocol identity travels with every request and there is no protocol-level
 * session.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25", "2026-07-28"] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** Kept as an alias for callers written against the original 0.1 API. */
export const MCP_PROTOCOL_VERSION = "2025-06-18" satisfies McpProtocolVersion;

/** Modern MCP replaced initialize-time state with per-request metadata. */
export function isModernProtocolVersion(version: McpProtocolVersion): boolean {
  return version === "2026-07-28";
}

export function isSupportedProtocolVersion(version: unknown): version is McpProtocolVersion {
  return (
    typeof version === "string" && MCP_PROTOCOL_VERSIONS.includes(version as McpProtocolVersion)
  );
}
