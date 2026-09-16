from typing import Any

import httpx

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.core.config import get_settings


class TencentMapClient:
    """腾讯地图 WebService 通用客户端。"""

    def __init__(self) -> None:
        self.settings = get_settings()

    def search_places(
        self,
        keyword: str,
        city: str,
        page_size: int = 8,
    ) -> dict[str, Any]:
        """搜索城市内 POI。"""

        normalized_city = city.replace("市区", "").strip()
        payload = self._get(
            "/ws/place/v1/search",
            {
                "keyword": keyword,
                "boundary": f"region({normalized_city},1)",
                "page_size": min(max(page_size, 1), 12),
                "page_index": 1,
                "get_subpois": 0,
            },
        )
        return {
            "source": "腾讯地图地点搜索",
            "request_id": payload.get("request_id"),
            "keyword": keyword,
            "places": payload.get("data", []),
        }

    def get_route(
        self,
        mode: str,
        from_place: dict[str, Any],
        to_place: dict[str, Any],
        policy: str | None = None,
    ) -> dict[str, Any]:
        """查询两个地点间路线。"""

        mode = mode if mode in {"transit", "walking", "driving"} else "transit"
        params = {
            "from": f"{from_place['lat']},{from_place['lng']}",
            "to": f"{to_place['lat']},{to_place['lng']}",
            "from_poi": from_place.get("id"),
            "to_poi": to_place.get("id"),
        }
        if mode == "transit":
            params["policy"] = policy or "LEAST_WALKING"
            params["price_unit"] = 1
        elif mode == "driving":
            params["policy"] = "LEAST_TIME"
        payload = self._get(f"/ws/direction/v1/{mode}/", params)
        return {
            "source": f"腾讯地图{mode}路线",
            "request_id": payload.get("request_id"),
            "routes": payload.get("result", {}).get("routes", []),
        }

    def _get(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        """执行 GET 请求并校验状态。"""

        if not self.settings.tencent_map_key:
            raise AppException(ErrorCode.E1017, message="腾讯地图 Key 未配置")
        merged = {**params, "key": self.settings.tencent_map_key, "output": "json"}
        url = f"{self.settings.tencent_map_base_url.rstrip('/')}{endpoint}"
        try:
            with httpx.Client(timeout=self.settings.tencent_map_timeout_seconds) as client:
                response = client.get(url, params=merged)
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPError as exc:
            raise AppException(ErrorCode.E1017, message="腾讯地图调用失败", details=str(exc))
        if payload.get("status") != 0:
            raise AppException(
                ErrorCode.E1017,
                message="腾讯地图返回业务错误",
                details=payload.get("message"),
            )
        return payload


map_client = TencentMapClient()
