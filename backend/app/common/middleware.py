import time
from uuid import uuid4

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


class RequestContextMiddleware(BaseHTTPMiddleware):
    """注入请求 ID 和耗时。"""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("X-Request-Id") or str(uuid4())
        request.state.request_id = request_id
        start_time = time.perf_counter()
        response = await call_next(request)
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Response-Time-Ms"] = str(duration_ms)
        return response
