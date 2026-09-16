from fastapi import status

from app.common.errors import ERROR_MESSAGES, ErrorCode


class AppException(Exception):
    """业务异常基类。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        http_status: int = status.HTTP_400_BAD_REQUEST,
        details: object | None = None,
    ) -> None:
        self.code = code
        self.message = message or ERROR_MESSAGES[code]
        self.http_status = http_status
        self.details = details
        super().__init__(self.message)
