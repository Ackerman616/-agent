from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.common.database import get_db
from app.common.response import ok
from app.services.task_service import TaskService, task_to_dict

router = APIRouter()


@router.post("/trips/{trip_id}/plan-tasks")
def create_plan_task(
    trip_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """创建异步方案生成任务。"""

    task = TaskService(db).create_plan_task(trip_id)
    return ok(request, task_to_dict(task))


@router.get("/tasks/{task_id}")
def get_task(
    task_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """查询异步任务状态。"""

    task = TaskService(db).get_task(task_id)
    return ok(request, task_to_dict(task))
