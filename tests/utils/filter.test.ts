import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../../src/config.js";
import { inferAgentKey, shouldCollect } from "../../src/utils/filter.js";

describe("inferAgentKey", () => {
	test("claude_code prefix → claude_code", () => {
		expect(inferAgentKey("claude_code.tool_result")).toBe("claude_code");
	});

	test("codex prefix → codex", () => {
		expect(inferAgentKey("codex.api_request")).toBe("codex");
	});

	test("opencode prefix → opencode", () => {
		expect(inferAgentKey("opencode.token_usage")).toBe("opencode");
	});

	test("unknown prefix → unknown", () => {
		expect(inferAgentKey("unknown.event")).toBe("unknown");
	});
});

describe("shouldCollect", () => {
	test("no agent config → true (collect all)", () => {
		expect(
			shouldCollect("claude_code.tool_result", "claude_code", "log_events", {}),
		).toBe(true);
	});

	test("agent config with no signal filter → true", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: { metrics: { mode: "all", list: [] } },
		};
		expect(
			shouldCollect(
				"claude_code.tool_result",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
	});

	test("allow mode: event in list → true", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: {
				log_events: {
					mode: "allow",
					list: ["claude_code.tool_result", "claude_code.api_request"],
				},
			},
		};
		expect(
			shouldCollect(
				"claude_code.tool_result",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
	});

	test("allow mode: event not in list → false", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: {
				log_events: { mode: "allow", list: ["claude_code.tool_result"] },
			},
		};
		expect(
			shouldCollect(
				"claude_code.api_request",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(false);
	});

	test("deny mode: event in list → false", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: {
				log_events: { mode: "deny", list: ["claude_code.tool_result"] },
			},
		};
		expect(
			shouldCollect(
				"claude_code.tool_result",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(false);
	});

	test("deny mode: event not in list → true", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: {
				log_events: { mode: "deny", list: ["claude_code.tool_result"] },
			},
		};
		expect(
			shouldCollect(
				"claude_code.api_request",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
	});

	test("all mode → always true", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: { log_events: { mode: "all", list: [] } },
		};
		expect(
			shouldCollect(
				"claude_code.tool_result",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
		expect(
			shouldCollect(
				"claude_code.api_request",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
		expect(
			shouldCollect(
				"claude_code.unknown_event",
				"claude_code",
				"log_events",
				agentsConfig,
			),
		).toBe(true);
	});

	test("works for metrics signal type", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			claude_code: {
				metrics: { mode: "allow", list: ["claude_code.tokens_used"] },
			},
		};
		expect(
			shouldCollect(
				"claude_code.tokens_used",
				"claude_code",
				"metrics",
				agentsConfig,
			),
		).toBe(true);
		expect(
			shouldCollect(
				"claude_code.other_metric",
				"claude_code",
				"metrics",
				agentsConfig,
			),
		).toBe(false);
	});

	test("works for traces signal type", () => {
		const agentsConfig: Record<string, AgentConfig> = {
			codex: { traces: { mode: "deny", list: ["codex.internal_trace"] } },
		};
		expect(
			shouldCollect("codex.internal_trace", "codex", "traces", agentsConfig),
		).toBe(false);
		expect(
			shouldCollect("codex.other_trace", "codex", "traces", agentsConfig),
		).toBe(true);
	});
});
