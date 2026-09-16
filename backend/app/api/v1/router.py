from fastapi import APIRouter

from app.api.v1.endpoints import health, plans, tasks, trips

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(trips.router, prefix="/trips", tags=["trips"])
api_router.include_router(plans.router, prefix="/plans", tags=["plans"])
api_router.include_router(tasks.router, tags=["tasks"])
