/**
 * Config command — opens the config.yml file in $EDITOR.
 *
 * If the config file doesn't exist in the data directory, copies the template
 * from the project root first.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigFile } from "../utils/otlp-inject.js";
import { getServicePaths } from "../utils/platform.js";

// ANSI color codes
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	dim: "\x1b[2m",
};

export async function configCommand(): Promise<void> {
	const paths = getServicePaths();
	const configPath = join(paths.dataDir, "config.yml");

	// Ensure config file exists
	if (!existsSync(configPath)) {
		const sourceConfig = join(process.cwd(), "config.yml");
		ensureConfigFile(sourceConfig);
	}

	if (!existsSync(configPath)) {
		console.log(
			`${C.yellow}⚠${C.reset} Could not find or create config file at ${configPath}`,
		);
		console.log(
			`${C.dim}  You can create it manually with your preferred settings.${C.reset}`,
		);
		return;
	}

	const editor = process.env.EDITOR ?? process.env.VISUAL ?? null;

	if (!editor) {
		console.log(`${C.bold}Config file:${C.reset} ${configPath}`);
		console.log();
		console.log(`${C.yellow}No $EDITOR set.${C.reset} Open the file manually:`);
		console.log(`  ${C.dim}code ${configPath}${C.reset}`);
		console.log(`  ${C.dim}vim ${configPath}${C.reset}`);
		console.log(`  ${C.dim}nano ${configPath}${C.reset}`);
		console.log();
		console.log(`${C.dim}Or set $EDITOR and run again:${C.reset}`);
		console.log(`  ${C.dim}EDITOR=vim agent-telemetry config${C.reset}`);
		return;
	}

	console.log(`${C.dim}Opening ${configPath} with ${editor}…${C.reset}`);

	const result = Bun.spawnSync({
		cmd: editor.split(/\s+/).concat(configPath),
		stdout: "inherit",
		stderr: "inherit",
	});

	if (result.exitCode !== 0) {
		console.log(
			`${C.yellow}⚠${C.reset} Editor exited with code ${result.exitCode}`,
		);
	}

	console.log();
	console.log(`${C.green}✓${C.reset} Config file: ${configPath}`);
	console.log(
		`${C.dim}  Restart the service for changes to take effect:${C.reset}`,
	);
	console.log(
		`  ${C.bold}agent-telemetry restart${C.reset} ${C.dim}(or reinstall)${C.reset}`,
	);
	console.log();
}
