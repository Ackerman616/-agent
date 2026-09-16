import logging

from fastapi import status
from sqlalchemy.orm import Session

from app.common.database import SessionLocal
from app.common.errors import ErrorCode
from app.common.exceptions import AppException
from app.common.utils import new_id, utc_now
from app.models.agent_task import AgentTask
from app.repositories.task_repository import TaskRepository
from app.services.agent_service import AgentService, plan_to_dict
from app.services.serializers import to_jsonable

logger = logging.getLogger("consensus_travel_worker")


class TaskService:
    """数据库驱动的轻量异步任务服务。"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.task_repo = TaskRepository(db)

    def create_plan_task(self, trip_id: str) -> AgentTask:
        """创建方案生成任务。"""

        task = AgentTask(
            id=new_id(),
            trip_id=trip_id,
            task_type="generate_plan",
            status="pending",
            payload={"trip_id": trip_id},
        )
        self.task_repo.save(task)
        self.db.commit()
        self.db.refresh(task)
        return task

    def get_task(self, task_id: str) -> AgentTask:
        """获取任务。"""

        task = self.task_repo.get(task_id)
        if not task:
            raise AppException(ErrorCode.E1021, http_status=status.HTTP_404_NOT_FOUND)
        return task

    def list_pending(self, limit: int = 5) -> list[AgentTask]:
        """获取待处理任务。"""

        return self.task_repo.list_pending(limit)


def run_plan_task(task_id: str) -> None:
    """后台执行方案生成任务。"""

    db = SessionLocal()
    try:
        task_repo = TaskRepository(db)
        task = task_repo.get(task_id)
        if not task or task.status != "pending":
            return
        task.status = "running"
        task.started_at = utc_now()
        db.commit()

        plan = AgentService(db).generate_candidates(task.trip_id)
        task.plan_id = plan.id
        task.status = "succeeded"
        task.result = plan_to_dict(plan)
        task.finished_at = utc_now()
        db.commit()
    except AppException as exc:
        task = TaskRepository(db).get(task_id)
        if task:
            task.status = "failed"
            task.error_code = exc.code.value
            task.error_message = exc.message
            task.finished_at = utc_now()
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.exception("task failed task_id=%s", task_id)
        task = TaskRepository(db).get(task_id)
        if task:
            task.status = "failed"
            task.error_code = ErrorCode.E1016.value
            task.error_message = str(exc)
            task.finished_at = utc_now()
            db.commit()
    finally:
        db.close()


def task_to_dict(task: AgentTask) -> dict:
    """任务模型转响应字典。"""

    return to_jsonable(
        {
            "id": task.id,
            "trip_id": task.trip_id,
            "plan_id": task.plan_id,
            "task_type": task.task_type,
            "status": task.status,
            "payload": task.payload,
            "result": task.result,
            "error_code": task.error_code,
            "error_message": task.error_message,
        }
    )
