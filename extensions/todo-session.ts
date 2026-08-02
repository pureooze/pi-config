import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SESSION_ID_PATTERN = /^\s*-\s*Session ID:\s*`([^`]+)`\s*$/;
const SESSION_FILE_PATTERN = /^\s*-\s*Session file:\s*`([^`]+)`\s*$/;
const RESUME_COMMAND_PATTERN = /^\s*-\s*Resume(?: from this project)? with:\s*`[^`]+`\s*$/;

function findTodoFile(cwd: string): string | undefined {
	let directory = resolve(cwd);

	while (true) {
		const todoPath = join(directory, "TODO.md");
		if (existsSync(todoPath)) return todoPath;

		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function updateSessionMetadata(todoPath: string, sessionId: string, sessionFile: string): void {
	const original = readFileSync(todoPath, "utf8");
	let lines = original.split("\n");
	const sessionIdIndex = lines.findIndex((line) => SESSION_ID_PATTERN.test(line));
	const resumeCommand = `pi --session ${sessionId}`;
	const metadata = [
		`- Session file: \`${sessionFile}\``,
		`- Resume from this project with: \`${resumeCommand}\``,
	];

	if (sessionIdIndex >= 0) {
		lines[sessionIdIndex] = `- Session ID: \`${sessionId}\``;
		lines = lines.filter(
			(line, index) =>
				index === sessionIdIndex ||
				(!SESSION_FILE_PATTERN.test(line) && !RESUME_COMMAND_PATTERN.test(line)),
		);
		const updatedSessionIdIndex = lines.findIndex((line) => SESSION_ID_PATTERN.test(line));
		lines.splice(updatedSessionIdIndex + 1, 0, ...metadata);
	} else {
		const suffix = [
			"",
			"## Pi session",
			"",
			`- Session ID: \`${sessionId}\``,
			...metadata,
			"",
		].join("\n");
		lines.push(suffix);
	}

	const updated = lines.join("\n");
	if (updated !== original) writeFileSync(todoPath, updated, "utf8");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const todoPath = findTodoFile(ctx.cwd);
		if (!todoPath) return;

		try {
			updateSessionMetadata(todoPath, ctx.sessionManager.getSessionId(), sessionFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[todo-session] Could not update ${parse(todoPath).base}: ${message}`);
		}
	});
}
