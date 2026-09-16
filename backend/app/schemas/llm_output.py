from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictOutput(BaseModel):
    """LLM 输出严格基类。"""

    model_config = ConfigDict(extra="forbid")


class LlmTradeoff(StrictOutput):
    """模型输出的成员取舍。"""

    member: str = Field(..., min_length=1)
    gains: list[str] = Field(..., min_length=1)
    concessions: list[str] = Field(..., min_length=1)


class LlmPlanItem(StrictOutput):
    """模型输出的行程节点。"""

    start_time: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    end_time: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    place_id: str = Field(..., min_length=1)
    activity: str = Field(..., min_length=1)
    tags: list[str] = Field(default_factory=list)
    on_site_walking_km: float = Field(default=0, ge=0)
    estimated_cost: float = Field(default=0, ge=0)
    transport_mode: Literal["transit", "walking", "driving"] = "transit"
    participants: list[str] = Field(..., min_length=1)
    confirmation_status: Literal["pending", "confirmed"] | None = None
    reason: str = ""


class LlmPlanDay(StrictOutput):
    """模型输出的单日方案。"""

    day: int = Field(..., ge=1)
    theme: str = Field(..., min_length=1)
    items: list[LlmPlanItem] = Field(..., min_length=1, max_length=8)


class LlmItinerary(StrictOutput):
    """模型输出的行程主体。"""

    title: str = Field(..., min_length=1)
    estimated_budget_per_person: float = Field(..., ge=0)
    days: list[LlmPlanDay] = Field(..., min_length=1)


class LlmCandidate(StrictOutput):
    """模型输出的候选方案。"""

    id: Literal["plan-a", "plan-b", "plan-c"]
    title: str = Field(..., min_length=1)
    summary: str = Field(..., min_length=1)
    estimated_budget_per_person: float = Field(..., ge=0)
    itinerary: LlmItinerary
    member_tradeoffs: list[LlmTradeoff] = Field(..., min_length=1)
    assessment: dict | None = None


class LlmCandidatePackage(StrictOutput):
    """模型输出的严格顶层结构。"""

    candidates: list[LlmCandidate] = Field(..., min_length=3, max_length=3)

    @field_validator("candidates")
    @classmethod
    def validate_candidate_ids(cls, candidates: list[LlmCandidate]) -> list[LlmCandidate]:
        """要求三个候选 ID 严格为 plan-a、plan-b、plan-c。"""

        ids = [candidate.id for candidate in candidates]
        if ids != ["plan-a", "plan-b", "plan-c"]:
            raise ValueError("候选方案 ID 必须依次为 plan-a、plan-b、plan-c")
        return candidates
