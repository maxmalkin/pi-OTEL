import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	context,
	type Context,
	SpanKind,
	SpanStatusCode,
	trace,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
	BatchSpanProcessor,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
	SEMRESATTRS_SERVICE_NAME,
	SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

interface OtelSettings {
	endpoint?: string;
	headers?: Record<string, string>;
	service?: string;
	resourceAttributes?: Record<string, string>;
	captureContent?: boolean;
	disabled?: boolean;
}

interface ResolvedSettings {
	endpoint: string;
	headers: Record<string, string>;
	service: string;
	resourceAttributes: Record<string, string>;
	captureContent: boolean;
	disabled: boolean;
}

function parseKv(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	const out: Record<string, string> = {};
	for (const part of raw.split(",")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}

function resolveEndpoint(settings: OtelSettings): string {
	const explicitTraces =
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? settings.endpoint;
	if (explicitTraces) return explicitTraces;
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (base) return `${base.replace(/\/$/, "")}/v1/traces`;
	return "http://localhost:4318/v1/traces";
}

function loadSettings(pi: ExtensionAPI): ResolvedSettings {
	const raw =
		(pi as unknown as { getSettings?: () => unknown }).getSettings?.() ??
		undefined;
	const fromFile: OtelSettings =
		raw && typeof raw === "object" && "otel" in raw
			? ((raw as { otel: OtelSettings }).otel ?? {})
			: {};

	return {
		endpoint: resolveEndpoint(fromFile),
		headers: {
			...(fromFile.headers ?? {}),
			...parseKv(process.env.OTEL_EXPORTER_OTLP_HEADERS),
		},
		service: process.env.OTEL_SERVICE_NAME ?? fromFile.service ?? "pi",
		resourceAttributes: {
			...(fromFile.resourceAttributes ?? {}),
			...parseKv(process.env.OTEL_RESOURCE_ATTRIBUTES),
		},
		captureContent:
			process.env.PI_OTEL_CAPTURE_CONTENT === "1" ||
			Boolean(fromFile.captureContent),
		disabled:
			process.env.PI_OTEL_DISABLED === "1" || Boolean(fromFile.disabled),
	};
}

function asString(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function truncate(s: string, max = 8192): string {
	return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max}b]`;
}

function extractTextFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const c = (message as { content?: unknown }).content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const part of c) {
		if (part && typeof part === "object") {
			const p = part as { type?: string; text?: string };
			if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
		}
	}
	return parts.join("\n");
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number; input?: number; output?: number };
}

function readUsage(message: unknown): UsageLike | undefined {
	if (!message || typeof message !== "object") return undefined;
	const u = (message as { usage?: unknown }).usage;
	if (!u || typeof u !== "object") return undefined;
	return u as UsageLike;
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(pi);
	let lastError: string | undefined;
	let exportedSpans = 0;

	const resource = new Resource({
		[SEMRESATTRS_SERVICE_NAME]: settings.service,
		[SEMRESATTRS_SERVICE_VERSION]: "0.1.0",
		"pi.extension": "pi-otel",
		...settings.resourceAttributes,
	});

	const exporter = new OTLPTraceExporter({
		url: settings.endpoint,
		headers: settings.headers,
	});

	const origExport = exporter.export.bind(exporter);
	exporter.export = (spans, resultCallback) => {
		origExport(spans, (result) => {
			if (result.code === 0) {
				exportedSpans += spans.length;
				lastError = undefined;
			} else {
				lastError = result.error?.message ?? "export failed";
			}
			resultCallback(result);
		});
	};

	const processor: SpanProcessor = new BatchSpanProcessor(exporter, {
		maxExportBatchSize: 64,
		scheduledDelayMillis: 1000,
	});

	const provider = new NodeTracerProvider({ resource });
	if (!settings.disabled) provider.addSpanProcessor(processor);
	provider.register();
	const tracer: Tracer = trace.getTracer("pi-otel", "0.1.0");

	let sessionSpan: Span | undefined;
	let sessionCtx: Context | undefined;

	let turnSpan: Span | undefined;
	let turnCtx: Context | undefined;
	let turnIndex = 0;

	let providerSpan: Span | undefined;
	let providerStart = 0;

	const toolSpans = new Map<string, { span: Span; start: number }>();

	function startSession(ctx: ExtensionContext, reason: string) {
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
		sessionSpan = tracer.startSpan("pi.session", {
			kind: SpanKind.INTERNAL,
			attributes: {
				"pi.session.reason": reason,
				"pi.session.file": sessionFile,
				"pi.cwd": ctx.cwd,
			},
		});
		sessionCtx = trace.setSpan(context.active(), sessionSpan);
	}

	function endSession(reason: string) {
		toolSpans.forEach(({ span }) => {
			span.setStatus({ code: SpanStatusCode.ERROR, message: "session shutdown" });
			span.end();
		});
		toolSpans.clear();
		if (turnSpan) {
			turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: "session shutdown" });
			turnSpan.end();
		}
		turnSpan = undefined;
		turnCtx = undefined;
		if (sessionSpan) {
			sessionSpan.setAttribute("pi.session.shutdown_reason", reason);
			sessionSpan.end();
		}
		sessionSpan = undefined;
		sessionCtx = undefined;
		processor.forceFlush().catch((e) => {
			lastError = (e as Error).message;
		});
	}

	pi.on("session_start", async (event, ctx) => {
		if (sessionSpan) return;
		startSession(ctx, event.reason);
	});

	pi.on("session_shutdown", async (event) => {
		endSession(event.reason);
	});

	pi.on("agent_start", async () => {
		const parent = sessionCtx ?? context.active();
		turnIndex += 1;
		turnSpan = tracer.startSpan(
			"pi.agent_turn",
			{
				kind: SpanKind.INTERNAL,
				attributes: { "pi.turn.index": turnIndex },
			},
			parent,
		);
		turnCtx = trace.setSpan(parent, turnSpan);
	});

	pi.on("agent_end", async () => {
		if (turnSpan) {
			turnSpan.end();
			turnSpan = undefined;
			turnCtx = undefined;
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const parent = turnCtx ?? sessionCtx ?? context.active();
		const model = ctx.model;
		const provider = model?.provider ?? "unknown";
		const modelId = model?.id ?? "unknown";

		providerSpan = tracer.startSpan(
			`gen_ai.chat ${modelId}`,
			{
				kind: SpanKind.CLIENT,
				attributes: {
					"gen_ai.system": provider,
					"gen_ai.operation.name": "chat",
					"gen_ai.request.model": modelId,
				},
			},
			parent,
		);
		providerStart = Date.now();

		if (settings.captureContent) {
			const payload = (event as unknown as { payload?: unknown }).payload;
			const text = asString(payload);
			if (text) providerSpan.setAttribute("gen_ai.prompt", truncate(text));
		}
	});

	pi.on("after_provider_response", (event) => {
		if (!providerSpan) return;
		const status = (event as unknown as { status?: number }).status;
		const headers = (event as unknown as { headers?: Record<string, string> }).headers;
		if (typeof status === "number") {
			providerSpan.setAttribute("http.response.status_code", status);
			if (status >= 400) {
				providerSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message: `HTTP ${status}`,
				});
			}
		}
		const reqId = headers?.["request-id"] ?? headers?.["x-request-id"];
		if (reqId) providerSpan.setAttribute("gen_ai.response.id", reqId);
	});

	pi.on("message_end", async (event) => {
		if (!providerSpan) return;
		const message = (event as unknown as { message?: unknown }).message;
		const role = (message as { role?: string } | undefined)?.role;
		if (role !== "assistant") return;

		const usage = readUsage(message);
		if (usage) {
			if (typeof usage.input === "number")
				providerSpan.setAttribute("gen_ai.usage.input_tokens", usage.input);
			if (typeof usage.output === "number")
				providerSpan.setAttribute("gen_ai.usage.output_tokens", usage.output);
			if (typeof usage.cacheRead === "number")
				providerSpan.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheRead);
			if (typeof usage.cacheWrite === "number")
				providerSpan.setAttribute("gen_ai.usage.cache_write_tokens", usage.cacheWrite);
			if (typeof usage.cost?.total === "number")
				providerSpan.setAttribute("gen_ai.usage.cost_usd", usage.cost.total);
		}

		const finish = (message as { stopReason?: string } | undefined)?.stopReason;
		if (finish) providerSpan.setAttribute("gen_ai.response.finish_reasons", finish);

		const respModel = (message as { model?: { id?: string } } | undefined)?.model?.id;
		if (respModel) providerSpan.setAttribute("gen_ai.response.model", respModel);

		if (settings.captureContent) {
			const text = extractTextFromMessage(message);
			if (text) providerSpan.setAttribute("gen_ai.completion", truncate(text));
		}

		providerSpan.setAttribute("pi.provider.latency_ms", Date.now() - providerStart);
		providerSpan.end();
		providerSpan = undefined;
	});

	pi.on("tool_execution_start", async (event) => {
		const parent = turnCtx ?? sessionCtx ?? context.active();
		const toolName = String((event as { toolName?: string }).toolName ?? "unknown");
		const toolCallId = String((event as { toolCallId?: string }).toolCallId ?? "");
		const args = (event as { args?: unknown }).args;

		const span = tracer.startSpan(
			`tool.${toolName}`,
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					"gen_ai.tool.name": toolName,
					"gen_ai.tool.call.id": toolCallId,
				},
			},
			parent,
		);
		if (settings.captureContent) {
			const text = asString(args);
			if (text) span.setAttribute("gen_ai.tool.arguments", truncate(text));
		}
		toolSpans.set(toolCallId, { span, start: Date.now() });
	});

	pi.on("tool_execution_end", async (event) => {
		const toolCallId = String((event as { toolCallId?: string }).toolCallId ?? "");
		const entry = toolSpans.get(toolCallId);
		if (!entry) return;
		toolSpans.delete(toolCallId);
		const isError = Boolean((event as { isError?: boolean }).isError);
		entry.span.setAttribute("pi.tool.duration_ms", Date.now() - entry.start);
		if (isError) {
			entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "tool error" });
		}
		if (settings.captureContent) {
			const result = (event as { result?: unknown }).result;
			const text = asString(result);
			if (text) entry.span.setAttribute("gen_ai.tool.result", truncate(text));
		}
		entry.span.end();
	});

	pi.registerCommand("otel-status", {
		description: "Show OpenTelemetry exporter status",
		handler: async (_args, ctx) => {
			const lines = [
				`endpoint:        ${settings.endpoint}`,
				`service:         ${settings.service}`,
				`disabled:        ${settings.disabled}`,
				`captureContent:  ${settings.captureContent}`,
				`exported spans:  ${exportedSpans}`,
				`open tool spans: ${toolSpans.size}`,
				`active turn:     ${turnSpan ? "yes" : "no"}`,
				`last error:      ${lastError ?? "none"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("otel-flush", {
		description: "Force-flush pending OpenTelemetry spans",
		handler: async (_args, ctx) => {
			try {
				await processor.forceFlush();
				ctx.ui.notify(
					`Flushed. Total exported: ${exportedSpans}${lastError ? ` (last error: ${lastError})` : ""}`,
					lastError ? "warning" : "info",
				);
			} catch (e) {
				ctx.ui.notify(`Flush failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
