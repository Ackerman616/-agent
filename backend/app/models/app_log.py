from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.common.database import Base


class AppLog(Base):
    """业务日志表，P2 启用。"""

    __tablename__ = "app_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    request_id: Mapped[str | None] = mapped_column(String(36))
    level: Mapped[str] = mapped_column(String(16), nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(16))
    message: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[dict | None] = mapped_column(JSON)
    path: Mapped[str | None] = mapped_column(String(255))
    method: Mapped[str | None] = mapped_column(String(16))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())


class TraceLog(Base):
    """链路追踪表，P2 启用。"""

    __tablename__ = "trace_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    request_id: Mapped[str | None] = mapped_column(String(36))
    trace_name: Mapped[str] = mapped_column(String(128), nullable=False)
    span_name: Mapped[str] = mapped_column(String(128), nullable=False)
    parent_span_id: Mapped[str | None] = mapped_column(String(64))
    metadata_json: Mapped[dict | None] = mapped_column(JSON)
    started_at: Mapped[object | None] = mapped_column(DateTime)
    ended_at: Mapped[object | None] = mapped_column(DateTime)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[object] = mapped_column(DateTime, server_default=func.now())
