from typing import Any

from pydantic import BaseModel


class TaskRead(BaseModel):
    """异步任务响应。"""

    id: str
    trip_id: str
    plan_id: str | None = None
    task_type: str
    status: str
    payload: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
