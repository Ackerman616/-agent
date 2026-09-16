import json
from typing import Any

import httpx

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.core.config import get_settings


class LlmClient:
    """OpenAI 兼容模型客户端。"""

    def __init__(self) -> None:
        self.settings = get_settings()

    def chat_json(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 6000,
        temperature: float = 0.1,
    ) -> dict[str, Any]:
        """调用模型并解析 JSON。"""

        if not self.settings.model_api_key:
            raise AppException(ErrorCode.E1016, message="模型 API Key 未配置")

        payload = {
            "model": self.settings.model_name,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
        }
        url = f"{self.settings.model_base_url.rstrip('/')}/chat/completions"
        headers = {"Authorization": f"Bearer {self.settings.model_api_key}"}

        try:
            with httpx.Client(timeout=self.settings.model_timeout_seconds) as client:
                response = client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPError as exc:
            raise AppException(ErrorCode.E1017, message="模型服务调用失败", details=str(exc))

        content = data.get("choices", [{}])[0].get("message", {}).get("content")
        if not content:
            raise AppException(ErrorCode.E1016, message="模型没有返回有效正文")
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise AppException(ErrorCode.E1016, message="模型返回不是合法 JSON", details=str(exc))


llm_client = LlmClient()
