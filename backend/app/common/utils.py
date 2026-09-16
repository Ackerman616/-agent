from datetime import datetime, timezone
from uuid import uuid4


def new_id() -> str:
    """生成字符串主键。"""

    return str(uuid4())


def utc_now() -> datetime:
    """返回 UTC 当前时间。"""

    return datetime.now(timezone.utc)


def safe_float(value: object, default: float = 0.0) -> float:
    """安全转换浮点数。"""

    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
