from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.common.database import Base


class TravelPlan(Base):
    """旅行方案表。"""

    __tablename__ = "travel_plans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    trip_id: Mapped[str] = mapped_column(String(36), ForeignKey("trips.id"))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    candidates: Mapped[list] = mapped_column(JSON, nullable=False)
    evidence: Mapped[list] = mapped_column(JSON, nullable=False)
    final_plan: Mapped[dict | None] = mapped_column(JSON)
    resolved_candidate_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[object] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
    )

    trip = relationship("Trip", back_populates="plans")
    votes = relationship(
        "PlanVote",
        back_populates="plan",
        cascade="all, delete-orphan",
    )
