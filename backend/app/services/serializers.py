from datetime import date, datetime, time
from decimal import Decimal
from typing import Any


def to_jsonable(value: Any) -> Any:
    """将数据库对象中的特殊类型转成 JSON 友好类型。"""

    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date | time):
        return value.isoformat()
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: to_jsonable(item) for key, item in value.items()}
    return value
