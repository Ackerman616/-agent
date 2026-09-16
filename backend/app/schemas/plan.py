from typing import Any

from pydantic import BaseModel, Field


class PlanRead(BaseModel):
    """旅行方案响应。"""

    id: str
    trip_id: str
    status: str
    summary: str | None = None
    candidates: list[dict[str, Any]]
    evidence: list[dict[str, Any]]
    final_plan: dict[str, Any] | None = None
    resolved_candidate_id: str | None = None


class CandidateRead(BaseModel):
    """候选方案摘要。"""

    id: str
    title: str
    negotiation_direction: str
    required_confirmations: list[str] = Field(default_factory=list)
    relaxed_constraints: list[str] = Field(default_factory=list)
