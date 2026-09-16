from datetime import datetime, time
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class PreferenceItem(BaseModel):
    """单项软偏好。"""

    label: str
    tags: list[str] = Field(default_factory=list)


class SoftPreferences(BaseModel):
    """三级软偏好。"""

    high: list[PreferenceItem] = Field(default_factory=list)
    medium: list[PreferenceItem] = Field(default_factory=list)
    low: list[str] = Field(default_factory=list)


class DietaryRules(BaseModel):
    """饮食与健康限制。"""

    notes: list[str] = Field(default_factory=list)
    forbidden_keywords: list[str] = Field(default_factory=list)


class MemberCreate(BaseModel):
    """创建成员请求。"""

    name: str = Field(..., min_length=1, max_length=64)
    budget_max: Decimal = Field(..., gt=0)
    walking_limit_km: Decimal = Field(..., gt=0)
    earliest_start: time
    latest_end: time
    pace: Literal["relaxed", "balanced", "tight"] = "balanced"
    must_visit: list[str] = Field(default_factory=list)
    forbidden: list[str] = Field(default_factory=list)
    dietary_rules: DietaryRules = Field(default_factory=DietaryRules)
    soft_preferences: SoftPreferences = Field(default_factory=SoftPreferences)
    additional_notes: str | None = Field(default=None, max_length=2000)

    @field_validator("latest_end")
    @classmethod
    def validate_time_window(cls, latest_end: time, info):
        """校验成员时间窗口。"""

        earliest_start = info.data.get("earliest_start")
        if earliest_start and latest_end <= earliest_start:
            raise ValueError("最晚结束时间必须晚于最早出发时间")
        return latest_end


class TripCreate(BaseModel):
    """创建旅行请求。"""

    destination: str = Field(..., min_length=1, max_length=128)
    origin: str = Field(..., min_length=1, max_length=128)
    start_at: datetime
    days: int = Field(..., ge=1, le=14)
    nights: int = Field(default=0, ge=0, le=13)
    return_deadline: time
    members: list[MemberCreate] = Field(..., min_length=2, max_length=8)
    note: str | None = Field(default=None, max_length=2000)


class MemberRead(MemberCreate):
    """成员响应。"""

    id: str


class TripRead(BaseModel):
    """旅行响应。"""

    id: str
    destination: str
    origin: str
    start_at: datetime
    days: int
    nights: int
    return_deadline: time
    status: str
    note: str | None = None
    members: list[MemberRead]
