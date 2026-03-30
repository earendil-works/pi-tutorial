import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const STEP_IDS = ["basics", "idea", "chat", "code", "tests", "share", "model", "extension"] as const;
type StepId = (typeof STEP_IDS)[number];

interface StepMeta {
	label: string;
	title: string;
	hint: string;
	prompt: string;
	promptExamples: string[];
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

const TOOL_NAME = "mark_step_done";
const KICKOFF_MESSAGE_TYPE = "onboarding-guide-kickoff";
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
			"Start coding the smallest playable version we agreed on.",
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
	share: {
		label: "Share session",
		title: "Share the session (/share)",
		hint: "The user has shared the session or is clearly ready to do so.",
		prompt: "Quickly summarize what we built so I can share this session with someone.",
		promptExamples: [
			"Give me a short recap I can share, then remind me to run /share.",
			"Summarize what we built so I can share this session.",
		],
	},
	model: {
		label: "Switch model",
		title: "Switch models and compare output style",
		hint: "A different model was used and its style or output was compared.",
		prompt:
			"Let's switch to a different model now. After switching, give me a concise recap and one improvement suggestion.",
		promptExamples: [
			"Let's switch models and compare the response style.",
			"After I switch models, give me a concise recap and one improvement suggestion.",
		],
	},
	extension: {
		label: "Build extension",
		title: "Create your own extension and reload (/reload)",
		hint: "A small extension was created or updated and reloaded in Pi.",
		prompt:
			"Create a tiny custom Pi extension in .pi/extensions/ that adds one useful command for this project, then tell me to run /reload.",
		promptExamples: [
			"Help me create a tiny Pi extension for this project, then tell me to run /reload.",
			"Scaffold a minimal extension in .pi/extensions/ that adds one useful command.",
		],
	},
};

function isStepId(value: unknown): value is StepId {
	return typeof value === "string" && (STEP_IDS as readonly string[]).includes(value);
}

function orderedUniqueSteps(steps: Iterable<StepId>): StepId[] {
	const set = new Set<StepId>(steps);
	return STEP_IDS.filter((step) => set.has(step));
}

function nextStep(completedSteps: StepId[]): StepId | undefined {
	return STEP_IDS.find((step) => !completedSteps.includes(step));
}

function reconstructCompletedSteps(ctx: ExtensionContext): StepId[] {
	const done = new Set<StepId>();
	for (const entry of ctx.sessionManager.getBranch() as Array<{
		type?: string;
		message?: { role?: string; toolName?: string; details?: { step?: unknown } };
	}>) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		if (isStepId(message.details?.step)) done.add(message.details.step);
	}
	return orderedUniqueSteps(done);
}

function hasConversationMessages(ctx: ExtensionContext): boolean {
	return (ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string } }>).some(
		(entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
	);
}

function formatStepList(): string {
	return STEP_IDS.map((step, index) => `${index + 1}. ${STEPS[step].title}\n   Completion signal: ${STEPS[step].hint}`).join("\n");
}

function buildKickoffPrompt(): string {
	return `[PI TUTORIAL]
You are guiding the user through the interactive Pi tutorial.

Track these tutorial steps and mark them complete with the ${TOOL_NAME} tool when the user genuinely achieves them:
${formatStepList()}

Rules:
- Use ${TOOL_NAME} exactly when a step is actually complete.
- Do not mark a step just because it was mentioned or planned.
- Never call ${TOOL_NAME} again for a step that was already completed earlier.
- Keep track of completed steps from previous ${TOOL_NAME} tool results.
- Do not mark "Start chatting" during your first response.
- The kickoff/tutorial message itself does not count as the user starting to chat.
- Only mark "Start chatting" after the user sends a genuine follow-up message after your initial welcome.
- Call the tool at most once per step.
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

	pi.registerTool({
		name: TOOL_NAME,
		label: "Mark Step Done",
		description: "Mark one tutorial step as completed.",
		promptSnippet: "Mark a tutorial step as done when the user has genuinely completed it.",
		promptGuidelines: [
			`Use ${TOOL_NAME} when the user actually completes a tutorial step.`,
			"Do not mark steps early just because they were discussed.",
		],
		parameters: Type.Object({
			step: StringEnum(STEP_IDS, { description: "The tutorial step that was completed" }),
			note: Type.Optional(Type.String({ description: "Optional short note about what was achieved" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
			const text = alreadyDone
				? [
					`Step already completed: ${STEPS[params.step].label}.`,
					`Do not call ${TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					next ? `Next incomplete step: ${STEPS[next].label}.` : "All tutorial steps are complete.",
					next
						? `In your next assistant message, coach the user on how to ask for ${STEPS[next].label} with 1-2 concrete example prompts before taking over.${nextPromptText}`
						: "",
				].filter(Boolean).join(" ")
				: [
					`Step completed: ${STEPS[params.step].label}.`,
					`Do not call ${TOOL_NAME} again for this step.`,
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

	pi.on("session_tree", async (_event, ctx) => {
		refreshFromSession(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		renderFooter(ctx);
	});
}
