from fastapi import status
from sqlalchemy.orm import Session

from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.utils import new_id
from app.models.member import TripMember
from app.models.trip import Trip
from app.repositories.trip_repository import TripRepository
from app.schemas.trip import TripCreate
from app.services.serializers import to_jsonable


class TripService:
    """旅行服务。"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.trip_repo = TripRepository(db)

    def create_trip(self, payload: TripCreate) -> Trip:
        """创建旅行和成员。"""

        names = [member.name for member in payload.members]
        if len(set(names)) != len(names):
            raise AppException(ErrorCode.E1007, http_status=status.HTTP_400_BAD_REQUEST)

        trip = Trip(
            id=new_id(),
            destination=payload.destination,
            origin=payload.origin,
            start_at=payload.start_at,
            days=payload.days,
            nights=payload.nights,
            return_deadline=payload.return_deadline,
            status="created",
            raw_request=payload.model_dump(mode="json"),
            note=payload.note,
        )
        for member in payload.members:
            trip.members.append(
                TripMember(
                    id=new_id(),
                    name=member.name,
                    budget_max=member.budget_max,
                    walking_limit_km=member.walking_limit_km,
                    earliest_start=member.earliest_start,
                    latest_end=member.latest_end,
                    pace=member.pace,
                    must_visit=member.must_visit,
                    forbidden=member.forbidden,
                    dietary_rules=member.dietary_rules.model_dump(mode="json"),
                    soft_preferences=member.soft_preferences.model_dump(mode="json"),
                    additional_notes=member.additional_notes,
                )
            )
        self.trip_repo.save(trip)
        self.db.commit()
        self.db.refresh(trip)
        return trip

    def get_trip(self, trip_id: str) -> Trip:
        """获取旅行详情。"""

        trip = self.trip_repo.get(trip_id)
        if not trip:
            raise AppException(ErrorCode.E1004, http_status=status.HTTP_404_NOT_FOUND)
        return trip

    def list_recent(self, limit: int = 20) -> list[Trip]:
        """获取近期旅行。"""

        return self.trip_repo.list_recent(limit)


def trip_to_dict(trip: Trip) -> dict:
    """旅行模型转响应字典。"""

    return to_jsonable(
        {
            "id": trip.id,
            "destination": trip.destination,
            "origin": trip.origin,
            "start_at": trip.start_at,
            "days": trip.days,
            "nights": trip.nights,
            "return_deadline": trip.return_deadline,
            "status": trip.status,
            "note": trip.note,
            "members": [
                {
                    "id": member.id,
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
    )
