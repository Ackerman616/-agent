import { api, getApiBase, setApiBase } from './api.js';

const interestOptions = [
  ['culture', '历史人文'],
  ['photo', '摄影街区'],
  ['food', '特色美食'],
  ['relax', '咖啡慢游'],
  ['nature', '公园自然'],
  ['night', '城市夜景'],
  ['shopping', '购物'],
  ['entertainment', '娱乐演出'],
];

const defaults = [
  {
    name: '成员1', budget: 1200, pace: 'balanced', walk: 8, earliest: '09:00', latest: '21:00',
    interests: ['culture', 'food'], mustVisit: '', forbidden: '', dietary: '', notes: '',
  },
  {
    name: '成员2', budget: 1000, pace: 'relaxed', walk: 6, earliest: '10:00', latest: '20:30',
    interests: ['relax', 'nature'], mustVisit: '', forbidden: '', dietary: '', notes: '',
  },
];

const state = {
  trip: null,
  plan: null,
  voting: null,
  selectedCandidateIndex: 0,
};

const dom = {
  apiBase: document.getElementById('apiBase'),
  members: document.getElementById('members'),
  addMemberBtn: document.getElementById('addMemberBtn'),
  runBtn: document.getElementById('runBtn'),
  blocked: document.getElementById('blocked'),
  events: document.getElementById('events'),
  result: document.getElementById('result'),
  resultTitle: document.getElementById('resultTitle'),
  resultSummary: document.getElementById('resultSummary'),
  sessionPill: document.getElementById('sessionPill'),
  candidateGrid: document.getElementById('candidateGrid'),
  votePanel: document.getElementById('votePanel'),
  metrics: document.getElementById('metrics'),
  constraintIssues: document.getElementById('constraintIssues'),
  days: document.getElementById('days'),
  tradeoffs: document.getElementById('tradeoffs'),
  evidence: document.getElementById('evidence'),
  runtimePill: document.getElementById('runtimePill'),
  modelPill: document.getElementById('modelPill'),
  mapPill: document.getElementById('mapPill'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function splitValues(value) {
  return String(value || '').split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean);
}

function setPill(element, ok, text) {
  element.textContent = text;
  element.className = `pill ${ok ? 'ok' : 'bad'}`;
}

function addEvent(kind, title, detail = '') {
  if (dom.events.querySelector('.empty')) dom.events.innerHTML = '';
  const element = document.createElement('div');
  element.className = `event ${kind}`;
  element.innerHTML = `<div class="event-kind">${escapeHtml(title)}</div>`
    + `<div class="event-body">${escapeHtml(detail).replace(/\n/g, '<br>')}</div>`;
  dom.events.appendChild(element);
  dom.events.scrollTop = dom.events.scrollHeight;
}

function memberCard(member, index) {
  const checks = interestOptions.map(([key, label]) => (
    `<label class="check"><input type="checkbox" data-interest="${key}" `
    + `${member.interests.includes(key) ? 'checked' : ''}>${label}</label>`
  )).join('');
  const id = member.id || crypto.randomUUID();
  return `<div class="member" data-member-id="${id}">`
    + `<div class="member-title"><input class="name" value="${escapeHtml(member.name)}">`
    + '<button class="remove-member" type="button">移除</button></div>'
    + '<div class="grid2">'
    + `<label>预算上限<input class="budget" type="number" min="0" value="${member.budget}"></label>`
    + `<label>节奏<select class="pace"><option value="relaxed" ${member.pace === 'relaxed' ? 'selected' : ''}>轻松</option>`
    + `<option value="balanced" ${member.pace === 'balanced' ? 'selected' : ''}>均衡</option>`
    + `<option value="tight" ${member.pace === 'tight' ? 'selected' : ''}>紧凑</option></select></label>`
    + `<label>步行上限 km<input class="walk" type="number" min="0" step="0.5" value="${member.walk}"></label>`
    + `<label>最早出发<input class="earliest" type="time" value="${member.earliest}"></label>`
    + `<label>最晚结束<input class="latest" type="time" value="${member.latest}"></label>`
    + '</div>'
    + `<div class="checks">${checks}</div>`
    + `<label style="margin-top:8px">必去地点<textarea class="must-visit">${escapeHtml(member.mustVisit)}</textarea></label>`
    + `<label style="margin-top:8px">绝不接受<textarea class="forbidden">${escapeHtml(member.forbidden)}</textarea></label>`
    + `<label style="margin-top:8px">饮食限制<textarea class="dietary">${escapeHtml(member.dietary)}</textarea></label>`
    + `<label style="margin-top:8px">补充描述<textarea class="notes">${escapeHtml(member.notes)}</textarea></label>`
    + '</div>';
}

function renderMembers(items) {
  dom.members.innerHTML = items.map(memberCard).join('');
}

function readTrip() {
  const members = [...document.querySelectorAll('.member')].map((card, index) => {
    const selected = [...card.querySelectorAll('[data-interest]:checked')].map(item => item.dataset.interest);
    const preferenceItems = selected.map(tag => ({
      label: interestOptions.find(item => item[0] === tag)?.[1] || tag,
      tags: [tag],
    }));
    return {
      id: card.dataset.memberId || `member-${index + 1}`,
      name: card.querySelector('.name').value.trim(),
      budget_max: Number(card.querySelector('.budget').value),
      pace: card.querySelector('.pace').value,
      walking_limit_km: Number(card.querySelector('.walk').value),
      earliest_start: card.querySelector('.earliest').value,
      latest_end: card.querySelector('.latest').value,
      must_visit: splitValues(card.querySelector('.must-visit').value),
      forbidden: splitValues(card.querySelector('.forbidden').value),
      dietary_rules: {
        notes: splitValues(card.querySelector('.dietary').value),
        forbidden_keywords: splitValues(card.querySelector('.dietary').value),
      },
      soft_preferences: { high: preferenceItems, medium: [], low: [] },
      additional_notes: card.querySelector('.notes').value.trim(),
    };
  });
  return {
    destination: document.getElementById('destination').value.trim(),
    origin: document.getElementById('origin').value.trim(),
    start_at: document.getElementById('startAt').value,
    days: 2,
    nights: 1,
    return_deadline: document.getElementById('deadline').value,
    members,
  };
}

async function pollTask(taskId) {
  for (let index = 0; index < 90; index += 1) {
    const task = await api.getTask(taskId);
    addEvent('success', 'TASK', `${task.status}${task.plan_id ? ` · ${task.plan_id}` : ''}`);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') throw new Error(task.error_message || task.error_code || '任务失败');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('任务超时');
}

async function runFlow() {
  dom.runBtn.disabled = true;
  dom.blocked.classList.remove('active');
  dom.result.classList.remove('active');
  dom.events.innerHTML = '';
  try {
    setApiBase(dom.apiBase.value);
    addEvent('success', 'CREATE', '创建旅行');
    state.trip = await api.createTrip(readTrip());
    addEvent('success', 'TRIP', state.trip.id);
    const task = await api.createPlanTask(state.trip.id);
    addEvent('success', 'TASK', `任务已创建 ${task.id}`);
    const finished = await pollTask(task.id);
    state.plan = finished.result || await api.getPlan(finished.plan_id);
    state.voting = null;
    renderPlan(state.plan);
  } catch (error) {
    showBlocked(error.message, error.code);
    addEvent('error', error.code || 'ERROR', error.message);
  } finally {
    dom.runBtn.disabled = false;
  }
}

function renderPlan(plan) {
  const candidates = plan.candidates || [];
  dom.result.classList.add('active');
  dom.resultTitle.textContent = candidates.length > 1 ? `${candidates.length} 个候选方案` : '旅行方案';
  dom.resultSummary.textContent = plan.summary || '';
  dom.sessionPill.textContent = `方案 ${String(plan.id).slice(0, 8)}`;
  dom.candidateGrid.innerHTML = candidates.map((candidate, index) => {
    const label = candidate.negotiation_label || candidate.title || `方案 ${index + 1}`;
    return `<button class="candidate-card ${index === 0 ? 'active' : ''}" data-index="${index}">`
      + `<span class="candidate-type">${escapeHtml(label)}</span>`
      + `<strong>${escapeHtml(candidate.title || label)}</strong>`
      + `<p>${escapeHtml(candidate.summary || '')}</p>`
      + `<span class="candidate-status">${escapeHtml((candidate.required_confirmations || []).join('、'))}</span>`
      + '</button>';
  }).join('');
  [...dom.candidateGrid.querySelectorAll('.candidate-card')].forEach(card => {
    card.addEventListener('click', () => renderCandidate(Number(card.dataset.index)));
  });
  renderVotePanel();
  renderCandidate(0);
}

function renderCandidate(index) {
  state.selectedCandidateIndex = index;
  const candidate = state.plan.candidates[index];
  const itinerary = candidate.itinerary || {};
  const assessment = candidate.assessment || {};
  [...dom.candidateGrid.children].forEach((card, cardIndex) => {
    card.classList.toggle('active', cardIndex === index);
  });
  dom.metrics.innerHTML = `<div class="metric"><span>人均预计</span><b>¥${candidate.estimated_budget_per_person ?? '—'}</b></div>`
    + `<div class="metric"><span>最低偏好满足度</span><b>${assessment.fairness_floor ?? '—'}%</b></div>`
    + `<div class="metric"><span>需要确认</span><b>${(candidate.required_confirmations || []).length}</b></div>`;
  const relaxed = candidate.relaxed_constraints || [];
  dom.constraintIssues.classList.toggle('active', relaxed.length > 0);
  dom.constraintIssues.innerHTML = relaxed.length
    ? `<b>${escapeHtml(candidate.negotiation_label)}</b><br>拟放宽：${escapeHtml(relaxed.join('、'))}`
    : '';
  dom.days.innerHTML = (itinerary.days || []).map(day => `<div class="day"><div class="dayhead">`
    + `<b>Day ${day.day} · ${escapeHtml(day.theme || '')}</b><span>${day.items?.length || 0} 个节点</span>`
    + `</div><div class="timeline">${(day.items || []).map(renderStop).join('')}</div></div>`).join('');
  dom.tradeoffs.innerHTML = (candidate.member_tradeoffs || []).map(item => `<div class="smallcard">`
    + `<b>${escapeHtml(item.member)}</b>获得：${escapeHtml((item.gains || []).join('、') || '—')}`
    + `<br>让步：${escapeHtml((item.concessions || []).join('、') || '—')}</div>`).join('');
  renderEvidence();
}

function renderStop(item) {
  const place = item.place || {};
  return `<div class="stop"><div class="stop-time">${item.start_time || ''}–${item.end_time || ''}</div>`
    + `<div><b>${escapeHtml(place.title || item.activity || '')}</b>`
    + `<p>${escapeHtml(item.reason || item.activity || '')}</p></div></div>`;
}

function renderEvidence() {
  dom.evidence.innerHTML = (state.plan.evidence || []).slice(0, 12).map(item => `<div class="smallcard">`
    + `<b>${escapeHtml(item.source || '证据')}</b>${escapeHtml(item.keyword || item.from || '')}`
    + `<br><span>${escapeHtml(item.request_id || '—')}</span></div>`).join('');
}

function renderVotePanel() {
  const candidates = state.plan?.candidates || [];
  const members = state.trip?.members || [];
  const tallies = state.voting?.tallies || {};
  const winner = state.voting?.winner;
  const message = winner
    ? `当前领先：${escapeHtml(winner.title)}（${winner.votes} 票）`
    : '等待成员投票';
  dom.votePanel.innerHTML = `<div class="vote-head"><div><b>协商方向认可投票</b>`
    + `<br><span>每人选择 1～2 个可接受方向。</span></div>`
    + `<span>${state.voting?.participation_count || 0}/${members.length} 人已投票</span></div>`
    + `<div class="vote-form"><select id="voteMember">${members.map(member => (
      `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`
    )).join('')}</select><div class="vote-options">${candidates.map(candidate => (
      `<label class="vote-option"><input type="checkbox" value="${escapeHtml(candidate.id)}">`
      + `${escapeHtml(candidate.negotiation_label || candidate.title)} · ${tallies[candidate.id] || 0}票</label>`
    )).join('')}</div><button id="voteSubmit" class="vote-submit">提交投票</button></div>`
    + `<div id="voteResult" class="vote-result">${message}`
    + `${state.voting?.ready_for_replan ? '<br><button id="resolveWinner" class="vote-submit">生成最终方案</button>' : ''}</div>`;
  dom.votePanel.querySelector('#voteSubmit')?.addEventListener('click', submitVote);
  dom.votePanel.querySelector('#resolveWinner')?.addEventListener('click', resolveWinner);
}

async function submitVote() {
  const memberId = dom.votePanel.querySelector('#voteMember').value;
  const candidateIds = [...dom.votePanel.querySelectorAll('.vote-option input:checked')].map(item => item.value);
  if (candidateIds.length < 1 || candidateIds.length > 2) {
    dom.votePanel.querySelector('#voteResult').textContent = '请选择 1～2 个方案。';
    return;
  }
  state.voting = await api.submitVote(state.plan.id, { member_id: memberId, candidate_ids: candidateIds });
  renderVotePanel();
}

async function resolveWinner() {
  const result = await api.resolvePlan(state.plan.id);
  state.plan = result;
  renderPlan(state.plan);
}

function showBlocked(message, code = '') {
  dom.blocked.textContent = `请求失败：${code ? `${code} · ` : ''}${message}`;
  dom.blocked.classList.add('active');
}

async function health() {
  try {
    setApiBase(dom.apiBase.value);
    const result = await api.health();
    setPill(dom.runtimePill, true, result.app_name || 'FastAPI 已连接');
    setPill(dom.modelPill, true, 'REST API');
    setPill(dom.mapPill, true, '异步任务');
  } catch (error) {
    setPill(dom.runtimePill, false, '后端未连接');
    setPill(dom.modelPill, false, 'API');
    setPill(dom.mapPill, false, '任务');
  }
}

dom.apiBase.value = getApiBase();
dom.apiBase.addEventListener('change', () => health());
dom.addMemberBtn.addEventListener('click', () => {
  const index = document.querySelectorAll('.member').length;
  if (index >= 8) return;
  const member = {
    name: `成员${index + 1}`, budget: 1200, pace: 'balanced', walk: 8,
    earliest: '09:00', latest: '21:00', interests: [], mustVisit: '',
    forbidden: '', dietary: '', notes: '',
  };
  dom.members.insertAdjacentHTML('beforeend', memberCard(member, index));
});
dom.members.addEventListener('click', event => {
  if (!event.target.classList.contains('remove-member')) return;
  if (document.querySelectorAll('.member').length <= 2) return;
  event.target.closest('.member').remove();
});
dom.runBtn.addEventListener('click', runFlow);
renderMembers(defaults);
health();
