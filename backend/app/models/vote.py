from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.common.database import Base


class PlanVote(Base):
    """成员投票表。"""

    __tablename__ = "plan_votes"
    __table_args__ = (
        UniqueConstraint("plan_id", "member_id", name="uk_plan_member_vote"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    plan_id: Mapped[str] = mapped_column(String(36), ForeignKey("travel_plans.id"))
    member_id: Mapped[str] = mapped_column(String(36), ForeignKey("trip_members.id"))
    candidate_ids: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[object] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
    )

    plan = relationship("TravelPlan", back_populates="votes")
    member = relationship("TripMember", back_populates="votes")
