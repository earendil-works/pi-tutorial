import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const RELOAD_PENDING_KEY = Symbol.for("pi-tutorial.onboarding.reload-pending");

const STEP_IDS = ["basics", "idea", "chat", "code", "tests", "tree", "extension"] as const;
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
const IMPLEMENTATION_CHECKPOINT_LABEL = "before-implementation";
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
	idea: {
		label: "Pick project",
		title: "Pick a small project (target: ~200-300 LOC)",
		hint: "A concrete small project has been chosen.",
		prompt:
			"Help me pick a small project I can build in ~200-300 lines. Give me 3 options, each with a short scope and test strategy.",
		promptExamples: [
			"Help me pick a small project I can build in ~200-300 lines. Give me 3 options, each with a short scope and test strategy.",
			"Ask me a couple of questions and then suggest 3 tiny tutorial projects.",
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
	tree: {
		label: "Rewind with /tree",
		title: "Use /tree to rewind and summarize a branch",
		hint: `The user used /tree to jump back to the ${IMPLEMENTATION_CHECKPOINT_LABEL} checkpoint and chose Summarize (not "No summary").`,
		prompt:
			`Let's use /tree to jump back to the ${IMPLEMENTATION_CHECKPOINT_LABEL} checkpoint, choose Summarize (not "No summary"), and then continue from there with a cleaner context.`,
		promptExamples: [
			`Let's use /tree to jump back to the ${IMPLEMENTATION_CHECKPOINT_LABEL} checkpoint, choose Summarize (not "No summary"), and then continue from there.`,
			`Please use /tree, select ${IMPLEMENTATION_CHECKPOINT_LABEL}, choose Summarize, and then let's build the extension from that cleaner branch.`,
		],
	},
	extension: {
		label: "Build extension",
		title: "Create your own extension and reload (/reload)",
		hint: "A small extension was created or updated and reloaded in Pi.",
		prompt:
			"Create a tiny custom Pi extension in .pi/extensions/ that adds one useful command for this project.",
		promptExamples: [
			"Help me create a tiny Pi extension for this project.",
			"Scaffold a minimal extension in .pi/extensions/ that adds one useful command.",
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

function formatStepList(): string {
	return STEP_IDS.map((step, index) => `${index + 1}. ${STEPS[step].title}\n   Completion signal: ${STEPS[step].hint}`).join("\n");
}

function formatHintList(): string {
	return HINT_IDS.map((hint) => `- ${hint}: ${HINTS[hint].whenToUse}`).join("\n");
}

function buildKickoffPrompt(): string {
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

In your first reply:
- Welcome the user.
- Explain that they can type in the bottom input and press Enter to chat.
- Briefly mention that you can read/edit/write files and run commands.
- Offer 3 starter project ideas (or invite them to propose their own).
- Ask exactly one concrete follow-up question.`;
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
	let sawTreeSummarizationEvent = false;

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
					const left = theme.fg("accent", theme.bold(`Tutor ${doneCount}/${STEP_IDS.length}`));
					const middle = next
						? theme.fg("warning", `Next: ${STEPS[next].label}`)
						: theme.fg("success", "All tutorial steps complete");

					const branch = footerData.getGitBranch();
					const rightParts = [ctx.model?.id];
					if (branch) rightParts.push(`(${branch})`);
					const right = rightParts.filter(Boolean).length > 0 ? theme.fg("dim", rightParts.filter(Boolean).join(" ")) : "";

					let line = `${left}${theme.fg("dim", " • ")}${middle}`;
					if (right) {
						const pad = " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(right)));
						line += pad + right;
					}
					return [truncateToWidth(line, width)];
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
		pi.sendMessage(
			{
				customType: KICKOFF_MESSAGE_TYPE,
				content: buildKickoffPrompt(),
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
			if (params.step === "tree" && !sawTreeSummarizationEvent && !completedSteps.includes("tree")) {
				const next = nextStep(completedSteps);
				return {
					content: [
						{
							type: "text",
							text: [
								`Cannot mark step done yet: ${STEPS.tree.label}.`,
								`No /tree summarization event was detected. The user likely selected "No summary".`,
								`Ask them to run /tree again, pick ${IMPLEMENTATION_CHECKPOINT_LABEL}, and choose Summarize.`,
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
			if (!alreadyDone && params.step === "chat") {
				const leafId = ctx.sessionManager.getLeafId();
				if (leafId) pi.setLabel(leafId, IMPLEMENTATION_CHECKPOINT_LABEL);
			}
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
			const text = alreadyDone
				? [
					`Step already completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					next ? `Next incomplete step: ${STEPS[next].label}.` : "All tutorial steps are complete.",
					next
						? `In your next assistant message, coach the user on how to ask for ${STEPS[next].label} with 1-2 concrete example prompts before taking over.${nextPromptText}`
						: "",
				].filter(Boolean).join(" ")
				: [
					`Step completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					next ? `Next incomplete step: ${STEPS[next].label}.` : "All tutorial steps are complete.",
					next
						? `In your next assistant message, coach the user on how to ask for ${STEPS[next].label} with 1-2 concrete example prompts before taking over.${nextPromptText}`
						: "",
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

	pi.on("session_tree", async (event, ctx) => {
		refreshFromSession(ctx);
		if (completedSteps.includes("tree")) return;

		if (!event.summaryEntry) {
			queueHiddenEvent(
				`[TUTORIAL EVENT]\nThe user used /tree but did not choose Summarize (likely selected "No summary"). The tutorial step "Rewind with /tree" is not complete yet. Coach them to run /tree again, pick ${IMPLEMENTATION_CHECKPOINT_LABEL}, and choose Summarize.`,
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Tutorial tip: /tree step is only complete after choosing Summarize (not "No summary").`,
					"warning",
				);
			}
			return;
		}

		sawTreeSummarizationEvent = true;
		const targetId = event.summaryEntry.parentId ?? event.newLeafId;
		const targetLabel = targetId ? ctx.sessionManager.getLabel(targetId) : undefined;
		const summaryLabel = ctx.sessionManager.getLabel(event.summaryEntry.id);
		const usedCheckpoint =
			targetLabel === IMPLEMENTATION_CHECKPOINT_LABEL || summaryLabel === IMPLEMENTATION_CHECKPOINT_LABEL;

		queueHiddenEvent(
			usedCheckpoint
				? `[TUTORIAL EVENT]\nThe user used /tree, navigated back to the labeled checkpoint "${IMPLEMENTATION_CHECKPOINT_LABEL}", and chose summarization. If the tutorial step "Rewind with /tree" is not already complete, mark it done with ${STEP_TOOL_NAME}.`
				: `[TUTORIAL EVENT]\nThe user used /tree and chose summarization. If the tutorial step "Rewind with /tree" is not already complete, mark it done with ${STEP_TOOL_NAME}.`,
		);
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
