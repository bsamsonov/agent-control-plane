# segment-py

Python MCP server providing RFM (Recency / Frequency / Monetary) customer segment
scoring. Exposed via **Streamable HTTP** (`/mcp`) on port 3104.

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -q "mcp[cli]>=1.0" pytest
.venv/bin/pytest -q

# Run the server
.venv/bin/python -m segment_py.server
```

## Tools

| Tool              | Description                              |
|-------------------|------------------------------------------|
| `score_segment`   | Score a list of customers with RFM       |
| `explain_scoring` | Return a one-paragraph methodology note  |

### `score_segment` input

Each customer dict should have:
- `last_purchase_at` — ISO date string (required)
- `purchase_count` — integer (default 0)
- `ltv_usd` — float (default 0.0)

### `score_segment` output

```json
{
  "segment_size": 150,
  "avg_score": 6.2,
  "tiers": { "hot": 60, "warm": 50, "cold": 40 },
  "recommended_budget_usd": 2325.0
}
```

`recommended_budget_usd` is computed deterministically as
`segment_size × avg_score × 2.5`, rounded to 2 decimal places.
