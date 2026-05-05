import type {
	BeforeProviderRequestEvent,
	CompactionEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
} from "@mariozechner/pi-coding-agent";

// Locally typed mirrors of events not re-exported from the package entry.
interface AfterProviderResponseEventLike {
	status: number;
	headers?: Record<string, string>;
}
interface MessageEndEventLike {
	message: unknown;
}
interface ToolExecutionStartEventLike {
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
}
interface ToolExecutionEndEventLike {
	toolName?: string;
	toolCallId?: string;
	result?: unknown;
	isError?: boolean;
}
import {
	context,
	type Context,
	type Counter,
	type Histogram,
	type Meter,
	SpanKind,
	SpanStatusCode,
	trace,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
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
	tracesEndpoint: string;
	metricsEndpoint: string;
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

function resolveTracesEndpoint(settings: OtelSettings): string {
	const explicit =
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? settings.endpoint;
	if (explicit) return explicit;
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (base) return `${base.replace(/\/$/, "")}/v1/traces`;
	return "http://localhost:4318/v1/traces";
}

function resolveMetricsEndpoint(tracesEndpoint: string): string {
	const explicit = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	if (explicit) return explicit;
	const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (base) return `${base.replace(/\/$/, "")}/v1/metrics`;
	return tracesEndpoint.replace(/\/v1\/traces$/, "/v1/metrics");
}

function loadSettings(pi: ExtensionAPI): ResolvedSettings {
	const raw =
		(pi as unknown as { getSettings?: () => unknown }).getSettings?.() ??
		undefined;
	const fromFile: OtelSettings =
		raw && typeof raw === "object" && "otel" in raw
			? ((raw as { otel: OtelSettings }).otel ?? {})
			: {};

	const tracesEndpoint = resolveTracesEndpoint(fromFile);
	return {
		tracesEndpoint,
		metricsEndpoint: resolveMetricsEndpoint(tracesEndpoint),
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

function errorFromToolResult(result: unknown): Error | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part && typeof part === "object") {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") {
					return new Error(truncate(p.text, 1024));
				}
			}
		}
	}
	const details = (result as { details?: unknown }).details;
	if (details && typeof details === "object") {
		const e = (details as { error?: unknown }).error;
		if (typeof e === "string") return new Error(e);
	}
	return new Error("tool error");
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(pi);
	let lastError: string | undefined;
	let exportedSpans = 0;
	let exportedMetricBatches = 0;

	const resource = new Resource({
		[SEMRESATTRS_SERVICE_NAME]: settings.service,
		[SEMRESATTRS_SERVICE_VERSION]: "0.1.0",
		"pi.extension": "pi-otel",
		...settings.resourceAttributes,
	});

	const traceExporter = new OTLPTraceExporter({
		url: settings.tracesEndpoint,
		headers: settings.headers,
	});

	const origExport = traceExporter.export.bind(traceExporter);
	traceExporter.export = (spans, resultCallback) => {
		origExport(spans, (result) => {
			if (result.code === 0) {
				exportedSpans += spans.length;
				lastError = undefined;
			} else {
				lastError = result.error?.message ?? "trace export failed";
			}
			resultCallback(result);
		});
	};

	const spanProcessor: SpanProcessor = new BatchSpanProcessor(traceExporter, {
		maxExportBatchSize: 64,
		scheduledDelayMillis: 1000,
	});

	const tracerProvider = new NodeTracerProvider({ resource });
	if (!settings.disabled) tracerProvider.addSpanProcessor(spanProcessor);
	tracerProvider.register();
	const tracer: Tracer = trace.getTracer("pi-otel", "0.1.0");

	const metricExporter = new OTLPMetricExporter({
		url: settings.metricsEndpoint,
		headers: settings.headers,
	});
	const origMetricExport = metricExporter.export.bind(metricExporter);
	metricExporter.export = (metrics, resultCallback) => {
		origMetricExport(metrics, (result) => {
			if (result.code === 0) {
				exportedMetricBatches += 1;
			} else {
				lastError = result.error?.message ?? "metric export failed";
			}
			resultCallback(result);
		});
	};

	const metricReader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 5000,
	});
	const meterProvider = new MeterProvider({
		resource,
		readers: settings.disabled ? [] : [metricReader],
	});
	const meter: Meter = meterProvider.getMeter("pi-otel", "0.1.0");

	const tokenUsage: Counter = meter.createCounter(
		"gen_ai.client.token.usage",
		{ description: "Tokens used in LLM operations", unit: "{token}" },
	);
	const opDuration: Histogram = meter.createHistogram(
		"gen_ai.client.operation.duration",
		{ description: "Duration of LLM operations", unit: "s" },
	);
	const costUsd: Counter = meter.createCounter("gen_ai.client.cost", {
		description: "LLM operation cost in USD as reported by the provider/pi",
		unit: "USD",
	});
	const toolCalls: Counter = meter.createCounter("pi.tool.calls", {
		description: "Tool invocations",
		unit: "{call}",
	});
	const toolDuration: Histogram = meter.createHistogram("pi.tool.duration", {
		description: "Duration of tool executions",
		unit: "ms",
	});
	const compactions: Counter = meter.createCounter("pi.session.compactions", {
		description: "Session compaction events",
		unit: "{event}",
	});
	const retries: Counter = meter.createCounter("pi.provider.retries", {
		description: "Provider HTTP attempts after the first within a single LLM request",
		unit: "{event}",
	});
	const cancellations: Counter = meter.createCounter("pi.turn.cancellations", {
		description: "Agent turns cancelled via abort signal",
		unit: "{event}",
	});

	let sessionSpan: Span | undefined;
	let sessionCtx: Context | undefined;

	let turnSpan: Span | undefined;
	let turnCtx: Context | undefined;
	let turnIndex = 0;

	let providerSpan: Span | undefined;
	let providerStart = 0;
	let providerAttempt = 0;
	let providerModel = "unknown";
	let providerSystem = "unknown";

	const toolSpans = new Map<
		string,
		{ span: Span; start: number; toolName: string }
	>();

	function markCancelled(span: Span) {
		span.setAttribute("pi.cancelled", true);
		span.setStatus({ code: SpanStatusCode.ERROR, message: "cancelled" });
	}

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
			markCancelled(span);
			span.end();
		});
		toolSpans.clear();
		if (turnSpan) {
			markCancelled(turnSpan);
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
		Promise.allSettled([
			spanProcessor.forceFlush(),
			metricReader.forceFlush(),
		]).then(() => {
			meterProvider.shutdown().catch(() => {});
		});
	}

	pi.on("session_start", async (event, ctx) => {
		if (sessionSpan) return;
		startSession(ctx, event.reason);
	});

	pi.on("session_shutdown", async (event) => {
		endSession(event.reason);
	});

	pi.on("session_compact", async (event: SessionCompactEvent) => {
		const entry: CompactionEntry = event.compactionEntry;
		const attrs: Record<string, string | number | boolean> = {
			"pi.compaction.from_extension": Boolean(event.fromExtension),
		};
		if (typeof entry?.tokensBefore === "number")
			attrs["pi.compaction.tokens_before"] = entry.tokensBefore;
		if (typeof entry?.summary === "string")
			attrs["pi.compaction.summary_chars"] = entry.summary.length;
		sessionSpan?.addEvent("pi.session.compact", attrs);
		compactions.add(1, {
			"pi.compaction.from_extension": String(Boolean(event.fromExtension)),
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
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

		const signal = ctx.signal;
		if (signal && !signal.aborted) {
			signal.addEventListener(
				"abort",
				() => {
					if (turnSpan) markCancelled(turnSpan);
					if (providerSpan) markCancelled(providerSpan);
					toolSpans.forEach(({ span }) => markCancelled(span));
					cancellations.add(1);
				},
				{ once: true },
			);
		}
	});

	pi.on("agent_end", async () => {
		if (turnSpan) {
			turnSpan.end();
			turnSpan = undefined;
			turnCtx = undefined;
		}
	});

	pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx) => {
		const parent = turnCtx ?? sessionCtx ?? context.active();
		const model = ctx.model;
		providerSystem = model?.provider ?? "unknown";
		providerModel = model?.id ?? "unknown";
		providerAttempt = 0;

		providerSpan = tracer.startSpan(
			`gen_ai.chat ${providerModel}`,
			{
				kind: SpanKind.CLIENT,
				attributes: {
					"gen_ai.system": providerSystem,
					"gen_ai.operation.name": "chat",
					"gen_ai.request.model": providerModel,
				},
			},
			parent,
		);
		providerStart = Date.now();

		if (settings.captureContent) {
			const text = asString(event.payload);
			if (text) providerSpan.setAttribute("gen_ai.prompt", truncate(text));
		}
	});

	pi.on("after_provider_response", (event: AfterProviderResponseEventLike) => {
		if (!providerSpan) return;
		providerAttempt += 1;
		providerSpan.setAttribute("http.response.status_code", event.status);

		const reqId =
			event.headers?.["request-id"] ?? event.headers?.["x-request-id"];
		if (reqId) providerSpan.setAttribute("gen_ai.response.id", reqId);

		if (event.status >= 400) {
			providerSpan.addEvent("gen_ai.provider.error", {
				"http.response.status_code": event.status,
				"pi.attempt": providerAttempt,
			});
			providerSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: `HTTP ${event.status}`,
			});
		}

		if (providerAttempt > 1) {
			providerSpan.addEvent("gen_ai.provider.retry", {
				"http.response.status_code": event.status,
				"pi.attempt": providerAttempt,
			});
			retries.add(1, {
				"gen_ai.system": providerSystem,
				"gen_ai.request.model": providerModel,
				"http.response.status_code": String(event.status),
			});
		}
	});

	pi.on("message_end", async (event: MessageEndEventLike) => {
		if (!providerSpan) return;
		const message = event.message;
		const role = (message as { role?: string } | undefined)?.role;
		if (role !== "assistant") return;

		const baseAttrs = {
			"gen_ai.system": providerSystem,
			"gen_ai.request.model": providerModel,
		};

		const usage = readUsage(message);
		if (usage) {
			if (typeof usage.input === "number") {
				providerSpan.setAttribute("gen_ai.usage.input_tokens", usage.input);
				tokenUsage.add(usage.input, { ...baseAttrs, "gen_ai.token.type": "input" });
			}
			if (typeof usage.output === "number") {
				providerSpan.setAttribute("gen_ai.usage.output_tokens", usage.output);
				tokenUsage.add(usage.output, { ...baseAttrs, "gen_ai.token.type": "output" });
			}
			if (typeof usage.cacheRead === "number") {
				providerSpan.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheRead);
				tokenUsage.add(usage.cacheRead, { ...baseAttrs, "gen_ai.token.type": "cache_read" });
			}
			if (typeof usage.cacheWrite === "number") {
				providerSpan.setAttribute("gen_ai.usage.cache_write_tokens", usage.cacheWrite);
				tokenUsage.add(usage.cacheWrite, { ...baseAttrs, "gen_ai.token.type": "cache_write" });
			}
			if (typeof usage.cost?.total === "number") {
				providerSpan.setAttribute("gen_ai.usage.cost_usd", usage.cost.total);
				costUsd.add(usage.cost.total, baseAttrs);
			}
		}

		const finish = (message as { stopReason?: string } | undefined)?.stopReason;
		if (finish) providerSpan.setAttribute("gen_ai.response.finish_reasons", finish);

		const respModel = (message as { model?: { id?: string } } | undefined)?.model
			?.id;
		if (respModel) providerSpan.setAttribute("gen_ai.response.model", respModel);

		if (settings.captureContent) {
			const text = extractTextFromMessage(message);
			if (text) providerSpan.setAttribute("gen_ai.completion", truncate(text));
		}

		const latencyMs = Date.now() - providerStart;
		providerSpan.setAttribute("pi.provider.latency_ms", latencyMs);
		providerSpan.setAttribute("pi.provider.attempts", providerAttempt);
		opDuration.record(latencyMs / 1000, baseAttrs);
		providerSpan.end();
		providerSpan = undefined;
	});

	pi.on("tool_execution_start", async (event: ToolExecutionStartEventLike) => {
		const parent = turnCtx ?? sessionCtx ?? context.active();
		const toolName = event.toolName ?? "unknown";
		const toolCallId = event.toolCallId ?? "";

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
			const text = asString(event.args);
			if (text) span.setAttribute("gen_ai.tool.arguments", truncate(text));
		}
		toolSpans.set(toolCallId, { span, start: Date.now(), toolName });
	});

	pi.on("tool_execution_end", async (event: ToolExecutionEndEventLike) => {
		const toolCallId = event.toolCallId ?? "";
		const entry = toolSpans.get(toolCallId);
		if (!entry) return;
		toolSpans.delete(toolCallId);
		const isError = Boolean(event.isError);
		const durMs = Date.now() - entry.start;
		entry.span.setAttribute("pi.tool.duration_ms", durMs);

		const labels = {
			"gen_ai.tool.name": entry.toolName,
			error: String(isError),
		};
		toolCalls.add(1, labels);
		toolDuration.record(durMs, labels);

		if (isError) {
			const err = errorFromToolResult(event.result) ?? new Error("tool error");
			entry.span.recordException(err);
			entry.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		}
		if (settings.captureContent) {
			const text = asString(event.result);
			if (text) entry.span.setAttribute("gen_ai.tool.result", truncate(text));
		}
		entry.span.end();
	});

	pi.registerCommand("otel-status", {
		description: "Show OpenTelemetry exporter status",
		handler: async (_args, ctx) => {
			const lines = [
				`traces endpoint:    ${settings.tracesEndpoint}`,
				`metrics endpoint:   ${settings.metricsEndpoint}`,
				`service:            ${settings.service}`,
				`disabled:           ${settings.disabled}`,
				`captureContent:     ${settings.captureContent}`,
				`exported spans:     ${exportedSpans}`,
				`exported metrics:   ${exportedMetricBatches} batch(es)`,
				`open tool spans:    ${toolSpans.size}`,
				`active turn:        ${turnSpan ? "yes" : "no"}`,
				`provider attempts:  ${providerAttempt}`,
				`last error:         ${lastError ?? "none"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("otel-flush", {
		description: "Force-flush pending OpenTelemetry spans and metrics",
		handler: async (_args, ctx) => {
			try {
				await Promise.all([
					spanProcessor.forceFlush(),
					metricReader.forceFlush(),
				]);
				ctx.ui.notify(
					`Flushed. spans=${exportedSpans} metric_batches=${exportedMetricBatches}${
						lastError ? ` (last error: ${lastError})` : ""
					}`,
					lastError ? "warning" : "info",
				);
			} catch (e) {
				ctx.ui.notify(`Flush failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
