/**
 * Agent Telemetry — Filter Utility
 *
 * Provides per-agent event/metric/trace filtering based on the YAML config.
 * Used by parsers to decide whether to persist a given signal.
 */

import type { AgentConfig } from '../config.js';

/**
 * Check if an event/metric/trace should be collected based on the agent's filter config.
 * Returns true if it should be collected, false if it should be dropped.
 */
export function shouldCollect(
  name: string, // event_name or metric_name
  agentKey: string, // "claude_code", "codex", "opencode", or "unknown"
  signalType: 'log_events' | 'metrics' | 'traces',
  agentsConfig: Record<string, AgentConfig>,
): boolean {
  const agentCfg = agentsConfig[agentKey];
  if (!agentCfg) return true; // no config for this agent = collect all

  const filter = agentCfg[signalType];
  if (!filter) return true; // no filter for this signal = collect all

  switch (filter.mode) {
    case 'all':
      return true;
    case 'allow':
      return filter.list.includes(name);
    case 'deny':
      return !filter.list.includes(name);
    default:
      return true;
  }
}

/**
 * Infer the agent key from an event_name or metric_name prefix.
 * e.g. "claude_code.tool_result" → "claude_code"
 */
export function inferAgentKey(name: string): string {
  if (name.startsWith('claude_code.')) return 'claude_code';
  if (name.startsWith('codex.')) return 'codex';
  if (name.startsWith('opencode.')) return 'opencode';
  return 'unknown';
}
