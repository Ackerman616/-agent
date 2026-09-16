from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.response import fail


def register_exception_handlers(app: FastAPI) -> None:
    """注册全局异常处理。"""

    @app.exception_handler(AppException)
    async def handle_app_exception(
        request: Request,
        exc: AppException,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content=fail(
                request.state.request_id,
                exc.code.value,
                exc.message,
                exc.details,
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_exception(
        request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=fail(
                request.state.request_id,
                ErrorCode.E1001.value,
                "请求参数校验失败",
                exc.errors(),
            ),
        )

    @app.exception_handler(SQLAlchemyError)
    async def handle_database_exception(
        request: Request,
        exc: SQLAlchemyError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=fail(
                request.state.request_id,
                ErrorCode.E1010.value,
                "数据库操作失败",
                str(exc),
            ),
        )
