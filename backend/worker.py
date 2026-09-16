import argparse
import logging
import signal
import time

from app.common.database import SessionLocal
from app.repositories.task_repository import TaskRepository
from app.services.task_service import run_plan_task

logger = logging.getLogger("consensus_travel_worker")
logging.basicConfig(level=logging.INFO)

_SHOULD_STOP = False


def _handle_signal(signum, frame) -> None:  # noqa: ARG001
    """处理退出信号。"""

    global _SHOULD_STOP
    _SHOULD_STOP = True


def poll_pending_task_ids(limit: int) -> list[str]:
    """从数据库读取待处理任务 ID。"""

    db = SessionLocal()
    try:
        tasks = TaskRepository(db).list_pending(limit)
        return [task.id for task in tasks]
    finally:
        db.close()


def run_worker(interval_seconds: float, batch_size: int, once: bool) -> None:
    """启动独立 Worker 循环。"""

    logger.info("worker started interval=%s batch_size=%s", interval_seconds, batch_size)
    while not _SHOULD_STOP:
        task_ids = poll_pending_task_ids(batch_size)
        if not task_ids and once:
            break
        for task_id in task_ids:
            if _SHOULD_STOP:
                break
            logger.info("run task id=%s", task_id)
            run_plan_task(task_id)
        if once:
            break
        time.sleep(interval_seconds)
    logger.info("worker stopped")


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""

    parser = argparse.ArgumentParser(description="Consensus Travel Agent Worker")
    parser.add_argument("--interval", type=float, default=2.0, help="轮询间隔秒数")
    parser.add_argument("--batch-size", type=int, default=3, help="单轮处理任务数")
    parser.add_argument("--once", action="store_true", help="只执行一轮后退出")
    return parser.parse_args()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    args = parse_args()
    run_worker(args.interval, args.batch_size, args.once)
