from typing import Any

from fastapi import Request
from pydantic import BaseModel, Field


class ApiResponse(BaseModel):
    """统一响应结构。"""

    success: bool
    request_id: str
    data: Any | None = None
    error: dict[str, Any] | None = None


def ok(request: Request, data: Any | None = None) -> dict[str, Any]:
    """构造成功响应。"""

    return ApiResponse(
        success=True,
        request_id=request.state.request_id,
        data=data,
    ).model_dump()


def fail(
    request_id: str,
    code: str,
    message: str,
    details: Any | None = None,
) -> dict[str, Any]:
    """构造失败响应。"""

    return ApiResponse(
        success=False,
        request_id=request_id,
        error={"code": code, "message": message, "details": details},
    ).model_dump()


class IdResponse(BaseModel):
    """只返回主键的响应。"""

    id: str = Field(..., description="资源 ID")
