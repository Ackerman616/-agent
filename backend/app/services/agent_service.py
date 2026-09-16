from decimal import Decimal
from typing import Any

from fastapi import status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.llm_client import llm_client
from app.common.tencent_map_client import map_client
from app.common.utils import new_id, safe_float
from app.models.member import TripMember
from app.models.plan import TravelPlan
from app.models.trip import Trip
from app.repositories.plan_repository import PlanRepository
from app.repositories.trip_repository import TripRepository
from app.schemas.llm_output import LlmCandidatePackage
from app.services.serializers import to_jsonable


def _member_tags(member: TripMember) -> list[str]:
    """读取成员正向偏好标签。"""

    preferences = member.soft_preferences or {}
    high = preferences.get("high", [])
    medium = preferences.get("medium", [])
    tags: list[str] = []
    for item in [*high, *medium]:
        tags.extend(item.get("tags", []))
    return list(dict.fromkeys(tags))


def _strictest_walking_members(members: list[TripMember]) -> tuple[list[str], float]:
    """找出步行上限最严格成员。"""

    minimum = min(safe_float(member.walking_limit_km) for member in members)
    names = [member.name for member in members if safe_float(member.walking_limit_km) == minimum]
    return names, minimum


def _must_visit_owner(members: list[TripMember]) -> TripMember:
    """找出必去诉求最多成员。"""

    return sorted(members, key=lambda item: len(item.must_visit or []), reverse=True)[0]


class AgentService:
    """分阶段共识 Agent 服务。"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.trip_repo = TripRepository(db)
        self.plan_repo = PlanRepository(db)

    def generate_candidates(self, trip_id: str) -> TravelPlan:
        """生成三种协商方向候选方案。"""

        trip = self.trip_repo.get(trip_id)
        if not trip:
            raise AppException(ErrorCode.E1004, http_status=status.HTTP_404_NOT_FOUND)
        if len(trip.members) < 2:
            raise AppException(ErrorCode.E1008, http_status=status.HTTP_400_BAD_REQUEST)

        evidence = self._collect_place_evidence(trip)
        candidates = self._generate_candidates_with_llm(trip, evidence)
        route_evidence = self._attach_route_evidence(candidates, evidence)
        evidence.extend(route_evidence)
        plan = TravelPlan(
            id=new_id(),
            trip_id=trip.id,
            status="needs_consensus",
            summary="已由真实 LLM 和腾讯地图证据生成三种协商方向。",
            candidates=candidates,
            evidence=evidence,
            final_plan=None,
        )
        trip.status = "planning"
        self.plan_repo.save(plan)
        self.db.commit()
        self.db.refresh(plan)
        return plan

    def get_plan(self, plan_id: str) -> TravelPlan:
        """获取方案。"""

        plan = self.plan_repo.get(plan_id)
        if not plan:
            raise AppException(ErrorCode.E1005, http_status=status.HTTP_404_NOT_FOUND)
        return plan

    def resolve_final_plan(self, plan_id: str, winner: dict) -> TravelPlan:
        """根据胜出方向收敛最终方案。"""

        plan = self.get_plan(plan_id)
        candidate = self._find_candidate(plan, winner["candidate_id"])
        final_plan = self._build_final_plan(plan.trip, candidate)
        assessment = self._assess_plan(plan.trip, final_plan)
        final_plan["assessment"] = assessment
        plan.final_plan = final_plan
        plan.resolved_candidate_id = candidate["id"]
        plan.status = "finalized" if assessment["verdict"] == "PASS" else "needs_consensus"
        self.db.commit()
        self.db.refresh(plan)
        return plan

    def _collect_place_evidence(self, trip: Trip) -> list[dict[str, Any]]:
        """按旅行需求调用腾讯地图搜索 POI。"""

        keywords = self._search_keywords(trip)
        evidence = []
        for keyword in keywords:
            result = map_client.search_places(keyword, trip.destination, page_size=5)
            places = []
            for item in result.get("places", []):
                location = item.get("location") or {}
                if "lat" not in location or "lng" not in location:
                    continue
                places.append(
                    {
                        "id": str(item.get("id")),
                        "title": item.get("title"),
                        "address": item.get("address"),
                        "category": item.get("category"),
                        "lat": location.get("lat"),
                        "lng": location.get("lng"),
                    }
                )
            evidence.append(
                {
                    "keyword": keyword,
                    "request_id": result.get("request_id"),
                    "source": result.get("source"),
                    "places": places,
                }
            )
        return evidence

    def _place_index(self, evidence: list[dict]) -> dict[str, dict]:
        """从地点证据构造 POI ID 索引。"""

        index = {}
        for block in evidence:
            for place in block.get("places", []):
                index[str(place.get("id"))] = place
        return index

    def _search_keywords(self, trip: Trip) -> list[str]:
        """根据旅行和成员需求生成地图检索关键词。"""

        keywords = [trip.origin, trip.destination]
        for member in trip.members:
            keywords.extend(member.must_visit or [])
            preferences = member.soft_preferences or {}
            labels = [item.get("label", "") for item in preferences.get("high", [])]
            labels += [item.get("label", "") for item in preferences.get("medium", [])]
            if any("美食" in label or "餐" in label for label in labels):
                keywords.append(f"{trip.destination}特色餐饮")
            if any("咖啡" in label for label in labels):
                keywords.append(f"{trip.destination}咖啡馆")
            if any("自然" in label or "公园" in label for label in labels):
                keywords.append(f"{trip.destination}城市公园")
        return list(dict.fromkeys([keyword for keyword in keywords if keyword]))[:8]

    def _generate_candidates_with_llm(self, trip: Trip, evidence: list[dict]) -> list[dict]:
        """调用真实 LLM 生成三种候选方案。"""

        definitions = self._candidate_definitions(trip)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是多人共识旅行 Agent。你必须只输出严格合法的 json object。"
                    "第一个字符必须是 {，最后一个字符必须是 }，禁止 Markdown。"
                ),
            },
            {
                "role": "user",
                "content": self._candidate_prompt(trip, definitions, evidence),
            },
        ]
        result = llm_client.chat_json(messages, max_tokens=6000)
        try:
            package = LlmCandidatePackage.model_validate(result)
        except ValidationError as exc:
            raise AppException(
                ErrorCode.E1016,
                message="模型输出不符合候选方案 Schema",
                details=exc.errors(),
            )
        candidates = [item.model_dump(exclude_none=True) for item in package.candidates]
        return [
            self._normalize_llm_candidate(trip, definitions[index], candidates[index])
            for index in range(3)
        ]

    def _candidate_prompt(
        self,
        trip: Trip,
        definitions: list[dict],
        evidence: list[dict],
    ) -> str:
        """构造候选方案生成提示词。"""

        allowed_places = [
            {"id": place["id"], "title": place["title"]}
            for block in evidence
            for place in block.get("places", [])
        ]
        schema_text = {
            "candidates": [
                {
                    "id": "plan-a",
                    "title": "字符串",
                    "summary": "字符串",
                    "estimated_budget_per_person": 0,
                    "itinerary": {
                        "title": "字符串",
                        "estimated_budget_per_person": 0,
                        "days": [
                            {
                                "day": 1,
                                "theme": "字符串",
                                "items": [
                                    {
                                        "start_time": "10:00",
                                        "end_time": "11:00",
                                        "place_id": "只能使用 allowed_places 中的 id",
                                        "activity": "字符串",
                                        "tags": ["culture"],
                                        "on_site_walking_km": 0,
                                        "estimated_cost": 0,
                                        "transport_mode": "transit",
                                        "participants": ["成员姓名"],
                                        "confirmation_status": "confirmed",
                                        "reason": "字符串",
                                    }
                                ],
                            }
                        ],
                    },
                    "member_tradeoffs": [
                        {"member": "成员姓名", "gains": ["字符串"], "concessions": ["字符串"]}
                    ],
                    "assessment": {},
                }
            ]
        }
        return (
            "请输出 raw json，不能输出 Markdown，不能输出代码块，不能输出解释。"
            "响应第一个字符必须是 {，最后一个字符必须是 }。"
            "顶层只能有 candidates 一个字段；candidates 必须恰好包含 3 个对象。"
            "三个候选 id 必须严格依次为 plan-a、plan-b、plan-c。"
            "每个候选必须严格符合 schema，不允许增加 schema 以外字段。"
            f"schema 示例：{to_jsonable(schema_text)}。"
            "每个候选每天最多 4 个节点，每个节点描述尽量短。"
            "plan-a 必须对应协商方向列表第 1 项，plan-b 对应第 2 项，plan-c 对应第 3 项。"
            "所有 place_id 必须来自 allowed_places 的 id，不能使用地点名称替代 id。"
            "participants 必须使用旅行信息中的成员姓名。"
            "tags 只能使用 culture、history、photo、food、relax、nature、night、shopping。"
            "transport_mode 只能从 transit、walking、driving 三个英文值中选择。"
            "禁止输出 walk、bus、subway、taxi、公共交通、步行、打车等其他值。"
            f"旅行信息：{to_jsonable(self._trip_snapshot(trip))}。"
            f"协商方向：{definitions}。"
            f"allowed_places：{allowed_places[:24]}。"
        )

    def _normalize_llm_candidate(
        self,
        trip: Trip,
        definition: dict,
        candidate: dict,
    ) -> dict:
        """合并模型输出和确定性协商元数据。"""

        base = self._candidate_payload(trip, definition)
        itinerary = candidate.get("itinerary") or base["itinerary"]
        assessment = candidate.get("assessment") or base["assessment"]
        return {
            **base,
            "title": candidate.get("title") or base["title"],
            "summary": candidate.get("summary") or base["summary"],
            "estimated_budget_per_person": candidate.get(
                "estimated_budget_per_person",
                base["estimated_budget_per_person"],
            ),
            "itinerary": itinerary,
            "member_tradeoffs": candidate.get("member_tradeoffs") or base["member_tradeoffs"],
            "assessment": assessment,
        }

    def _attach_route_evidence(self, candidates: list[dict], evidence: list[dict]) -> list[dict]:
        """为候选方案补充相邻节点路线证据。"""

        place_index = self._place_index(evidence)
        route_evidence = []
        seen = set()
        for candidate in candidates:
            for day in candidate.get("itinerary", {}).get("days", []):
                items = day.get("items", [])
                self._hydrate_item_places(items, place_index)
                for index in range(1, len(items)):
                    from_place = items[index - 1].get("place") or {}
                    to_place = items[index].get("place") or {}
                    if not self._has_coordinates(from_place) or not self._has_coordinates(to_place):
                        continue
                    key = (from_place.get("id"), to_place.get("id"))
                    if key in seen or key[0] == key[1]:
                        continue
                    seen.add(key)
                    result = map_client.get_route("transit", from_place, to_place)
                    route = (result.get("routes") or [{}])[0]
                    items[index]["transport_from_previous"] = {
                        "mode": "TRANSIT",
                        "duration_min": route.get("duration"),
                        "source_request_id": result.get("request_id"),
                    }
                    route_evidence.append(
                        {
                            "source": result.get("source"),
                            "request_id": result.get("request_id"),
                            "from": from_place.get("title"),
                            "to": to_place.get("title"),
                            "routes": result.get("routes", [])[:3],
                        }
                    )
        return route_evidence

    def _hydrate_item_places(self, items: list[dict], place_index: dict[str, dict]) -> None:
        """将模型地点引用补全为真实 POI。"""

        for item in items:
            key = str(item.get("place_id") or "")
            matched = place_index.get(key)
            if not matched:
                raise AppException(
                    ErrorCode.E1016,
                    message="模型输出了不在证据列表中的 place_id",
                    details={"place_id": key},
                )
            item["place"] = matched

    def _has_coordinates(self, place: dict) -> bool:
        """检查地点是否有经纬度。"""

        return place.get("lat") is not None and place.get("lng") is not None

    def _trip_snapshot(self, trip: Trip) -> dict:
        """生成给模型使用的旅行快照。"""

        return {
            "destination": trip.destination,
            "origin": trip.origin,
            "days": trip.days,
            "nights": trip.nights,
            "return_deadline": trip.return_deadline,
            "members": [
                {
                    "name": member.name,
                    "budget_max": member.budget_max,
                    "walking_limit_km": member.walking_limit_km,
                    "earliest_start": member.earliest_start,
                    "latest_end": member.latest_end,
                    "pace": member.pace,
                    "must_visit": member.must_visit,
                    "forbidden": member.forbidden,
                    "dietary_rules": member.dietary_rules,
                    "soft_preferences": member.soft_preferences,
                    "additional_notes": member.additional_notes,
                }
                for member in trip.members
            ],
        }

    def _candidate_definitions(self, trip: Trip) -> list[dict]:
        """构造三类协商候选定义。"""

        owner = _must_visit_owner(trip.members)
        walking_names, walking_limit = _strictest_walking_members(trip.members)
        proposed_walking = max(walking_limit + 2, round(walking_limit * 1.5, 1))
        all_names = [member.name for member in trip.members]
        downgraded = (owner.must_visit or [])[: max(1, len(owner.must_visit or []) // 2)]
        return [
            {
                "id": "plan-a",
                "negotiation_direction": "subgroup",
                "negotiation_label": "确认分组支线",
                "required_confirmations": all_names,
                "relaxed_constraints": ["默认全员同行"],
                "summary": "保留共同主线，由高诉求成员完成个人或分组支线。",
            },
            {
                "id": "plan-b",
                "negotiation_direction": "downgrade_must_visit",
                "negotiation_label": "降低部分必去等级",
                "required_confirmations": [owner.name],
                "relaxed_constraints": [f"{owner.name} 的 {','.join(downgraded)} 降级"],
                "summary": "保持全员同行，减少必须覆盖地点数量。",
            },
            {
                "id": "plan-c",
                "negotiation_direction": "relax_walking",
                "negotiation_label": "放宽步行上限",
                "required_confirmations": walking_names,
                "relaxed_constraints": [
                    f"{','.join(walking_names)} 步行上限放宽到 {proposed_walking}km"
                ],
                "summary": "保留更多共同景点，需相关成员确认增加步行。",
            },
        ]

    def _build_candidates(self, trip: Trip) -> list[dict]:
        """构造三类协商候选。"""

        owner = _must_visit_owner(trip.members)
        walking_names, walking_limit = _strictest_walking_members(trip.members)
        proposed_walking = max(walking_limit + 2, round(walking_limit * 1.5, 1))
        all_names = [member.name for member in trip.members]
        downgraded = (owner.must_visit or [])[: max(1, len(owner.must_visit or []) // 2)]
        definitions = [
            {
                "id": "plan-a",
                "negotiation_direction": "subgroup",
                "negotiation_label": "确认分组支线",
                "required_confirmations": all_names,
                "relaxed_constraints": ["默认全员同行"],
                "summary": "保留共同主线，由高诉求成员完成个人或分组支线。",
            },
            {
                "id": "plan-b",
                "negotiation_direction": "downgrade_must_visit",
                "negotiation_label": "降低部分必去等级",
                "required_confirmations": [owner.name],
                "relaxed_constraints": [f"{owner.name} 的 {','.join(downgraded)} 降级"],
                "summary": "保持全员同行，减少必须覆盖地点数量。",
            },
            {
                "id": "plan-c",
                "negotiation_direction": "relax_walking",
                "negotiation_label": "放宽步行上限",
                "required_confirmations": walking_names,
                "relaxed_constraints": [
                    f"{','.join(walking_names)} 步行上限放宽到 {proposed_walking}km"
                ],
                "summary": "保留更多共同景点，需相关成员确认增加步行。",
            },
        ]
        return [self._candidate_payload(trip, item) for item in definitions]

    def _candidate_payload(self, trip: Trip, definition: dict) -> dict:
        """生成候选方案数据。"""

        members = trip.members
        member_scores = self._member_scores(members)
        return {
            **definition,
            "title": definition["negotiation_label"],
            "estimated_budget_per_person": self._minimum_budget(members),
            "itinerary": self._itinerary_template(trip, definition),
            "member_tradeoffs": self._tradeoffs(members, definition),
            "assessment": {
                "verdict": "NEEDS_CONFIRMATION",
                "hard_violation_count": 0,
                "hard_violations": [],
                "member_scores": member_scores,
                "fairness_floor": min(item["preference_score"] for item in member_scores),
            },
        }

    def _itinerary_template(self, trip: Trip, definition: dict) -> dict:
        """创建可后续被地图 Agent 补证的行程骨架。"""

        days = []
        for day_index in range(1, trip.days + 1):
            days.append(
                {
                    "day": day_index,
                    "theme": definition["negotiation_label"],
                    "items": [
                        {
                            "start_time": "10:00",
                            "end_time": "12:00",
                            "place": {"title": trip.destination, "id": None},
                            "activity": "按协商方向生成待补证主线活动",
                            "tags": ["culture", "relax"],
                            "participants": [member.name for member in trip.members],
                            "reason": definition["summary"],
                        }
                    ],
                }
            )
        return {
            "title": definition["negotiation_label"],
            "days": days,
            "estimated_budget_per_person": self._minimum_budget(trip.members),
        }

    def _build_final_plan(self, trip: Trip, candidate: dict) -> dict:
        """根据已确认方向生成最终方案占位结构。"""

        final_plan = candidate["itinerary"].copy()
        final_plan["confirmed_negotiation"] = {
            "direction": candidate["negotiation_direction"],
            "relaxed_constraints": candidate["relaxed_constraints"],
            "required_confirmations": candidate["required_confirmations"],
        }
        final_plan["member_tradeoffs"] = candidate["member_tradeoffs"]
        return final_plan

    def _assess_plan(self, trip: Trip, final_plan: dict) -> dict:
        """执行轻量确定性校验。"""

        budget = safe_float(final_plan.get("estimated_budget_per_person"))
        minimum_budget = self._minimum_budget(trip.members)
        violations = []
        if budget > minimum_budget:
            violations.append("最终方案超过团队最低预算")
        return {
            "verdict": "PASS" if not violations else "REPLAN_REQUIRED",
            "hard_violation_count": len(violations),
            "hard_violations": violations,
        }

    def _member_scores(self, members: list[TripMember]) -> list[dict]:
        """计算成员偏好初始分。"""

        scores = []
        for member in members:
            tags = _member_tags(member)
            score = 70 if tags else 60
            scores.append(
                {
                    "member": member.name,
                    "preference_score": score,
                    "matched": tags[:3],
                    "missed": [],
                }
            )
        return scores

    def _tradeoffs(self, members: list[TripMember], definition: dict) -> list[dict]:
        """生成成员取舍说明。"""

        return [
            {
                "member": member.name,
                "gains": ["获得一个可投票的协商方向"],
                "concessions": definition["relaxed_constraints"],
            }
            for member in members
        ]

    def _minimum_budget(self, members: list[TripMember]) -> float:
        """返回团队最低预算。"""

        return min(safe_float(member.budget_max) for member in members)

    def _find_candidate(self, plan: TravelPlan, candidate_id: str) -> dict:
        """查找候选方案。"""

        for candidate in plan.candidates:
            if candidate["id"] == candidate_id:
                return candidate
        raise AppException(ErrorCode.E1013, http_status=status.HTTP_404_NOT_FOUND)


def plan_to_dict(plan: TravelPlan) -> dict:
    """方案模型转响应字典。"""

    return to_jsonable(
        {
            "id": plan.id,
            "trip_id": plan.trip_id,
            "status": plan.status,
            "summary": plan.summary,
            "candidates": plan.candidates,
            "evidence": plan.evidence,
            "final_plan": plan.final_plan,
            "resolved_candidate_id": plan.resolved_candidate_id,
        }
    )
