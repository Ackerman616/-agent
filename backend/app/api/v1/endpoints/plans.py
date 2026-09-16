from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.common.database import get_db
from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.response import ok
from app.schemas.vote import VoteCreate
from app.services.agent_service import AgentService, plan_to_dict
from app.services.vote_service import VoteService

router = APIRouter()


@router.get("/{plan_id}")
def get_plan(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """查询方案详情。"""

    plan = AgentService(db).get_plan(plan_id)
    return ok(request, plan_to_dict(plan))


@router.post("/{plan_id}/votes")
def submit_vote(
    plan_id: str,
    payload: VoteCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """提交成员认可投票。"""

    snapshot = VoteService(db).submit_vote(
        plan_id,
        payload.member_id,
        payload.candidate_ids,
    )
    return ok(request, snapshot)


@router.get("/{plan_id}/votes")
def get_votes(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """查询投票快照。"""

    snapshot = VoteService(db).snapshot(plan_id)
    return ok(request, snapshot)


@router.post("/{plan_id}/resolve")
def resolve_plan(
    plan_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """按胜出协商方向收敛最终方案。"""

    snapshot = VoteService(db).snapshot(plan_id)
    if not snapshot["ready_for_replan"] or not snapshot["winner"]:
        raise AppException(ErrorCode.E1015, details=snapshot)
    plan = AgentService(db).resolve_final_plan(plan_id, snapshot["winner"])
    return ok(request, plan_to_dict(plan))
