import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";

const RELOAD_PENDING_KEY = Symbol.for("pi-tutorial.onboarding.reload-pending");

const STEP_IDS = ["basics", "profile", "piFoundations", "piPermissions", "idea", "chat", "code", "tests", "extension", "iterate"] as const;
type StepId = (typeof STEP_IDS)[number];

const HINT_IDS = [
	"answer_numbered_questions",
	"ask_to_run_commands",
	"one_vertical_slice",
] as const;
type HintId = (typeof HINT_IDS)[number];

interface StepMeta {
	label: string;
	title: string;
	hint: string;
	prompt: string;
	promptExamples: string[];
}

interface HintMeta {
	title: string;
	whenToUse: string;
	body: string;
}

interface MarkStepDoneDetails {
	step: StepId;
	title: string;
	note?: string;
	alreadyDone: boolean;
	completedSteps: StepId[];
	doneCount: number;
	remainingSteps: StepId[];
	nextStep?: StepId;
	nextPromptExamples: string[];
}

interface ShowHintDetails {
	hint: HintId;
	title: string;
	body: string;
	alreadyShown: boolean;
}

const STEP_TOOL_NAME = "mark_step_done";
const HINT_TOOL_NAME = "show_hint";
const KICKOFF_MESSAGE_TYPE = "onboarding-guide-kickoff";
const EVENT_MESSAGE_TYPE = "onboarding-guide-event";
const ONBOARDING_STARTING_MESSAGE = "Hang on for a bit, I'm preparing a custom tour for you.";

const STEPS: Record<StepId, StepMeta> = {
	basics: {
		label: "Start chatting",
		title: "Learn how to interact (type in the input and press Enter)",
		hint: "The user has sent at least one real message and understands how to chat with Pi.",
		prompt: "Hi Pi — can you explain in one sentence how to chat here?",
		promptExamples: [
			"Hi Pi — can you explain in one sentence how to chat here?",
			"Can you show me the basic way to ask you to help with this project?",
		],
	},
	profile: {
		label: "Share background",
		title: "Answer onboarding questions about language background and tooling familiarity",
		hint: "The user shared: (1) programming familiarity and preferred language (or that they are not a programmer), and (2) familiarity with AI coding tools.",
		prompt:
			"Before project ideas, ask me two short onboarding questions: my programming/language background (or non-programmer) and my familiarity with AI coding tools.",
		promptExamples: [
			"Ask me 2 short onboarding questions first (language background + AI coding tool familiarity).",
			"Before we pick a project, quickly profile my language comfort and prior AI-coding-tool experience.",
		],
	},
	piFoundations: {
		label: "Pi basics",
		title: "Learn what makes Pi different (minimal prompt, 4 built-in tools, extensibility)",
		hint: "The user was explicitly taught that Pi uses a minimal system prompt, has only four built-in tools (read/edit/write/bash), and is extended through extensions and skills.",
		prompt:
			"Before project selection, briefly explain what makes Pi different: minimal system prompt, only read/edit/write/bash built-ins, and how extensions/skills extend capabilities.",
		promptExamples: [
			"Give me a quick explanation of what makes Pi different: prompt model, built-in tools, and extensions/skills.",
			"Explain in 3-5 bullets what makes Pi different from other coding agents.",
		],
	},
	piPermissions: {
		label: "Permissions model",
		title: "Understand Pi's no-sandbox, full-permissions model",
		hint: "The user was told clearly that Pi runs without sandboxing and with full permissions by design, and this was acknowledged before continuing.",
		prompt:
			"Briefly explain Pi's permission model: no sandbox, full permissions by design, and what practical care I should take when asking it to run commands.",
		promptExamples: [
			"Before we code, explain Pi's trust/permission model and how to use it responsibly.",
			"Give me the short version of Pi's no-sandbox model and safety expectations.",
		],
	},
	idea: {
		label: "Pick project",
		title: "Pick a small project (target: ~200-300 LOC) tailored to the user",
		hint: "A concrete small project has been chosen, ideally aligned with the user's background and stated preferences.",
		prompt:
			"Now suggest 3 small projects I can build in ~200-300 lines, tailored to my background. Include short scope + test strategy for each, then recommend one.",
		promptExamples: [
			"Given what you learned about me, suggest 3 tiny tutorial projects and recommend one.",
			"Propose 3 small project options tailored to my language comfort.",
		],
	},
	chat: {
		label: "Plan with Pi",
		title: "Plan the implementation with back-and-forth design",
		hint: "There is a concrete implementation plan covering scope, commands, data model, or edge cases.",
		prompt:
			"Before writing code, let's plan the implementation together. Ask me one concrete question at a time and produce a step-by-step build plan. When I ask you questions that are unclear, you can also ask me to clarify.",
		promptExamples: [
			"Please do a back and forth with me to clarify.",
			"Before coding, please do a back and forth with me to clarify the implementation plan.",
		],
	},
	code: {
		label: "Implement code",
		title: "Implement the project",
		hint: "A meaningful vertical slice of the project has been implemented.",
		prompt:
			"Implement the first complete vertical slice of the project now. Keep code clean and explain key decisions briefly.",
		promptExamples: [
			"Implement the first vertical slice now, but explain key decisions briefly.",
			"Start coding the smallest usable version we agreed on.",
		],
	},
	tests: {
		label: "Run tests",
		title: "Run tests from Pi",
		hint: "Tests or a concrete verification command have been run from Pi and the result was reviewed.",
		prompt: "Run the test suite, explain failures, and fix them until tests pass.",
		promptExamples: [
			"Run the tests and fix anything that fails.",
			"Please verify this works by running the relevant test or check command.",
		],
	},
	extension: {
		label: "Build extension",
		title: "Create your own extension and reload it (/reload)",
		hint: "A small extension command/tool was created or updated in .pi/extensions and Pi reloaded successfully.",
		prompt:
			"Create a tiny custom Pi extension in .pi/extensions/ that adds one useful command for this project, then tell me to run /reload.",
		promptExamples: [
			"Help me create a tiny Pi extension for this project, then remind me to run /reload.",
			"Scaffold a minimal extension in .pi/extensions/ that adds one useful command and walk me through reloading it.",
		],
	},
	iterate: {
		label: "Debug + iterate",
		title: "Exercise the extension, debug behavior, and ship one improvement",
		hint: "The extension was exercised in Pi, behavior was inspected, and at least one improvement was implemented and verified (typically via /reload).",
		prompt:
			"Now let's debug and iterate on the extension: run it, inspect output/logs, make one concrete improvement, reload, and verify the updated behavior.",
		promptExamples: [
			"Let's test the extension command now, debug anything odd, then improve it and reload.",
			"Please drive one debug loop: run extension → inspect output → patch code → /reload → verify.",
		],
	},
};

const HINTS: Record<HintId, HintMeta> = {
	answer_numbered_questions: {
		title: "Answer multiple numbered questions at once",
		whenToUse: "When you asked the user multiple numbered questions and they might want a compact way to answer.",
		body: "By the way, if you want to answer multiple questions at once, you can reply like this:\n1: ...\n2: ...\n3: ...",
	},
	ask_to_run_commands: {
		title: "Tell Pi explicitly when to run something",
		whenToUse: "When execution is optional and the user may not realize they can ask Pi to actually run a check or demo.",
		body: 'If you want me to actually execute something, be explicit. For example: "run it now", "run the tests", or "check it in the terminal".',
	},
	one_vertical_slice: {
		title: "Ask for one small vertical slice at a time",
		whenToUse: "When the project feels too broad and the user would benefit from a smaller, safer next step.",
		body: 'A good way to keep things moving is to ask for one small vertical slice at a time, for example: "implement the smallest usable version first".',
	},
};

function isStepId(value: unknown): value is StepId {
	return typeof value === "string" && (STEP_IDS as readonly string[]).includes(value);
}

function isHintId(value: unknown): value is HintId {
	return typeof value === "string" && (HINT_IDS as readonly string[]).includes(value);
}

function orderedUniqueSteps(steps: Iterable<StepId>): StepId[] {
	const set = new Set<StepId>(steps);
	return STEP_IDS.filter((step) => set.has(step));
}

function orderedUniqueHints(hints: Iterable<HintId>): HintId[] {
	const set = new Set<HintId>(hints);
	return HINT_IDS.filter((hint) => set.has(hint));
}

function nextStep(completedSteps: StepId[]): StepId | undefined {
	return STEP_IDS.find((step) => !completedSteps.includes(step));
}

function reconstructCompletedSteps(ctx: ExtensionContext): StepId[] {
	const done = new Set<StepId>();
	for (const entry of ctx.sessionManager.getEntries() as Array<{
		type?: string;
		message?: { role?: string; toolName?: string; details?: { step?: unknown } };
	}>) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "toolResult" || message.toolName !== STEP_TOOL_NAME) continue;
		if (isStepId(message.details?.step)) done.add(message.details.step);
	}
	return orderedUniqueSteps(done);
}

function reconstructShownHints(ctx: ExtensionContext): HintId[] {
	const shown = new Set<HintId>();
	for (const entry of ctx.sessionManager.getEntries() as Array<{
		type?: string;
		message?: { role?: string; toolName?: string; details?: { hint?: unknown; alreadyShown?: unknown } };
	}>) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "toolResult" || message.toolName !== HINT_TOOL_NAME) continue;
		if (isHintId(message.details?.hint)) shown.add(message.details.hint);
	}
	return orderedUniqueHints(shown);
}

function hasConversationMessages(ctx: ExtensionContext): boolean {
	return (ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string } }>).some(
		(entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
	);
}

const PLAN_REQUEST_RE = /\b(plan|planning|implementation plan|design|back[- ]?and[- ]?forth|clarify)\b/i;

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part) {
				const text = (part as { text?: unknown }).text;
				if (typeof text === "string") return text;
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function formatStepList(): string {
	return STEP_IDS.map((step, index) => `${index + 1}. ${STEPS[step].title}\n   Completion signal: ${STEPS[step].hint}`).join("\n");
}

function formatHintList(): string {
	return HINT_IDS.map((hint) => `- ${hint}: ${HINTS[hint].whenToUse}`).join("\n");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function hasExecutable(command: string): boolean {
	const result = spawnSync(command, ["--version"], {
		stdio: "ignore",
		timeout: 1000,
	});
	return !result.error && result.status === 0;
}

function detectInstalledLanguages(): string[] {
	const installed: string[] = [];
	if (hasExecutable("python3")) installed.push("Python");
	if (hasExecutable("node")) installed.push("JavaScript/TypeScript (Node.js)");
	if (hasExecutable("go")) installed.push("Go");
	if (hasExecutable("rustc") || hasExecutable("cargo")) installed.push("Rust");
	if (hasExecutable("ruby")) installed.push("Ruby");
	return installed;
}

function buildKickoffPrompt(installedLanguages: string[]): string {
	const runtimeList = installedLanguages.length > 0 ? installedLanguages.join(", ") : "none detected";
	return `[PI TUTORIAL]
You are guiding the user through the interactive Pi tutorial.

Track these tutorial steps and mark them complete with the ${STEP_TOOL_NAME} tool when the user genuinely achieves them:
${formatStepList()}

Available one-time hints via ${HINT_TOOL_NAME}:
${formatHintList()}

Rules:
- Use ${STEP_TOOL_NAME} exactly when a step is actually complete.
- Do not mark a step just because it was mentioned or planned.
- Never call ${STEP_TOOL_NAME} again for a step that was already completed earlier.
- Keep track of completed steps from previous ${STEP_TOOL_NAME} tool results.
- Do not mark "Start chatting" during your first response.
- The kickoff/tutorial message itself does not count as the user starting to chat.
- Only mark "Start chatting" after the user sends a genuine follow-up message after your initial welcome.
- Use ${HINT_TOOL_NAME} only when a built-in hint would genuinely help the user prompt Pi better.
- Never show the same hint twice. Track which hints were already shown from previous ${HINT_TOOL_NAME} tool results.
- Do not dump raw example prompts from tool results back to the user verbatim unless they fit naturally.
- Instead, use the hidden tool guidance to colloquially coach the user in your own words.
- Keep guidance short, practical, and aligned with the user's direct request.
- If execution is optional, ask before running non-trivial commands or demos.
- Before project selection, gather onboarding context: programming/language familiarity (including a non-programmer option) and familiarity with AI coding tools.
- Detected runnable languages on this machine: ${runtimeList}.
- When discussing language preferences, only suggest languages from that detected list (plus the non-programmer option).
- If the user states a preferred programming language, carry that preference through project choice and implementation unless they ask to switch.
- Teach Pi-specific concepts in separate mini-steps (not one long message):
  1) minimal system prompt + only four built-in tools (read/edit/write/bash) + extensions/skills,
  2) no sandboxing + full permissions by design.
- Keep each onboarding response compact; avoid combining multiple tutorial steps into a single long reply.
- Do not reveal internal tutorial framing in user-facing text (no "step", "orientation", "1/2", or "2/2"). Explain naturally and continue.
- By default, after finishing a step, do not proactively perform the next step. Instead, coach the user how to ask for it and then wait.
- Exception: when moving to "Pi basics" or "Pick project", ask one direct follow-up question to offer that next step now (do not ask the user to re-prompt Pi first).
- Specifically: after "Pick project", do not start planning automatically. Wait for an explicit user planning request.

In your first reply:
- Welcome the user.
- Explain that they can type in the bottom input and press Enter to chat.
- Briefly mention that you can read/edit/write files and run commands.
- Ask 2 short onboarding questions (numbered) covering: language/background and AI coding tool familiarity.
- In the language question, if giving examples, use only the detected runnable languages: ${runtimeList}.
- Tell them they can answer in numbered form (1/2).
- Say you will tailor project ideas based on their answers after a couple of short setup explanations.`;
}

function getPiMascot(theme: Theme): string[] {
	return [
		"",
		theme.fg("accent", "  ██████"),
		theme.fg("accent", "  ██  ██"),
		theme.fg("accent", "  ████  ██"),
		theme.fg("accent", "  ██    ██"),
		"",
	];
}

function buildStatusText(completedSteps: StepId[]): string {
	const done = new Set(completedSteps);
	const next = nextStep(completedSteps);
	const lines = [`Progress: ${completedSteps.length}/${STEP_IDS.length}`, ""];

	for (const step of STEP_IDS) {
		const marker = done.has(step) ? "✓" : step === next ? "→" : "○";
		const suffix = step === next ? ` — next (${STEPS[step].hint})` : "";
		lines.push(`${marker} ${STEPS[step].label}${suffix}`);
	}

	return lines.join("\n");
}


export default function onboardingGuideExtension(pi: ExtensionAPI) {
	let completedSteps: StepId[] = [];
	let shownHints: HintId[] = [];
	let pendingTutorialEvents: string[] = [];
	let kickoffSent = false;

	pi.registerMessageRenderer(KICKOFF_MESSAGE_TYPE, (_message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				[
					...getPiMascot(theme),
					theme.fg("accent", "    " + theme.bold("Welcome to the pi tutorial!")),
					theme.fg("muted", "    " + ONBOARDING_STARTING_MESSAGE),
				].join("\n") + "\n",
				0,
				0,
			),
		);
		return box;
	});

	const renderFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose,
				invalidate() {},
				render(width: number): string[] {
					const doneCount = completedSteps.length;
					const next = nextStep(completedSteps);
					const tutor = theme.fg("accent", theme.bold(`Tutor ${doneCount}/${STEP_IDS.length}`));
					const nextText = next
						? theme.fg("warning", `Next: ${STEPS[next].label}`)
						: theme.fg("success", "All tutorial steps complete");
					const leftTop = `${tutor}${theme.fg("dim", " • ")}${nextText}`;

					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) {
						pwd = `${pwd} (${branch})`;
					}
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}
					const rightTop = theme.fg("dim", pwd);

					const leftTopWidth = visibleWidth(leftTop);
					const rightTopWidth = visibleWidth(rightTop);
					const gap = 1;
					let topLine: string;
					if (leftTopWidth + gap + rightTopWidth <= width) {
						topLine = `${leftTop}${" ".repeat(width - leftTopWidth - rightTopWidth)}${rightTop}`;
					} else {
						const leftBudget = Math.max(0, width - rightTopWidth - gap);
						if (leftBudget >= 12) {
							const leftTruncated = truncateToWidth(leftTop, leftBudget, theme.fg("dim", "..."));
							topLine = `${leftTruncated}${" ".repeat(Math.max(gap, width - visibleWidth(leftTruncated) - rightTopWidth))}${rightTop}`;
						} else {
							const leftBudgetSplit = Math.max(0, Math.floor(width * 0.45));
							const rightBudgetSplit = Math.max(0, width - leftBudgetSplit - gap);
							const leftTruncated = truncateToWidth(leftTop, leftBudgetSplit, theme.fg("dim", "..."));
							const rightTruncated = truncateToWidth(rightTop, rightBudgetSplit, theme.fg("dim", "..."));
							topLine = `${leftTruncated}${" ".repeat(Math.max(gap, width - visibleWidth(leftTruncated) - visibleWidth(rightTruncated)))}${rightTruncated}`;
						}
					}
					topLine = truncateToWidth(topLine, width, theme.fg("dim", "..."));

					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					for (const entry of ctx.sessionManager.getEntries() as Array<{
						type?: string;
						message?: {
							role?: string;
							usage?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								cost?: { total?: number };
							};
						};
					}>) {
						if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
						totalInput += entry.message.usage?.input ?? 0;
						totalOutput += entry.message.usage?.output ?? 0;
						totalCacheRead += entry.message.usage?.cacheRead ?? 0;
						totalCacheWrite += entry.message.usage?.cacheWrite ?? 0;
						totalCost += entry.message.usage?.cost?.total ?? 0;
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
					const autoIndicator = " (auto)";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

					let contextPercentStr: string;
					if (contextPercentValue > 90) {
						contextPercentStr = theme.fg("error", contextPercentDisplay);
					} else if (contextPercentValue > 70) {
						contextPercentStr = theme.fg("warning", contextPercentDisplay);
					} else {
						contextPercentStr = contextPercentDisplay;
					}

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					const thinkingLevel =
						ctx.model?.reasoning && typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off";
					const rightWithoutProvider =
						ctx.model?.reasoning && thinkingLevel !== "off"
							? `${modelName} • ${thinkingLevel}`
							: ctx.model?.reasoning
							? `${modelName} • thinking off`
							: modelName;
					let rightSide = rightWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightSideWidth <= width) {
						statsLine = `${statsLeft}${" ".repeat(width - statsLeftWidth - rightSideWidth)}${rightSide}`;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							statsLine = `${statsLeft}${" ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					return [topLine, dimStatsLeft + dimRemainder];
				},
			};
		});
	};

	const refreshFromSession = (ctx: ExtensionContext) => {
		completedSteps = reconstructCompletedSteps(ctx);
		shownHints = reconstructShownHints(ctx);
		kickoffSent = (ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string }>).some(
			(entry) => entry.type === "custom" && entry.customType === KICKOFF_MESSAGE_TYPE,
		);
		renderFooter(ctx);
	};

	const maybeSendKickoff = (ctx: ExtensionContext) => {
		if (kickoffSent || hasConversationMessages(ctx)) return;
		kickoffSent = true;
		const installedLanguages = detectInstalledLanguages();
		pi.sendMessage(
			{
				customType: KICKOFF_MESSAGE_TYPE,
				content: buildKickoffPrompt(installedLanguages),
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	const queueHiddenEvent = (content: string) => {
		if (!pendingTutorialEvents.includes(content)) {
			pendingTutorialEvents.push(content);
		}
	};

	pi.registerTool({
		name: STEP_TOOL_NAME,
		label: "Mark Step Done",
		description: "Mark one tutorial step as completed.",
		promptSnippet: "Mark a tutorial step as done when the user has genuinely completed it.",
		promptGuidelines: [
			`Use ${STEP_TOOL_NAME} when the user actually completes a tutorial step.`,
			"Do not mark steps early just because they were discussed.",
		],
		parameters: Type.Object({
			step: StringEnum(STEP_IDS, { description: "The tutorial step that was completed" }),
			note: Type.Optional(Type.String({ description: "Optional short note about what was achieved" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.step === "chat") {
				const branch = ctx.sessionManager.getBranch() as Array<{
					type?: string;
					message?: { role?: string; content?: unknown };
				}>;
				const lastUser = [...branch].reverse().find(
					(entry) => entry.type === "message" && entry.message?.role === "user",
				);
				const lastUserText = messageContentToText(lastUser?.message?.content).trim();
				if (!PLAN_REQUEST_RE.test(lastUserText)) {
					const next = nextStep(completedSteps);
					return {
						content: [
							{
								type: "text",
								text: [
									`Cannot mark step done yet: ${STEPS.chat.label}.`,
									`The user did not explicitly ask to start planning in their latest message. Coach them with 1-2 example planning prompts and wait.`,
									next ? `Next incomplete step remains: ${STEPS[next].label}.` : "",
								].filter(Boolean).join(" "),
							},
						],
					};
				}
			}

			if (params.step === "piPermissions" && !completedSteps.includes("piFoundations")) {
				const next = nextStep(completedSteps);
				return {
					content: [
						{
							type: "text",
							text: [
								`Cannot mark step done yet: ${STEPS.piPermissions.label}.`,
								`First complete ${STEPS.piFoundations.label}.`,
								next ? `Next incomplete step remains: ${STEPS[next].label}.` : "",
							].filter(Boolean).join(" "),
						},
					],
				};
			}

			if (params.step === "idea") {
				const missing = ["profile", "piFoundations", "piPermissions"].filter((step) => !completedSteps.includes(step as StepId));
				if (missing.length > 0) {
					const next = nextStep(completedSteps);
					return {
						content: [
							{
								type: "text",
								text: [
									`Cannot mark step done yet: ${STEPS.idea.label}.`,
									`Complete these first: ${missing.map((step) => STEPS[step as StepId].label).join(", ")}.`,
									next ? `Next incomplete step remains: ${STEPS[next].label}.` : "",
								].filter(Boolean).join(" "),
							},
						],
					};
				}
			}

			if (params.step === "iterate" && !completedSteps.includes("extension")) {
				const next = nextStep(completedSteps);
				return {
					content: [
						{
							type: "text",
							text: [
								`Cannot mark step done yet: ${STEPS.iterate.label}.`,
								`Finish ${STEPS.extension.label} first (including /reload), then run a debug/iteration loop.`,
								next ? `Next incomplete step remains: ${STEPS[next].label}.` : "",
							].filter(Boolean).join(" "),
						},
					],
				};
			}

			const current = new Set(completedSteps);
			const alreadyDone = current.has(params.step);
			current.add(params.step);
			completedSteps = orderedUniqueSteps(current);
			renderFooter(ctx);

			const remainingSteps = STEP_IDS.filter((step) => !current.has(step));
			const next = nextStep(completedSteps);
			const nextPromptExamples = next ? STEPS[next].promptExamples : [];
			const details: MarkStepDoneDetails = {
				step: params.step,
				title: STEPS[params.step].title,
				note: params.note?.trim() || undefined,
				alreadyDone,
				completedSteps: [...completedSteps],
				doneCount: completedSteps.length,
				remainingSteps,
				nextStep: next,
				nextPromptExamples,
			};

			const completedLabels = completedSteps.map((step) => STEPS[step].label).join(", ");
			const nextPromptText = nextPromptExamples.length > 0
				? ` Suggested prompts: ${nextPromptExamples.slice(0, 2).map((example) => `"${example}"`).join(" or ")}.`
				: "";
			const shouldAskDirectly = next === "piFoundations" || next === "idea";
			const nextStepCoaching = next
				? shouldAskDirectly
					? `In your next assistant message, ask one direct follow-up question offering ${STEPS[next].label} now. Do not ask the user to re-prompt Pi first.`
					: `In your next assistant message, coach the user on how to ask for ${STEPS[next].label} with 1-2 concrete example prompts, then wait for their explicit request before proceeding.${nextPromptText}`
				: "";
			const text = alreadyDone
				? [
					`Step already completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					next ? `Next incomplete step: ${STEPS[next].label}.` : "All tutorial steps are complete.",
					nextStepCoaching,
				].filter(Boolean).join(" ")
				: [
					`Step completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					next ? `Next incomplete step: ${STEPS[next].label}.` : "All tutorial steps are complete.",
					nextStepCoaching,
				].filter(Boolean).join(" ");

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(_args, _theme) {
			return new Text("", 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as MarkStepDoneDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const duplicate = details.alreadyDone;
			const status = duplicate ? theme.fg("warning", "↺") : theme.fg("success", "✓");
			let text = `${status} ${theme.bold(`${duplicate ? "Step already completed" : "Step completed"}: ${STEPS[details.step].label}`)}`;

			if (details.note) {
				text += `\n${theme.fg("muted", details.note)}`;
			}

			if (duplicate) {
				text += `\n${theme.fg("warning", "Do not mark this step again.")}`;
			}

			if (details.nextStep) {
				text += `\n${theme.fg("dim", `Next up: ${STEPS[details.nextStep].label}`)}`;
			} else {
				text += `\n${theme.fg("success", "All tutorial steps complete")}`;
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: HINT_TOOL_NAME,
		label: "Show Hint",
		description: "Show a one-time tutorial hint that helps the user prompt Pi better.",
		promptSnippet: "Show a built-in one-time hint when it would help the user understand how to work with Pi.",
		promptGuidelines: [
			`Use ${HINT_TOOL_NAME} sparingly for one-time coaching nudges.`,
			"Never show the same hint twice.",
		],
		parameters: Type.Object({
			hint: StringEnum(HINT_IDS, { description: "The built-in hint to show" }),
		}),

		async execute(_toolCallId, params) {
			const current = new Set(shownHints);
			const alreadyShown = current.has(params.hint);
			current.add(params.hint);
			shownHints = orderedUniqueHints(current);

			const meta = HINTS[params.hint];
			const shownList = shownHints.map((hint) => hint).join(", ");
			const text = alreadyShown
				? [
					`Hint already shown: ${params.hint}.`,
					`Do not call ${HINT_TOOL_NAME} again for this hint.`,
					shownList ? `Hints already shown: ${shownList}.` : "",
				].filter(Boolean).join(" ")
				: [
					`Hint shown: ${params.hint}.`,
					`Do not call ${HINT_TOOL_NAME} again for this hint.`,
					`In your next assistant message, briefly reinforce this hint naturally in your own words if useful, but do not repeat it mechanically.`,
				].join(" ");

			const details: ShowHintDetails = {
				hint: params.hint,
				title: meta.title,
				body: meta.body,
				alreadyShown,
			};

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(_args, _theme) {
			return new Text("", 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ShowHintDetails | undefined;
			if (!details || details.alreadyShown) {
				return new Text("", 0, 0);
			}

			const text = `${theme.fg("accent", "💡 ")}${theme.bold(details.title)}\n${theme.fg("muted", details.body)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("onboard", {
		description: "Show tutorial progress or insert a suggested next prompt",
		handler: async (args, ctx) => {
			refreshFromSession(ctx);

			const command = (args ?? "").trim();
			if (!command || command === "status") {
				ctx.ui.notify(buildStatusText(completedSteps), "info");
				return;
			}

			if (command === "prompt") {
				const next = nextStep(completedSteps);
				if (!next) {
					ctx.ui.notify("All tutorial steps complete.", "info");
					return;
				}
				ctx.ui.setEditorText(STEPS[next].prompt);
				ctx.ui.notify("Inserted a suggested next prompt into the editor.", "info");
				return;
			}

			ctx.ui.notify("Usage: /onboard [status|prompt]", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshFromSession(ctx);
		const globalObj = globalThis as Record<PropertyKey, unknown>;
		const pendingReloadAt = globalObj[RELOAD_PENDING_KEY];
		if (typeof pendingReloadAt === "number" && Date.now() - pendingReloadAt < 15000) {
			delete globalObj[RELOAD_PENDING_KEY];
			if (!completedSteps.includes("extension")) {
				queueHiddenEvent(
					`[TUTORIAL EVENT]\nThe extension runtime just reloaded successfully. If the tutorial step "Build extension" is otherwise satisfied and not already complete, you may mark it done with ${STEP_TOOL_NAME}.`,
				);
			} else if (!completedSteps.includes("iterate")) {
				queueHiddenEvent(
					`[TUTORIAL EVENT]\nThe extension runtime reloaded while "Build extension" is already complete. Coach the user to run the extension, inspect behavior, and do one concrete debug/iteration cycle. If they complete that loop, mark "Debug + iterate" with ${STEP_TOOL_NAME}.`,
				);
			}
		}
		maybeSendKickoff(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify("Pi tutorial guide is active.", "info");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshFromSession(ctx);
		maybeSendKickoff(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshFromSession(ctx);
	});

	pi.on("before_agent_start", async () => {
		if (pendingTutorialEvents.length === 0) return;
		const content = pendingTutorialEvents.join("\n\n");
		pendingTutorialEvents = [];
		return {
			message: {
				customType: EVENT_MESSAGE_TYPE,
				content,
				display: false,
			},
		};
	});

	pi.on("model_select", async (_event, ctx) => {
		renderFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		(globalThis as Record<PropertyKey, unknown>)[RELOAD_PENDING_KEY] = Date.now();
	});
}
