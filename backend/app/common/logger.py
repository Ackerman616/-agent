import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import get_settings

settings = get_settings()
logger = logging.getLogger("consensus_travel")


def write_log_frame(
    db: Session | None,
    level: str,
    message: str,
    request_id: str | None = None,
    error_code: str | None = None,
    context: dict[str, Any] | None = None,
) -> None:
    """日志入库预留框架。"""

    logger.log(getattr(logging, level.upper(), logging.INFO), message)
    if not settings.log_to_database or db is None:
        return
    # P2：这里将写入 app_logs 表，当前先保留框架。
    # 后续接入异步队列，避免请求链路被日志写入阻塞。


def write_trace_frame(
    db: Session | None,
    trace_name: str,
    span_name: str,
    request_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """链路追踪入库预留框架。"""

    logger.debug("trace=%s span=%s request_id=%s", trace_name, span_name, request_id)
    if not settings.trace_to_database or db is None:
        return
    # P2：这里将写入 trace_logs 表，当前先保留框架。
