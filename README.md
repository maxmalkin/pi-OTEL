# pi-otel

[![CI](https://github.com/maxmalkin/pi-OTEL/actions/workflows/ci.yml/badge.svg)](https://github.com/maxmalkin/pi-OTEL/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenTelemetry harness for the [pi coding agent](https://pi.dev). Emits
GenAI-semconv spans for LLM and tool calls over OTLP/HTTP to any compatible
backend.

```
pi.session
└── pi.agent_turn
    ├── gen_ai.chat <model>
    └── tool.<name>
```

Attributes follow [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

## Install

```bash
pi install git:github.com/maxmalkin/pi-otel
```

Then `/reload` in pi.

## Configure

Standard OTel SDK env vars are honored:

| Var | Default |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — (`/v1/traces` appended) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v` |
| `OTEL_SERVICE_NAME` | `pi` |
| `OTEL_RESOURCE_ATTRIBUTES` | `k=v,k=v` |
| `PI_OTEL_DISABLED` | `0` |
| `PI_OTEL_CAPTURE_CONTENT` | `0` (prompts/completions/tool I/O) |

Falls back to `http://localhost:4318/v1/traces`. Same keys are accepted in
`settings.json` under `otel`.

## Backends

```bash
# SigNoz OSS — UI :8080, OTLP :4318
git clone --depth 1 https://github.com/SigNoz/signoz && \
  cd signoz/deploy/docker && docker compose up -d

# Jaeger all-in-one — UI :16686
docker run --rm -p 16686:16686 -p 4318:4318 \
  -e COLLECTOR_OTLP_ENABLED=true jaegertracing/all-in-one:latest

# Phoenix (LLM-eval) — UI :6006
docker run --rm -p 6006:6006 -p 4318:4318 arizephoenix/phoenix:latest
```

Hosted: set `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS`.

## Commands

- `/otel-status` — endpoint, exported span count, last error
- `/otel-flush` — force-flush pending spans

## License

MIT
