from sqlalchemy import DateTime, Integer, String, Text, Time, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.common.database import Base


class Trip(Base):
    """旅行主表。"""

    __tablename__ = "trips"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    destination: Mapped[str] = mapped_column(String(128), nullable=False)
    origin: Mapped[str] = mapped_column(String(128), nullable=False)
    start_at: Mapped[object] = mapped_column(DateTime, nullable=False)
    days: Mapped[int] = mapped_column(Integer, nullable=False)
    nights: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    return_deadline: Mapped[object] = mapped_column(Time, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="created")
    raw_request: Mapped[dict] = mapped_column(JSON, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[object] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
    )

    members = relationship(
        "TripMember",
        back_populates="trip",
        cascade="all, delete-orphan",
    )
    plans = relationship("TravelPlan", back_populates="trip")
