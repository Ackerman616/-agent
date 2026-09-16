import json
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings

settings = get_settings()


def _json_dumps(value: object) -> str:
    """数据库 JSON 序列化，保留中文字符。"""

    return json.dumps(value, ensure_ascii=False)


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_recycle=settings.db_pool_recycle,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    json_serializer=_json_dumps,
    json_deserializer=json.loads,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


class Base(DeclarativeBase):
    """SQLAlchemy 模型基类。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 数据库会话依赖。"""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
