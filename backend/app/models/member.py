from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, Time, UniqueConstraint, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.common.database import Base


class TripMember(Base):
    """同行成员表。"""

    __tablename__ = "trip_members"
    __table_args__ = (
        UniqueConstraint("trip_id", "name", name="uk_trip_member_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    trip_id: Mapped[str] = mapped_column(String(36), ForeignKey("trips.id"))
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    budget_max: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    walking_limit_km: Mapped[Decimal] = mapped_column(Numeric(6, 2), nullable=False)
    earliest_start: Mapped[object] = mapped_column(Time, nullable=False)
    latest_end: Mapped[object] = mapped_column(Time, nullable=False)
    pace: Mapped[str] = mapped_column(String(32), nullable=False)
    must_visit: Mapped[list] = mapped_column(JSON, nullable=False)
    forbidden: Mapped[list] = mapped_column(JSON, nullable=False)
    dietary_rules: Mapped[dict] = mapped_column(JSON, nullable=False)
    soft_preferences: Mapped[dict] = mapped_column(JSON, nullable=False)
    additional_notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[object] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
    )

    trip = relationship("Trip", back_populates="members")
    votes = relationship("PlanVote", back_populates="member")
