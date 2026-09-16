from functools import lru_cache
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置。"""

    app_name: str = "consensus-travel-agent-api"
    app_env: str = "local"
    debug: bool = False
    api_prefix: str = "/api/v1"

    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_user: str = "root"
    mysql_password: str = ""
    mysql_database: str = "consensus_travel"
    mysql_charset: str = "utf8mb4"
    database_url: str | None = None

    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_pool_recycle: int = 1800

    log_to_database: bool = False
    trace_to_database: bool = False

    model_base_url: str = "https://api.deepseek.com"
    model_api_key: str = ""
    model_name: str = "deepseek-v4-flash"
    model_timeout_seconds: int = 180

    tencent_map_key: str = ""
    tencent_map_base_url: str = "https://apis.map.qq.com"
    tencent_map_timeout_seconds: int = 15

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def database_url(self) -> str:
        """返回数据库连接串，默认 MySQL，可配置为 SQLite 本地验证。"""

        if self.database_url:
            return self.database_url
        password = quote_plus(self.mysql_password)
        return (
            f"mysql+pymysql://{self.mysql_user}:{password}"
            f"@{self.mysql_host}:{self.mysql_port}/{self.mysql_database}"
            f"?charset={self.mysql_charset}"
        )


@lru_cache
def get_settings() -> Settings:
    """返回全局配置单例。"""

    return Settings()
