"""Thin FastMCP adapter exposing RFM scoring tools via Streamable HTTP (port 3104).

No auth — the server sits behind the control plane.
"""

from mcp.server.fastmcp import FastMCP

from .scoring import score_segment as _score_segment

mcp = FastMCP(
    name="segment-py",
    host="0.0.0.0",
    port=3104,
)


@mcp.tool()
def score_segment(customers: list[dict], inactive_days: int) -> dict:
    """Score a customer segment using RFM (Recency / Frequency / Monetary) analysis.

    Returns segment_size, avg_score, tier breakdown, and recommended_budget_usd.
    """
    return _score_segment(customers, inactive_days)


@mcp.tool()
def explain_scoring() -> str:
    """Return a one-paragraph explanation of the RFM scoring methodology."""
    return (
        "RFM (Recency, Frequency, Monetary) scoring evaluates customers on three dimensions. "
        "Recency measures days since last purchase, scored 1-3 relative to the inactive_days threshold. "
        "Frequency measures purchase count, scored 1-3 based on order volume. "
        "Monetary measures lifetime value (ltv_usd), scored 1-3 based on total spend. "
        "Total score (3-9) determines tier: hot (>=7), warm (>=5), cold (<5). "
        "Recommended budget is computed deterministically as segment_size × avg_score × 2.5."
    )


def main() -> None:
    """Entry point: start the MCP server on 0.0.0.0:3104."""
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
