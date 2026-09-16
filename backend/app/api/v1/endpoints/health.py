from fastapi import APIRouter, Request

from app.common.response import ok
from app.core.config import get_settings

router = APIRouter()


@router.get("/health")
def health_check(request: Request) -> dict:
    """健康检查。"""

    settings = get_settings()
    return ok(
        request,
        {
            "ok": True,
            "app_name": settings.app_name,
            "environment": settings.app_env,
        },
    )
