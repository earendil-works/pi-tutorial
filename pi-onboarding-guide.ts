import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const RELOAD_PENDING_KEY = Symbol.for("pi-tutorial.onboarding.reload-pending");

interface StepMeta {
	label: string;
	title: string;
	hint: string;
	completionMessage?: string;
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
}

const STEP_TOOL_NAME = "mark_step_done";
const KICKOFF_MESSAGE_TYPE = "onboarding-guide-kickoff";
const EVENT_MESSAGE_TYPE = "onboarding-guide-event";
const ONBOARDING_STARTING_MESSAGE = "Hang on for a bit, I'm preparing a custom tour for you.";


const STEP_IDS = ["intro", "chooseApp", "planning", "buildApp", "extension"] as const;
type StepId = (typeof STEP_IDS)[number];
const STEPS: Record<StepId, StepMeta> = {
	intro: {
		label: "Pi intro",
		title: "Get the intro (input box, tools, no sandbox, tutorial goals)",
		hint: "The user was told this is Pi, how to use the input box, that Pi can read/edit/write/bash, that Pi has no sandbox, and that the tutorial goal is to build a small app while learning what makes Pi special.",
	},
	chooseApp: {
		label: "Decide which app to build",
		title: "Let's decide which app to build",
		hint: "The user decided on a small application/script to be built together",
		completionMessage:
			"If the planning step is not completed yet, invite the user to trigger planning explicitly with a prompt pattern (for example: \"let's do a back and forth until we have clarity\" or \"let's start planning this out\"). Do not start planning or provide a plan yet.",
	},
	planning: {
		label: "Plan back-and-forth",
		title: "Learn the planning prompt pattern",
		hint: "The user explicitly asked to enter planning mode (for example with 'let's do it back and forth until we have clarity' or 'let's start planning this out') after being coached.",
		completionMessage:
			"If the extension step is not completed yet, suggest creating a useful Pi extension related to what was built (for example validation, debugging helpers, or automation), then have the user run /reload.",
	},
  buildApp: {
    label: "Build the app",
    title: "Build the application together",
    hint: "A small application/script was built together with meaningful progress. The model can decide what counts as sufficiently built.",
    completionMessage:
      "If the app was built you might encourage the user to create tests and run them, or you can go towards the extension",
  },
	extension: {
		label: "Build extension",
		title: "Create a useful Pi extension for this project",
		hint: "A Pi extension relevant to this project was created/updated in .pi/extensions and /reload was run (or a successful reload was otherwise confirmed).",
		completionMessage:
			"Encourage the user to continue iterating on building the app with the extension loaded.",
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

function hasConversationMessages(ctx: ExtensionContext): boolean {
	return (ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string } }>).some(
		(entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
	);
}

function hasUserMessages(ctx: ExtensionContext): boolean {
	return (ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string } }>).some(
		(entry) => entry.type === "message" && entry.message?.role === "user",
	);
}

function formatStepList(): string {
	return STEP_IDS.map((step, index) => `${index + 1}. ${STEPS[step].title}\n   Completion signal: ${STEPS[step].hint}`).join("\n");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function buildKickoffPrompt(): string {
	return `[PI TUTORIAL]
You are guiding the user through the interactive Pi tutorial.

Track these tutorial steps and mark them complete with the ${STEP_TOOL_NAME} tool when the user genuinely achieves them:
${formatStepList()}

Rules:
- Use ${STEP_TOOL_NAME} exactly when a step is actually complete.
- Do not mark a step just because it was mentioned or planned.
- Never call ${STEP_TOOL_NAME} again for a step that was already completed earlier.
- Keep track of completed steps from previous ${STEP_TOOL_NAME} tool results.
- Do not call ${STEP_TOOL_NAME} in your very first tutorial reply.
- Do not call ${STEP_TOOL_NAME} until the user has sent at least one real message after your initial tutorial welcome.
- Mark at most one tutorial step per assistant turn.
- Tutorial steps can be completed in any order.
- Keep guidance short, practical, and aligned with the user's direct request.
- Don't expose internal tutorial mechanics (no "step 1/2/3", no internal tool names).
- Keep the conversation hands-on and builder-oriented.
- Never output a concrete plan/checklist (for example a "Quick plan") unless the user explicitly asks to start planning.
- After the intro, explicitly teach the planning prompt pattern ("let's do it back and forth until we have clarity" / "let's start planning this out") at least once, but only as an invitation.
- When encouraging extension work, ground it in what was built in this session and propose something useful (debugging, validation, helpers, etc.).

In your first reply:
- Introduce this as Pi and a Pi tutorial.
- Explain that the bottom input box is where they type requests and press Enter.
- Briefly state Pi's built-in capabilities: read, edit, write files, and run terminal commands.
- Clearly state Pi runs with no sandbox (full permissions / YOLO mode).
- State the tutorial goals explicitly:
  a) build a small app
  b) learn what makes Pi special by building it
- Let the user know that if they are confused at any point, they can just ask
- Ask one short follow-up question to get started on what they want to build.

Begin your first reply with "Welcome to Pi ..."
`;
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

export default function onboardingGuideExtension(pi: ExtensionAPI) {
	let completedSteps: StepId[] = [];
	let pendingTutorialEvents: string[] = [];
	let kickoffSent = false;
	let stepMarksThisTurn = 0;

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
			if (!hasUserMessages(ctx)) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot mark tutorial steps yet. Wait for at least one real user follow-up message after the initial tutorial welcome before calling ${STEP_TOOL_NAME}.`,
						},
					],
				};
			}

			if (stepMarksThisTurn >= 1) {
				return {
					content: [
						{
							type: "text",
							text: `Only one tutorial step can be marked per assistant turn. Do not call ${STEP_TOOL_NAME} again in this turn.`,
						},
					],
				};
			}

			const current = new Set(completedSteps);
			const alreadyDone = current.has(params.step);
			current.add(params.step);
			completedSteps = orderedUniqueSteps(current);
			stepMarksThisTurn += 1;
			renderFooter(ctx);

			const remainingSteps = STEP_IDS.filter((step) => !current.has(step));
			const next = nextStep(completedSteps);
			const details: MarkStepDoneDetails = {
				step: params.step,
				title: STEPS[params.step].title,
				note: params.note?.trim() || undefined,
				alreadyDone,
				completedSteps: [...completedSteps],
				doneCount: completedSteps.length,
				remainingSteps,
				nextStep: next,
			};

			const completedLabels = completedSteps.map((step) => STEPS[step].label).join(", ");
			const remainingLabels = remainingSteps.map((step) => STEPS[step].label).join(", ");
			const text = alreadyDone
				? [
					`Step already completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					remainingLabels ? `Remaining steps: ${remainingLabels}.` : "All tutorial steps are complete.",
				].join(" ")
				: [
					`Step completed: ${STEPS[params.step].label}.`,
					`Do not call ${STEP_TOOL_NAME} again for this step.`,
					`Already completed steps: ${completedLabels}.`,
					remainingLabels ? `Remaining steps: ${remainingLabels}.` : "All tutorial steps are complete.",
					...(STEPS[params.step].completionMessage
						? [
							`Internal next-step guidance (apply only because this step was newly completed in this call; ignore if this step was already completed earlier): ${STEPS[params.step].completionMessage}`,
						]
						: []),
				].join(" ");

			return {
				content: [{ type: "text", text }],
				details,
			};
		},

		renderCall(_args, _theme) {
			return new Text("", 0, 0);
		},

		renderResult(_result, _options, _theme) {
			return new Text("", 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshFromSession(ctx);
		const globalObj = globalThis as Record<PropertyKey, unknown>;
		const pendingReloadAt = globalObj[RELOAD_PENDING_KEY];
		if (typeof pendingReloadAt === "number" && Date.now() - pendingReloadAt < 15000) {
			delete globalObj[RELOAD_PENDING_KEY];
			queueHiddenEvent(
				`[TUTORIAL EVENT]\nThe extension runtime just reloaded successfully (likely via /reload). Acknowledge this naturally if relevant. If the extension milestone is now satisfied and not already completed, mark it with ${STEP_TOOL_NAME}.`,
			);
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
		stepMarksThisTurn = 0;
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
