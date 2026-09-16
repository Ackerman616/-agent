from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.common.database import get_db
from app.common.response import ok
from app.schemas.trip import TripCreate
from app.services.agent_service import AgentService, plan_to_dict
from app.services.trip_service import TripService, trip_to_dict

router = APIRouter()


@router.post("")
def create_trip(
    payload: TripCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """创建旅行。"""

    trip = TripService(db).create_trip(payload)
    return ok(request, trip_to_dict(trip))


@router.get("")
def list_trips(
    request: Request,
    limit: int = 20,
    db: Session = Depends(get_db),
) -> dict:
    """查询近期旅行。"""

    trips = TripService(db).list_recent(limit)
    return ok(request, [trip_to_dict(trip) for trip in trips])


@router.get("/{trip_id}")
def get_trip(
    trip_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """查询旅行详情。"""

    trip = TripService(db).get_trip(trip_id)
    return ok(request, trip_to_dict(trip))


@router.post("/{trip_id}/plans")
def generate_plan(
    trip_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """生成三种协商候选方案。"""

    plan = AgentService(db).generate_candidates(trip_id)
    return ok(request, plan_to_dict(plan))
