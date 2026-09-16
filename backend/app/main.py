import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.common.handlers import register_exception_handlers
from app.common.middleware import RequestContextMiddleware
from app.core.config import get_settings

logging.basicConfig(level=logging.INFO)
settings = get_settings()


def create_app() -> FastAPI:
    """创建 FastAPI 应用。"""

    app = FastAPI(
        title=settings.app_name,
        debug=settings.debug,
        version="0.1.0",
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_prefix)
    return app


app = create_app()
