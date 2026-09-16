from sqlalchemy.orm import Session, selectinload

from app.models.trip import Trip


class TripRepository:
    """旅行仓储。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def save(self, trip: Trip) -> Trip:
        """保存旅行。"""

        self.db.add(trip)
        self.db.flush()
        return trip

    def get(self, trip_id: str) -> Trip | None:
        """查询旅行详情。"""

        return (
            self.db.query(Trip)
            .options(selectinload(Trip.members), selectinload(Trip.plans))
            .filter(Trip.id == trip_id)
            .first()
        )

    def list_recent(self, limit: int = 20) -> list[Trip]:
        """查询近期旅行。"""

        return (
            self.db.query(Trip)
            .options(selectinload(Trip.members))
            .order_by(Trip.created_at.desc())
            .limit(limit)
            .all()
        )
