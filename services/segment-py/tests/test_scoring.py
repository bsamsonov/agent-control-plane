"""Unit tests for segment_py.scoring — pure RFM scoring functions."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from segment_py.scoring import _recency_score, _frequency_score, _monetary_score
from segment_py.scoring import _tier, compute_rfm, score_segment


# -- helpers ------------------------------------------------------------------

def _cust(last_purchase_days_ago: int, purchase_count: int = 0, ltv_usd: float = 0.0) -> dict:
    """Shorthand to build a customer dict with a back-dated purchase date."""
    d = date.today() - timedelta(days=last_purchase_days_ago)
    return {
        "id": f"c-{last_purchase_days_ago}-{purchase_count}",
        "email": "a@b.com",
        "last_purchase_at": d.isoformat(),
        "purchase_count": purchase_count,
        "ltv_usd": ltv_usd,
    }


# -- low-level bucket tests ---------------------------------------------------

class TestRecencyScore:
    def test_recent(self) -> None:
        assert _recency_score(5, 30) == 3  # within inactive_days

    def test_moderate(self) -> None:
        assert _recency_score(45, 30) == 2  # between 1× and 2× inactive_days

    def test_distant(self) -> None:
        assert _recency_score(100, 30) == 1  # beyond 2× inactive_days

    def test_boundary_at_threshold(self) -> None:
        assert _recency_score(30, 30) == 3  # exactly at inactive_days

    def test_boundary_at_double(self) -> None:
        assert _recency_score(60, 30) == 2  # exactly at 2× inactive_days

    def test_boundary_just_after_double(self) -> None:
        assert _recency_score(61, 30) == 1  # just past 2× threshold


class TestFrequencyScore:
    def test_loyal(self) -> None:
        assert _frequency_score(15) == 3

    def test_regular(self) -> None:
        assert _frequency_score(7) == 2

    def test_occasional(self) -> None:
        assert _frequency_score(2) == 1

    def test_boundary_at_10(self) -> None:
        assert _frequency_score(10) == 3

    def test_boundary_at_5(self) -> None:
        assert _frequency_score(5) == 2

    def test_boundary_below_5(self) -> None:
        assert _frequency_score(4) == 1


class TestMonetaryScore:
    def test_high_value(self) -> None:
        assert _monetary_score(1000.0) == 3

    def test_mid_value(self) -> None:
        assert _monetary_score(250.0) == 2

    def test_low_value(self) -> None:
        assert _monetary_score(50.0) == 1

    def test_boundary_at_500(self) -> None:
        assert _monetary_score(500.0) == 3

    def test_boundary_at_100(self) -> None:
        assert _monetary_score(100.0) == 2

    def test_boundary_below_100(self) -> None:
        assert _monetary_score(99.99) == 1


class TestTier:
    @pytest.mark.parametrize(
        ("total", "expected"),
        [(9, "hot"), (7, "hot"), (6, "warm"), (5, "warm"), (4, "cold"), (3, "cold")],
    )
    def test_tiers(self, total: int, expected: str) -> None:
        assert _tier(total) == expected


# -- compute_rfm ---------------------------------------------------------------

class TestComputeRfm:
    def test_hot_customer(self) -> None:
        c = _cust(last_purchase_days_ago=10, purchase_count=12, ltv_usd=600)
        r = compute_rfm(c, 30)
        assert r == {"recency": 3, "frequency": 3, "monetary": 3, "total": 9, "tier": "hot"}

    def test_warm_customer(self) -> None:
        c = _cust(last_purchase_days_ago=50, purchase_count=6, ltv_usd=200)
        r = compute_rfm(c, 30)
        assert r == {"recency": 2, "frequency": 2, "monetary": 2, "total": 6, "tier": "warm"}

    def test_cold_customer(self) -> None:
        c = _cust(last_purchase_days_ago=200, purchase_count=1, ltv_usd=10)
        r = compute_rfm(c, 30)
        assert r == {"recency": 1, "frequency": 1, "monetary": 1, "total": 3, "tier": "cold"}

    def test_missing_purchase_count_defaults_to_zero(self) -> None:
        c = _cust(last_purchase_days_ago=20)
        del c["purchase_count"]
        r = compute_rfm(c, 30)
        assert r["frequency"] == 1  # 0 purchases → occasional

    def test_missing_ltv_defaults_to_zero(self) -> None:
        c = _cust(last_purchase_days_ago=20)
        del c["ltv_usd"]
        r = compute_rfm(c, 30)
        assert r["monetary"] == 1  # 0 ltv → low-value


# -- score_segment -------------------------------------------------------------

class TestScoreSegment:
    def test_empty_input(self) -> None:
        result = score_segment([], 30)
        assert result == {
            "segment_size": 0,
            "avg_score": 0.0,
            "tiers": {"hot": 0, "warm": 0, "cold": 0},
            "recommended_budget_usd": 0.0,
        }

    def test_single_hot(self) -> None:
        result = score_segment([_cust(5, 20, 800)], 30)
        assert result["segment_size"] == 1
        assert result["avg_score"] == 9.0
        assert result["tiers"] == {"hot": 1, "warm": 0, "cold": 0}
        assert result["recommended_budget_usd"] == 22.5

    def test_single_cold(self) -> None:
        result = score_segment([_cust(500, 1, 5)], 30)
        assert result["segment_size"] == 1
        assert result["avg_score"] == 3.0
        assert result["tiers"] == {"hot": 0, "warm": 0, "cold": 1}
        assert result["recommended_budget_usd"] == 7.5

    def test_all_cold(self) -> None:
        customers = [_cust(500, 1, 5), _cust(400, 2, 10), _cust(300, 3, 20)]
        result = score_segment(customers, 30)
        assert result["segment_size"] == 3
        assert result["avg_score"] == 3.0  # all 1+1+1
        assert result["tiers"] == {"hot": 0, "warm": 0, "cold": 3}
        assert result["recommended_budget_usd"] == 22.5

    def test_mixed_tiers(self) -> None:
        customers = [
            _cust(5, 20, 800),    # hot   (9)
            _cust(50, 6, 200),    # warm  (6)
            _cust(400, 2, 10),    # cold  (3)
        ]
        result = score_segment(customers, 30)
        assert result["segment_size"] == 3
        assert result["avg_score"] == 6.0  # (9+6+3)/3
        assert result["tiers"] == {"hot": 1, "warm": 1, "cold": 1}
        assert result["recommended_budget_usd"] == 45.0

    def test_boundary_customers(self) -> None:
        """Customers sitting exactly at bucket boundaries."""
        # R: 30 days (at threshold) → 3; F: 5 purchases → 2; M: $100 → 2 → total 7 = hot
        # R: 60 days (at 2× threshold) → 2; F: 4 purchases → 1; M: $500 → 3 → total 6 = warm
        # R: 61 days (just past 2×) → 1; F: 10 → 3; M: $99.99 → 1 → total 5 = warm
        customers = [
            _cust(30, 5, 100),
            _cust(60, 4, 500),
            _cust(61, 10, 99.99),
        ]
        result = score_segment(customers, 30)
        assert result["segment_size"] == 3
        assert result["avg_score"] == 6.0  # (7+6+5)/3
        assert result["tiers"] == {"hot": 1, "warm": 2, "cold": 0}
        assert result["recommended_budget_usd"] == 45.0

    def test_large_segment(self) -> None:
        """Verify deterministic budget for a larger homogeneous segment."""
        customers = [_cust(10, 15, 1000) for _ in range(100)]
        result = score_segment(customers, 30)
        assert result["segment_size"] == 100
        assert result["avg_score"] == 9.0
        assert result["tiers"] == {"hot": 100, "warm": 0, "cold": 0}
        assert result["recommended_budget_usd"] == 2250.0  # 100 × 9 × 2.5

    def test_recommended_budget_rounding(self) -> None:
        """Budget should be rounded to 2 decimal places."""
        customers = [
            _cust(5, 10, 500),   # 3+3+3=9
            _cust(20, 5, 150),   # 3+2+2=7  → avg=8.0
        ]
        result = score_segment(customers, 30)
        assert result["recommended_budget_usd"] == 40.0  # 2 × 8.0 × 2.5
