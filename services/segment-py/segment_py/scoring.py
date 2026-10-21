"""Pure RFM segment scoring — no pandas, no numpy, no side effects.

Recency / Frequency / Monetary buckets → total score → hot/warm/cold tiers.
recommended_budget_usd is deterministic: segment_size × avg_score × 2.5.
"""

from __future__ import annotations

from datetime import date, datetime


def _days_since(date_str: str) -> int:
    """Compute calendar days between an ISO date string and today."""
    dt = datetime.fromisoformat(date_str).date()
    return (date.today() - dt).days


def _recency_score(days_since_last: int, inactive_days: int) -> int:
    """3 = recent, 2 = moderate, 1 = distant."""
    if days_since_last <= inactive_days:
        return 3
    if days_since_last <= inactive_days * 2:
        return 2
    return 1


def _frequency_score(purchase_count: int) -> int:
    """3 = loyal, 2 = regular, 1 = occasional."""
    if purchase_count >= 10:
        return 3
    if purchase_count >= 5:
        return 2
    return 1


def _monetary_score(ltv_usd: float) -> int:
    """3 = high-value, 2 = mid-value, 1 = low-value."""
    if ltv_usd >= 500:
        return 3
    if ltv_usd >= 100:
        return 2
    return 1


def _tier(total_score: int) -> str:
    """Map total RFM score (3–9) to a tier label."""
    if total_score >= 7:
        return "hot"
    if total_score >= 5:
        return "warm"
    return "cold"


def compute_rfm(customer: dict, inactive_days: int) -> dict:
    """Return per-customer RFM scores and tier.

    Expected *customer* keys: ``last_purchase_at`` (ISO date str),
    ``purchase_count`` (int, default 0), ``ltv_usd`` (float, default 0.0).
    """
    days = _days_since(customer["last_purchase_at"])
    r = _recency_score(days, inactive_days)
    f = _frequency_score(customer.get("purchase_count", 0))
    m = _monetary_score(customer.get("ltv_usd", 0.0))
    total = r + f + m
    return {"recency": r, "frequency": f, "monetary": m, "total": total, "tier": _tier(total)}


def score_segment(customers: list[dict], inactive_days: int) -> dict:
    """Score an entire customer segment with RFM analysis.

    Returns a dict with keys: ``segment_size``, ``avg_score``,
    ``tiers`` (``{"hot": n, "warm": n, "cold": n}``),
    ``recommended_budget_usd``.
    """
    if not customers:
        return {
            "segment_size": 0,
            "avg_score": 0.0,
            "tiers": {"hot": 0, "warm": 0, "cold": 0},
            "recommended_budget_usd": 0.0,
        }

    scores = [compute_rfm(c, inactive_days) for c in customers]
    total_score = sum(s["total"] for s in scores)
    segment_size = len(customers)
    avg_score = total_score / segment_size

    tiers: dict[str, int] = {"hot": 0, "warm": 0, "cold": 0}
    for s in scores:
        tiers[s["tier"]] += 1

    recommended_budget_usd = round(segment_size * avg_score * 2.5, 2)

    return {
        "segment_size": segment_size,
        "avg_score": round(avg_score, 2),
        "tiers": tiers,
        "recommended_budget_usd": recommended_budget_usd,
    }
