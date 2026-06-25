---
name: tokenomics
description: Get fresh, live LLM pricing and cost estimates via the tokenomics CLI or MCP server.
---

# tokenomics — live LLM pricing for agents

Prices come live from the OpenRouter Models API (400+ models). There is no local
database and no cache to refresh — every call reflects current data.

## Units (read this first)

- **All token prices are USD per 1,000,000 tokens.** A value of `2.5` means $2.50 per 1M tokens.
- `estimate`/`estimate_cost` take **raw token counts** (e.g. `1000000`), not millions.
- `output_per_mtok: null` means the model is non-generative (embeddings/rerankers); output tokens cost $0.

## Rules

- Use `--output json` (or rely on the default: JSON whenever output is piped) and parse it.
- Add `--fields a,b,c` to every `search` to keep responses small (masks the rows under `models`).
- Resolve real model ids with `search` before `get`/`estimate`. Model ids are `provider/model`, e.g. `openai/gpt-4o`.
- For "which is cheaper for my workload", use `compare` / `compare_models` — it does the math; don't compute prices yourself.
- Model and provider ids are plain identifiers: no `?`, `#`, `%`, `/`-prefixed paths, or query params.
- On `MODEL_NOT_FOUND`, read `details.suggestions` or run `search`; do not invent ids.

## CLI quickstart

```bash
tokenomics search "gpt" --max-input 1 --fields model_id,pricing --output json
tokenomics get openai/gpt-4o
tokenomics estimate openai/gpt-4o --input-tokens 1000000 --output-tokens 200000 --requests 10
tokenomics compare --models openai/gpt-4o,google/gemini-2.5-flash --input-tokens 1000000 --output-tokens 500000
tokenomics providers
tokenomics schema estimate   # JSON Schema for any command's input
```

## MCP tools

`search_models`, `get_model_pricing`, `estimate_cost`, `compare_models` — all read-only.
Each returns JSON with `fetched_at`. No write/refresh tool exists because data is always live.
