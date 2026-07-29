/**
 * Shared OTLP type definitions used across parsers and route handlers.
 */

export type OtlpAttribute = {
  key?: string;
  value?: {
    stringValue?: string;
    intValue?: number;
  };
};

/**
 * Normalize Codex resource attributes so the service/engine identity matches
 * Claude Code convention:
 *   - Original service.name (codex_cli_rs, codex-app-server, etc.) → engine.name (normalized to "codex")
 *   - Original service.version → engine.version
 *   - service.name = "agent-telemetry"
 *
 * Only fires when service.name contains "codex" (Codex SDK default). Claude Code
 * resource attrs already carry correct service.name and engine.*, so they pass through unchanged.
 * Mutates the array in place. Returns the same array for convenience.
 */
export function normalizeCodexResourceAttrs(attributes: OtlpAttribute[]): OtlpAttribute[] {
  const serviceName = attributes.find((a) => a.key === 'service.name')?.value?.stringValue;
  if (!serviceName?.includes('codex')) return attributes;

  const getStringAttr = (key: string): string | undefined =>
    attributes.find((a) => a.key === key)?.value?.stringValue;

  const upsertStringAttribute = (key: string, value: string): void => {
    const existing = attributes.find((a) => a.key === key);
    if (existing) {
      existing.value = { stringValue: value };
      return;
    }
    attributes.push({ key, value: { stringValue: value } });
  };

  // Move original service.* to engine.*
  const serviceVersion = getStringAttr('service.version');
  upsertStringAttribute('engine.name', 'codex');
  if (serviceVersion) {
    upsertStringAttribute('engine.version', serviceVersion);
  }

  // Override service.* with agent-telemetry identity
  upsertStringAttribute('service.name', 'agent-telemetry');
  // service.version is left as-is (no build-time version constant in standalone project)

  return attributes;
}
