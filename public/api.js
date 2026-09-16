const DEFAULT_API_BASE = 'http://127.0.0.1:8000/api/v1';

export class ApiError extends Error {
  constructor(message, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.payload = payload;
    this.code = payload?.error?.code || null;
  }
}

export function getApiBase() {
  return localStorage.getItem('api-base-url') || DEFAULT_API_BASE;
}

export function setApiBase(value) {
  const nextValue = String(value || '').trim().replace(/\/$/, '');
  localStorage.setItem('api-base-url', nextValue || DEFAULT_API_BASE);
  return getApiBase();
}

async function request(path, options = {}) {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new ApiError(message, payload);
  }
  return payload?.data ?? payload;
}

export const api = {
  health() {
    return request('/health');
  },

  createTrip(payload) {
    return request('/trips', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  createPlanTask(tripId) {
    return request(`/trips/${tripId}/plan-tasks`, { method: 'POST' });
  },

  getTask(taskId) {
    return request(`/tasks/${taskId}`);
  },

  getPlan(planId) {
    return request(`/plans/${planId}`);
  },

  submitVote(planId, payload) {
    return request(`/plans/${planId}/votes`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getVotes(planId) {
    return request(`/plans/${planId}/votes`);
  },

  resolvePlan(planId) {
    return request(`/plans/${planId}/resolve`, { method: 'POST' });
  },
};
