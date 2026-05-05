# Templates

Importable observability-tool dashboards that consume the spans pi-otel emits.

## SigNoz

`signoz/pi-overview.json` — high-level view: LLM call rate, p95 latency, token
usage, cost by model, tool-call rate, recent agent turns.

**Import**

1. Open SigNoz → **Dashboards** → **New dashboard** → **Import JSON**.
2. Paste the file contents (or upload).
3. Pick the time range (defaults to the last 30 minutes).

The dashboard uses a `service` variable; if you set `OTEL_SERVICE_NAME` to
something other than `pi`, change the variable's default in **Variables**.

Some panel queries (`gen_ai.tool.name`, `gen_ai.usage.cost_usd`, etc.) only
populate after pi-otel sees relevant spans, so let pi run a few prompts before
expecting full panels.
