import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const sessionsFile = path.join(dataDir, 'sessions.json');

const PORT = Number(process.env.PORT || 8787);
const MODEL_BASE_URL = (process.env.MODEL_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL_API_KEY = process.env.MODEL_API_KEY || '';
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-v4-flash';
const TENCENT_MAP_KEY = process.env.TENCENT_MAP_KEY || '';
const MAX_SEARCH_REQUESTS = Number(process.env.MAX_SEARCH_REQUESTS || 8);
const MAX_ROUTE_REQUESTS = Number(process.env.MAX_ROUTE_REQUESTS || 30);

await fs.mkdir(dataDir, { recursive: true });
try { await fs.access(sessionsFile); } catch { await fs.writeFile(sessionsFile, '{}', 'utf8'); }

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('请求体过大');
  }
  return raw ? JSON.parse(raw) : {};
}

async function readSessions() {
  return JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
}

async function saveSession(session) {
  const sessions = await readSessions();
  sessions[session.id] = session;
  await fs.writeFile(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
}

async function getSession(id) {
  const sessions = await readSessions();
  return sessions[id] || null;
}

function emit(res, event, data) {
  res.write(`${JSON.stringify({ event, at: new Date().toISOString(), data })}\n`);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const mapCache = new Map();
let lastMapRequestAt = 0;

async function mapGet(endpoint, params) {
  if (!TENCENT_MAP_KEY) throw new Error('TENCENT_MAP_KEY 未配置');
  const cacheKey = `${endpoint}?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)])).toString()}`;
  if (mapCache.has(cacheKey)) return { ...mapCache.get(cacheKey), cached: true };

  const elapsed = Date.now() - lastMapRequestAt;
  const waitMs = Math.max(0, 420 - elapsed);
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));

  const url = new URL(`https://apis.map.qq.com${endpoint}`);
  for (const [key, value] of Object.entries({ ...params, key: TENCENT_MAP_KEY, output: 'json' })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  lastMapRequestAt = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  if (!response.ok || payload.status !== 0) {
    throw new Error(`腾讯地图请求失败：${payload.message || response.status}`);
  }
  const result = { payload, requestId: payload.request_id || null };
  mapCache.set(cacheKey, result);
  return { ...result, cached: false };
}

async function searchPlaces(args) {
  const keyword = String(args.keyword || '').trim();
  if (!keyword) throw new Error('search_places.keyword 不能为空');
  const city = String(args.city || '').trim();
  if (!city) throw new Error('search_places.city 不能为空');
  const pageSize = Math.min(12, Math.max(1, safeNumber(args.page_size, 8)));
  let payload;
  let requestId;
  let source = '腾讯地图地点搜索（实时调用）';
  try {
    ({ payload, requestId } = await mapGet('/ws/place/v1/search', {
      keyword,
      boundary: `region(${city},1)`,
      page_size: pageSize,
      page_index: 1,
      get_subpois: 0
    }));
  } catch (error) {
    if (!error.message.includes('每日调用量已达到上限')) throw error;
    ({ payload, requestId } = await mapGet('/ws/place/v1/suggestion', {
      keyword,
      region: city,
      region_fix: 1,
      page_size: pageSize
    }));
    source = '腾讯地图关键词输入提示（实时备用检索）';
  }
  return {
    source,
    request_id: requestId,
    keyword,
    count: payload.count,
    places: (payload.data || []).slice(0, pageSize).map(item => ({
      id: item.id,
      title: item.title,
      address: item.address,
      category: item.category,
      district: item.ad_info?.district || '',
      location: item.location,
      distance_m: item._distance ?? null
    }))
  };
}

function summarizeTransitRoute(route) {
  const segments = [];
  for (const step of route.steps || []) {
    if (step.mode === 'WALKING') {
      segments.push({ mode: 'WALKING', duration_min: step.duration, distance_m: step.distance });
    } else if (step.mode === 'TRANSIT') {
      for (const line of step.lines || []) {
        segments.push({
          mode: line.vehicle,
          line: line.title,
          direction: line.destination?.title || line.destination || '',
          from: line.geton?.title || '',
          to: line.getoff?.title || '',
          stations: line.station_count,
          duration_min: line.duration,
          running_status: line.running_status
        });
      }
    }
  }
  return {
    duration_min: route.duration,
    distance_m: route.distance,
    price_cny: typeof route.price === 'number' ? route.price / 100 : null,
    segments
  };
}

function summarizeSimpleRoute(route, mode) {
  return {
    mode,
    duration_min: route.duration,
    distance_m: route.distance,
    taxi_fare_cny: route.taxi_fare?.fare ?? null,
    steps: (route.steps || []).slice(0, 8).map(step => ({
      instruction: step.instruction,
      road_name: step.road_name,
      duration_min: step.duration,
      distance_m: step.distance
    }))
  };
}

async function getRoute(args) {
  const mode = ['transit', 'walking', 'driving'].includes(args.mode) ? args.mode : 'transit';
  const from = args.from;
  const to = args.to;
  if (!from?.lat || !from?.lng || !to?.lat || !to?.lng) throw new Error('get_route 需要 from/to 经纬度');
  const params = {
    from: `${from.lat},${from.lng}`,
    to: `${to.lat},${to.lng}`,
    from_poi: from.poi_id,
    to_poi: to.poi_id,
    policy: mode === 'transit' ? (args.policy || 'RECOMMEND') : (mode === 'driving' ? 'LEAST_TIME' : undefined),
    added_fields: mode === 'transit' ? 'line_color' : undefined,
    price_unit: mode === 'transit' ? 1 : undefined,
    get_mp: mode === 'driving' ? 1 : undefined
  };
  const { payload, requestId } = await mapGet(`/ws/direction/v1/${mode}/`, params);
  const routes = (payload.result?.routes || []).slice(0, 3).map(route => mode === 'transit'
    ? summarizeTransitRoute(route)
    : summarizeSimpleRoute(route, mode.toUpperCase()));
  return {
    source: `腾讯地图${mode === 'transit' ? '公交' : mode === 'walking' ? '步行' : '驾车'}路线（实时调用）`,
    request_id: requestId,
    from: from.title || from,
    to: to.title || to,
    routes
  };
}

function clockMinutes(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[\s·—_（）()\-]/g, '');
}

function itemParticipants(item, members) {
  return Array.isArray(item.participants) && item.participants.length ? item.participants : members.map(member => member.name);
}

function containsUnsafeKeyword(text, keyword) {
  const source = normalizedText(text);
  const target = normalizedText(keyword);
  let index = source.indexOf(target);
  while (index >= 0) {
    const prefix = source.slice(Math.max(0, index - 5), index);
    if (!/(不含|不放|不要|不吃|避开|去除|无)/.test(prefix)) return true;
    index = source.indexOf(target, index + target.length);
  }
  return false;
}

function requirementMet(requirement, itinerary, memberName) {
  const items = (itinerary.days || []).flatMap(day => day.items || []).filter(item => itemParticipants(item, [{ name: memberName }]).includes(memberName));
  if (String(requirement).includes('至少一个自然景观')) {
    return items.some(item => (item.tags || []).some(tag => ['nature', 'park', 'lake'].includes(tag)));
  }
  if (String(requirement).includes('特色餐饮')) {
    return items.some(item => (item.tags || []).includes('food') && safeNumber(item.estimated_cost, Infinity) <= 80);
  }
  const alternatives = String(requirement).split('或').map(value => normalizedText(value.replace(/区域|至少体验一次|人均.*$/g, ''))).filter(Boolean);
  const matchedItem = items.some(item => {
    const text = normalizedText(`${item.place?.title || ''} ${item.activity || ''}`);
    return alternatives.some(value => text.includes(value));
  });
  if (matchedItem) return true;
  return (itinerary.branches || []).some(branch => {
    const text = normalizedText(`${branch.place?.title || ''} ${branch.title || ''} ${branch.activity || ''}`);
    return alternatives.some(value => text.includes(value))
      && (branch.participants || []).includes(memberName)
      && (branch.confirmation_status === 'confirmed' || branch.confirmed === true);
  });
}

function preferenceEntries(member, level) {
  const entries = member.soft_preferences?.[level];
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => typeof entry === 'string' ? { label: entry, tags: [entry] } : entry);
}

function assessItinerary(args) {
  const trip = args.trip || {};
  const members = trip.members || [];
  const itinerary = args.itinerary || {};
  const days = itinerary.days || [];
  const items = days.flatMap(day => day.items || []);
  const hardViolations = [];
  const warnings = [];
  const memberScores = [];
  const totalBudget = Number(itinerary.estimated_budget_per_person);
  const coveredTags = new Set(items.flatMap(item => item.tags || []));
  const itineraryText = normalizedText(items.map(item => `${item.place?.title || ''} ${item.activity || ''}`).join(' '));

  if (!days.length || days.length !== Number(trip.days)) hardViolations.push(`行程天数应为 ${trip.days} 天，实际为 ${days.length} 天`);
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) hardViolations.push('缺少有效的人均预算估算');

  for (const member of members) {
    const budget = safeNumber(member.budget_max, Infinity);
    if (Number.isFinite(totalBudget) && totalBudget > budget) hardViolations.push(`${member.name} 的预算上限为 ¥${budget}，方案预计 ¥${totalBudget}`);

    const walkingValues = itinerary.member_daily_walking_km?.[member.name] || itinerary.daily_walking_km;
    if (!Array.isArray(walkingValues) || walkingValues.length !== Number(trip.days)) {
      hardViolations.push(`${member.name} 缺少可验证的每日步行距离`);
    } else {
      walkingValues.forEach((value, index) => {
        if (safeNumber(value, Infinity) > safeNumber(member.walking_limit_km, Infinity)) {
          hardViolations.push(`${member.name} Day ${index + 1} 步行 ${value}km，超过上限 ${member.walking_limit_km}km`);
        }
      });
    }

    for (const day of days) {
      const memberItems = (day.items || []).filter(item => itemParticipants(item, members).includes(member.name));
      if (!memberItems.length) continue;
      const firstStart = clockMinutes(memberItems[0].start_time);
      const lastEnd = clockMinutes(memberItems.at(-1).end_time);
      const earliest = clockMinutes(member.earliest_start);
      const latest = clockMinutes(member.latest_end);
      if (earliest !== null && (firstStart === null || firstStart < earliest)) hardViolations.push(`${member.name} Day ${day.day} 的共同活动早于 ${member.earliest_start}`);
      if (latest !== null && (lastEnd === null || lastEnd > latest)) hardViolations.push(`${member.name} Day ${day.day} 的共同活动晚于 ${member.latest_end}`);
    }

    for (const requirement of member.must_visit || []) {
      if (!requirementMet(requirement, itinerary, member.name)) hardViolations.push(`${member.name} 的必去要求未满足：${requirement}`);
    }

    const dietaryHits = (member.dietary_rules?.forbidden_keywords || []).filter(keyword => containsUnsafeKeyword(itineraryText, keyword));
    if (dietaryHits.length) hardViolations.push(`${member.name} 的饮食禁忌被命中：${dietaryHits.join('、')}`);

    const rules = member.rules || {};
    if (rules.max_major_nodes_per_day) {
      for (const day of days) {
        const majorCount = (day.items || []).filter(item => {
          const tags = item.tags || [];
          return !tags.some(tag => ['meet', 'return', 'transit', 'food', 'cafe', 'relax'].includes(tag));
        }).length;
        if (majorCount > rules.max_major_nodes_per_day) hardViolations.push(`${member.name} Day ${day.day} 有 ${majorCount} 个主要节点，超过上限 ${rules.max_major_nodes_per_day}`);
      }
    }
    if (rules.lunch_break_min) {
      for (const day of days) {
        const lunch = (day.items || []).find(item => /午餐|午饭/.test(item.activity || ''));
        const duration = lunch ? clockMinutes(lunch.end_time) - clockMinutes(lunch.start_time) : 0;
        if (!lunch || duration < rules.lunch_break_min) hardViolations.push(`${member.name} Day ${day.day} 午餐休息不足 ${rules.lunch_break_min} 分钟`);
      }
    }
    if (rules.max_continuous_transport_min) {
      for (const item of items) {
        if (itemParticipants(item, members).includes(member.name) && safeNumber(item.transport_from_previous?.duration_min) > rules.max_continuous_transport_min) {
          hardViolations.push(`${member.name} 前往 ${item.place?.title || '下一节点'} 的乘车时间超过 ${rules.max_continuous_transport_min} 分钟`);
        }
      }
    }

    const high = preferenceEntries(member, 'high');
    const medium = preferenceEntries(member, 'medium');
    const legacy = !high.length && !medium.length ? (member.interests || []).map(tag => ({ label: tag, tags: [tag] })) : [];
    const weighted = [...high.map(item => ({ ...item, weight: 3 })), ...medium.map(item => ({ ...item, weight: 1 })), ...legacy.map(item => ({ ...item, weight: 1 }))];
    const matched = weighted.filter(preference => (preference.tags || []).some(tag => coveredTags.has(tag)) || itineraryText.includes(normalizedText(preference.label)));
    const possible = weighted.reduce((sum, item) => sum + item.weight, 0);
    const earned = matched.reduce((sum, item) => sum + item.weight, 0);
    memberScores.push({
      member: member.name,
      preference_score: possible ? Math.round(earned / possible * 100) : 70,
      matched: matched.map(item => item.label),
      missed: weighted.filter(item => !matched.includes(item)).map(item => item.label)
    });
  }

  for (const day of days) {
    const dayItems = day.items || [];
    if (dayItems.length > 7) warnings.push(`Day ${day.day} 有 ${dayItems.length} 个节点，可能过密`);
    for (let index = 1; index < dayItems.length; index++) {
      const previousEnd = clockMinutes(dayItems[index - 1].end_time);
      const currentStart = clockMinutes(dayItems[index].start_time);
      if (previousEnd === null || currentStart === null || currentStart < previousEnd) hardViolations.push(`Day ${day.day} 节点时间缺失或重叠`);
      const routeDurationValue = Number(dayItems[index].transport_from_previous?.duration_min);
      const routeDuration = Number.isFinite(routeDurationValue) ? routeDurationValue : null;
      if (previousEnd !== null && currentStart !== null && routeDuration !== null && currentStart - previousEnd < routeDuration) {
        hardViolations.push(`Day ${day.day} 前往 ${dayItems[index].place?.title || '节点'} 的预留交通时间不足`);
      }
      if (!dayItems[index].transport_from_previous?.source_request_id && dayItems[index - 1].place?.id !== dayItems[index].place?.id) hardViolations.push(`Day ${day.day} 前往 ${dayItems[index].place?.title || '节点'} 缺少路线证据`);
    }
  }

  const last = (days.at(-1)?.items || []).at(-1);
  const deadline = clockMinutes(trip.return_deadline || '18:00');
  const finalEnd = clockMinutes(last?.end_time);
  if (!last?.place?.title || !normalizedText(last.place.title).includes(normalizedText(trip.origin))) hardViolations.push(`最后节点必须返回 ${trip.origin}`);
  if (deadline === null || finalEnd === null || finalEnd > deadline) hardViolations.push(`最后一天未在 ${trip.return_deadline} 前完成返程`);

  const unconfirmedBranches = items.filter(item => Array.isArray(item.participants) && item.participants.length < members.length && item.confirmation_status !== 'confirmed');
  if (unconfirmedBranches.length) hardViolations.push(`存在 ${unconfirmedBranches.length} 个未经相关成员确认的个人或分组支线`);

  const lowestScore = memberScores.length ? Math.min(...memberScores.map(item => item.preference_score)) : 0;
  const averageScore = memberScores.length ? Math.round(memberScores.reduce((sum, item) => sum + item.preference_score, 0) / memberScores.length) : 0;
  return {
    hard_violation_count: hardViolations.length,
    hard_violations: [...new Set(hardViolations)],
    warnings,
    member_scores: memberScores,
    fairness_floor: lowestScore,
    average_satisfaction: averageScore,
    verdict: hardViolations.length ? 'REPLAN_REQUIRED' : 'PASS'
  };
}

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'search_places',
      description: '使用腾讯地图实时搜索目标城市的真实景点、餐厅、商圈、公园或车站。',
      parameters: {
        type: 'object', required: ['keyword', 'city'],
        properties: {
          keyword: { type: 'string', description: '地点名称或类别关键词' },
          city: { type: 'string', description: '本次旅行的目标城市' },
          page_size: { type: 'integer', minimum: 1, maximum: 12 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_route',
      description: '使用腾讯地图实时查询两个地点之间的公交、步行或驾车路线和预计时间。排定相邻行程节点前必须调用。',
      parameters: {
        type: 'object', required: ['mode', 'from', 'to'],
        properties: {
          mode: { type: 'string', enum: ['transit', 'walking', 'driving'] },
          policy: { type: 'string', enum: ['RECOMMEND', 'LEAST_TIME', 'LEAST_TRANSFER', 'LEAST_WALKING'] },
          from: { type: 'object', required: ['lat', 'lng', 'title'], properties: { title: {type:'string'}, lat:{type:'number'}, lng:{type:'number'}, poi_id:{type:'string'} } },
          to: { type: 'object', required: ['lat', 'lng', 'title'], properties: { title: {type:'string'}, lat:{type:'number'}, lng:{type:'number'}, poi_id:{type:'string'} } }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assess_itinerary',
      description: '确定性校验行程的预算、返程截止、成员偏好覆盖和公平度。输出 REPLAN_REQUIRED 时必须修改计划后再次校验。',
      parameters: {
        type: 'object', required: ['trip', 'itinerary'],
        properties: { trip: { type: 'object' }, itinerary: { type: 'object' } }
      }
    }
  }
];

async function executeTool(name, args) {
  if (name === 'search_places') return searchPlaces(args);
  if (name === 'get_route') return getRoute(args);
  if (name === 'assess_itinerary') return assessItinerary(args);
  throw new Error(`未知工具：${name}`);
}

async function callModel(messages, options = {}) {
  if (!MODEL_API_KEY) throw new Error('MODEL_API_KEY 未配置');
  const requestBody = {
    model: MODEL_NAME,
    messages,
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 8192,
    thinking: { type: options.thinking === true ? 'enabled' : 'disabled' }
  };
  if (options.tools !== false) {
    requestBody.tools = options.tools || toolDefinitions;
    requestBody.tool_choice = options.toolChoice || 'auto';
  }
  if (options.json === true) requestBody.response_format = { type: 'json_object' };

  const response = await fetch(`${MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MODEL_API_KEY}` },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(options.timeoutMs ?? 240000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`模型请求失败：${payload.error?.message || response.status}`);
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error('模型没有返回 message');
  return { message, usage: payload.usage || null, model: payload.model || MODEL_NAME };
}

function parseFinal(content) {
  if (!content) return null;
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

function searchKeywordsForTrip(trip) {
  const keywords = [trip.origin];
  for (const member of trip.members || []) {
    for (const requirement of member.must_visit || []) {
      const text = String(requirement);
      if (text.includes('特色餐饮')) keywords.push(`${trip.destination}特色餐饮`);
      else if (text.includes('自然景观') || text.includes('城市公园')) keywords.push(`${trip.destination}城市公园`);
      else keywords.push(text.split('或')[0].replace(/区域/g, '').trim());
    }
    const preferences = [...preferenceEntries(member, 'high'), ...preferenceEntries(member, 'medium')];
    if (preferences.some(item => item.label.includes('咖啡'))) keywords.push(`${trip.destination}咖啡馆`);
    if (preferences.some(item => item.label.includes('胡同'))) keywords.push(`${trip.destination}特色街区`);
  }
  return [...new Set(keywords.filter(Boolean))].slice(0, MAX_SEARCH_REQUESTS);
}

async function executeRecordedTool(state, res, stage, name, args) {
  const id = `${stage}-${crypto.randomUUID()}`;
  if (res) emit(res, 'tool_call', { stage, id, name, arguments: args });
  let result;
  try {
    result = await executeTool(name, args);
    if (res) emit(res, 'tool_result', { stage, id, name, result });
  } catch (error) {
    const retryable = !/(每日调用量已达到上限|key.*(?:错误|无效)|未开启|无权限)/i.test(error.message);
    result = { error: error.message, retryable };
    if (res) emit(res, 'tool_error', { stage, id, name, error: error.message, retryable });
  }
  state.events.push({ type: 'tool', stage, id, name, arguments: args, result });
  await saveSession(state);
  return result;
}

function compactPlaces(searchResults) {
  const seen = new Set();
  const places = [];
  for (const result of searchResults) {
    for (const place of result.places || []) {
      if (!place.id || !Number.isFinite(Number(place.location?.lat)) || !Number.isFinite(Number(place.location?.lng)) || seen.has(String(place.id))) continue;
      seen.add(String(place.id));
      places.push({
        id: String(place.id),
        title: place.title,
        address: place.address,
        category: place.category,
        district: place.district,
        lat: place.location?.lat,
        lng: place.location?.lng,
        search_request_id: result.request_id
      });
    }
  }
  return places.slice(0, 36);
}

function planningPrompt(trip, places) {
  const members = trip.members || [];
  const sharedBudget = Math.min(...members.map(member => safeNumber(member.budget_max, Infinity)));
  const sharedEarliest = Math.max(...members.map(member => clockMinutes(member.earliest_start) ?? 0));
  const sharedLatest = Math.min(...members.map(member => clockMinutes(member.latest_end) ?? 1440));
  const formatClock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const mustVisits = [...new Set(members.flatMap(member => member.must_visit || []))];
  const negotiationDirections = [0, 1, 2].map(index => negotiationDefinition(trip, index));
  const strictMemberRules = members.map(member => ({
    member: member.name,
    walking_limit_km: member.walking_limit_km,
    earliest_start: member.earliest_start,
    latest_end: member.latest_end,
    max_major_nodes_per_day: member.rules?.max_major_nodes_per_day,
    lunch_break_min: member.rules?.lunch_break_min,
    max_taxi_fare_per_ride: member.rules?.max_taxi_fare_per_ride,
    max_continuous_transport_min: member.rules?.max_continuous_transport_min
  }));
  return `你是多人旅行方案设计器。请直接输出一个合法 JSON 对象，不要输出推理过程或 Markdown。

任务：基于给定成员硬约束和真实 POI，生成恰好 3 个可比较候选方案。

本次共同硬边界：人均总预算不得超过 ¥${sharedBudget}；共同活动不得早于 ${formatClock(sharedEarliest)}，不得晚于 ${formatClock(sharedLatest)}；最后一天必须在 ${trip.return_deadline} 前回到 ${trip.origin}；必去要求为 ${JSON.stringify(mustVisits)}。

强制规则：
1. 只能使用 POI 列表中的 id；不得编造地点、坐标、营业时间或价格。
2. 三个方案不是同一方案换标题，而是以下三种动态协商方向，必须按照顺序分别生成 plan-a、plan-b、plan-c：${JSON.stringify(negotiationDirections)}
3. 除每个方案定义中的 relaxed_constraints 外，预算、时间、返程、饮食和其他硬约束仍必须满足。不得偷偷放宽条件。
4. participants 必须填写成员中文 name，不得填写 member-a 等 id。plan-a 的分组节点填写 confirmation_status="pending"，表示等待成员确认；其他方案默认全员同行。
5. 三个方案尽量共享核心路线，每个方案每天最多 5 个主要节点，三个方案合计最多 12 种不重复的相邻地点组合。
6. 每天第一个节点和最后一个节点也必须使用真实 POI。最后一天最后节点必须是出发地点。
7. 每个节点填写保守的 on_site_walking_km。estimated_budget_per_person 必须包含住宿、餐饮、市内交通和门票，且不得超过 ¥${sharedBudget}。
8. tags 只能使用英文枚举：meet、return、culture、history、hutong、photo、food、cafe、relax、nature、park、lake、night、shopping。
9. transport_mode 只能是 transit、walking、driving。存在打车金额限制或价格不确定时优先 transit。
10. 必须逐人遵守以下数值规则：${JSON.stringify(strictMemberRules)}。只有当前方案 relaxed_constraints 明确覆盖的字段可以暂时放宽。
11. 每位成员必须有 gains 和 concessions。明确列出预算、步行、出发时间、密度、必去地点和结束时间冲突。

JSON 结构：
{
  "status":"planned",
  "summary":"",
  "conflicts":[{"title":"","members":[],"resolution":""}],
  "candidates":[{
    "id":"plan-a",
    "type":"negotiation",
    "negotiation_direction":"subgroup | downgrade_must_visit | relax_walking",
    "required_confirmations":["成员姓名"],
    "relaxed_constraints":["本方案唯一明确放宽项"],
    "title":"",
    "summary":"",
    "estimated_budget_per_person":0,
    "days":[{"day":1,"theme":"","items":[{
      "start_time":"10:00","end_time":"10:20","place_id":"必须来自POI列表",
      "activity":"","tags":[],"on_site_walking_km":0,"estimated_cost":0,
      "transport_mode":"transit","participants":[]
    }]}],
    "member_tradeoffs":[{"member":"","gains":[],"concessions":[]}],
    "branches":[]
  }]
}

旅行需求：${JSON.stringify(trip)}

可用真实 POI：${JSON.stringify(places)}`;
}

function conflictSummary(trip, modelConflicts = []) {
  const members = trip.members || [];
  const generated = [
    { title: '预算冲突', members: members.map(member => member.name), resolution: `共同方案按最低人均预算 ¥${Math.min(...members.map(member => safeNumber(member.budget_max, Infinity)))} 控制。` },
    { title: '出发时间冲突', members: members.map(member => member.name), resolution: `共同活动不早于 ${members.map(member => member.earliest_start).filter(Boolean).sort().at(-1) || '约定时间'}。` },
    { title: '步行与体力冲突', members: members.map(member => member.name), resolution: `共同路线按最低每日步行上限 ${Math.min(...members.map(member => safeNumber(member.walking_limit_km, Infinity)))}km 校验。` },
    { title: '行程密度与节奏冲突', members: members.map(member => member.name), resolution: '主要节点数量服从最严格成员上限，通过休息节点或已确认支线满足其他偏好。' },
    { title: '必去地点与共同活动冲突', members: members.map(member => member.name), resolution: '必去地点默认共同参与；确需分组时必须取得相关成员确认。' },
    { title: '夜间结束与返程冲突', members: members.map(member => member.name), resolution: `共同活动按最早结束时间 ${members.map(member => member.latest_end).filter(Boolean).sort()[0] || trip.return_deadline} 收束，末日按 ${trip.return_deadline} 返回。` }
  ];
  const merged = [...generated];
  for (const conflict of modelConflicts || []) {
    if (!merged.some(item => normalizedText(item.title) === normalizedText(conflict.title))) merged.push(conflict);
  }
  return merged;
}

async function generateCandidatePackage(trip, places, state, res, feedback = '') {
  const prompt = `${planningPrompt(trip, places)}${feedback ? `\n\n上轮确定性校验失败项：${feedback}\n必须逐项修复，不得仅修改文字说明。` : ''}`;
  const maxAttempts = feedback ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    emit(res, 'thinking', { stage: 'candidate_generation', attempt, message: `正在生成三个候选方案（第 ${attempt} 次）` });
    const messages = [
      { role: 'system', content: '你只负责输出符合要求的紧凑 JSON。不要解释，不要使用工具，不要输出 Markdown。' },
      { role: 'user', content: attempt === 1 ? prompt : `${prompt}\n\n上一次没有产生合法的三个候选方案。请缩短描述并立即输出完整 JSON。` }
    ];
    const { message, usage, model } = await callModel(messages, { tools: false, json: true, maxTokens: 8000, thinking: false });
    state.events.push({ type: 'model', stage: 'candidate_generation', attempt, model, usage, content: message.content || null, tool_calls: [] });
    emit(res, 'model', { stage: 'candidate_generation', attempt, model, usage, content: message.content || null, tool_calls: [] });
    await saveSession(state);
    const parsed = parseFinal(message.content);
    if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length === 3) return parsed;
    emit(res, 'replan', { stage: 'candidate_generation', attempt, reason: '候选方案 JSON 无效或数量不是 3' });
  }
  throw new Error('模型未返回合法的三个候选方案');
}

function canonicalTag(tag) {
  const aliases = {
    '交通': 'transit', '集合': 'meet', '返程': 'return', '文化': 'culture', '历史': 'history',
    '胡同': 'hutong', '摄影': 'photo', '拍照': 'photo', '美食': 'food', '咖啡': 'cafe',
    '休息': 'relax', '轻松': 'relax', '自然': 'nature', '公园': 'park', '湖景': 'lake',
    '夜景': 'night', '购物': 'shopping'
  };
  return aliases[tag] || String(tag || '').toLowerCase();
}

function negotiationDefinition(trip, candidateIndex) {
  const members = trip.members || [];
  const allMembers = members.map(member => member.name);
  const mustVisitOwner = [...members].sort((a, b) => (b.must_visit?.length || 0) - (a.must_visit?.length || 0))[0] || {};
  const mustVisits = mustVisitOwner.must_visit || [];
  const downgradedMustVisits = mustVisits.slice(0, Math.max(1, Math.ceil(mustVisits.length / 2)));
  const minimumWalking = Math.min(...members.map(member => safeNumber(member.walking_limit_km, Infinity)));
  const walkingMembers = members.filter(member => safeNumber(member.walking_limit_km, Infinity) === minimumWalking);
  const proposedWalkingLimit = Number.isFinite(minimumWalking) ? Math.max(minimumWalking + 2, Math.ceil(minimumWalking * 1.5)) : null;
  return [
    {
      direction: 'subgroup',
      label: '确认分组支线',
      required_confirmations: allMembers,
      relaxed_constraints: ['默认全员同行'],
      parameters: { branch_members: [mustVisitOwner.name].filter(Boolean) },
      description: `保留共同主线，并由${mustVisitOwner.name || '高诉求成员'}通过个人或分组支线完成额外必去地点。`
    },
    {
      direction: 'downgrade_must_visit',
      label: '降低部分必去等级',
      required_confirmations: [mustVisitOwner.name].filter(Boolean),
      relaxed_constraints: [`${mustVisitOwner.name || '相关成员'}的${downgradedMustVisits.join('、') || '部分必去地点'}降为很想去`],
      parameters: { member: mustVisitOwner.name, downgraded_must_visits: downgradedMustVisits },
      description: '保持全员同行，减少必须覆盖的地点数量，优先保护团队中更严格的体力和时间限制。'
    },
    {
      direction: 'relax_walking',
      label: '放宽步行上限',
      required_confirmations: walkingMembers.map(member => member.name),
      relaxed_constraints: walkingMembers.map(member => `${member.name}每日步行上限由${minimumWalking}公里放宽到${proposedWalkingLimit}公里`),
      parameters: { members: walkingMembers.map(member => member.name), original_limit_km: minimumWalking, proposed_limit_km: proposedWalkingLimit },
      description: '保持更多核心地点共同游，通过相关成员确认适度增加步行上限。'
    }
  ][candidateIndex];
}

function hydrateCandidates(rawCandidates, places, trip) {
  const placeById = new Map(places.map(place => [String(place.id), place]));
  const placeByTitle = new Map(places.map(place => [normalizedText(place.title), place]));
  const memberNameById = new Map((trip.members || []).flatMap(member => [[member.id, member.name], [member.name, member.name]]));
  return rawCandidates.map((candidate, candidateIndex) => {
    const days = (candidate.days || []).map(day => ({
      ...day,
      items: (day.items || []).map(item => {
        const place = placeById.get(String(item.place_id)) || placeByTitle.get(normalizedText(item.place_id));
        const participants = Array.isArray(item.participants) && item.participants.length
          ? item.participants.map(value => memberNameById.get(value) || value)
          : undefined;
        return {
          start_time: item.start_time,
          end_time: item.end_time,
          place: place ? { id: place.id, title: place.title, lat: place.lat, lng: place.lng, source_request_id: place.search_request_id } : { id: String(item.place_id || ''), title: '未知地点', lat: null, lng: null },
          activity: item.activity || '',
          tags: [...new Set((item.tags || []).map(canonicalTag))],
          on_site_walking_km: safeNumber(item.on_site_walking_km),
          estimated_cost: safeNumber(item.estimated_cost),
          transport_mode: item.transport_mode || 'transit',
          participants,
          confirmation_status: item.confirmation_status,
          reason: item.reason || ''
        };
      })
    }));
    for (const day of days) {
      day.items = (day.items || []).reduce((merged, item) => {
        const previous = merged.at(-1);
        const sameParticipants = JSON.stringify(previous?.participants || []) === JSON.stringify(item.participants || []);
        if (previous && previous.place?.id === item.place?.id && sameParticipants) {
          previous.end_time = item.end_time || previous.end_time;
          previous.activity = [previous.activity, item.activity].filter(Boolean).join('；');
          previous.tags = [...new Set([...(previous.tags || []), ...(item.tags || [])])];
          previous.on_site_walking_km += safeNumber(item.on_site_walking_km);
          previous.estimated_cost += safeNumber(item.estimated_cost);
          previous.reason = [previous.reason, item.reason].filter(Boolean).join('；');
          return merged;
        }
        merged.push(item);
        return merged;
      }, []);
    }
    const originPlace = places.find(place => normalizedText(place.title).includes(normalizedText(trip.origin)));
    const finalDay = days.at(-1);
    const finalItem = finalDay?.items?.at(-1);
    if (originPlace && finalDay && !normalizedText(finalItem?.place?.title).includes(normalizedText(trip.origin))) {
      finalDay.items.push({
        start_time: trip.return_deadline,
        end_time: trip.return_deadline,
        place: { id: originPlace.id, title: originPlace.title, lat: originPlace.lat, lng: originPlace.lng, source_request_id: originPlace.search_request_id },
        activity: `返回${trip.origin}，完成返程`,
        tags: ['return'],
        on_site_walking_km: 0,
        estimated_cost: 0,
        transport_mode: 'transit',
        reason: '满足返程地点与截止时间硬约束'
      });
    }
    for (const day of days) {
      let requiredShift = 0;
      for (const item of day.items || []) {
        const start = clockMinutes(item.start_time);
        if (start === null) continue;
        const earliestForParticipants = Math.max(...itemParticipants(item, trip.members || []).map(name => {
          const member = (trip.members || []).find(entry => entry.name === name);
          return clockMinutes(member?.earliest_start) ?? 0;
        }));
        requiredShift = Math.max(requiredShift, earliestForParticipants - start);
      }
      if (requiredShift > 0) {
        for (const item of day.items || []) {
          item.start_time = shiftClock(item.start_time, requiredShift);
          item.end_time = shiftClock(item.end_time, requiredShift);
        }
      }
    }
    const memberTradeoffs = (candidate.member_tradeoffs || []).map(item => ({ ...item, member: memberNameById.get(item.member) || item.member }));
    const negotiation = negotiationDefinition(trip, candidateIndex);
    return {
      id: `plan-${String.fromCharCode(97 + candidateIndex)}`,
      type: 'negotiation',
      negotiation_direction: negotiation.direction,
      negotiation_label: negotiation.label,
      required_confirmations: negotiation.required_confirmations,
      relaxed_constraints: negotiation.relaxed_constraints,
      negotiation_parameters: negotiation.parameters,
      title: candidate.title || negotiation.label,
      summary: candidate.summary || negotiation.description,
      itinerary: {
        title: candidate.title || `候选方案 ${candidateIndex + 1}`,
        estimated_budget_per_person: safeNumber(candidate.estimated_budget_per_person),
        days,
        branches: candidate.branches || []
      },
      member_tradeoffs: memberTradeoffs
    };
  });
}

function routeKey(mode, from, to) {
  return `${mode}|${from.id}|${to.id}`;
}

function directDistanceKm(from, to) {
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(to.lat - from.lat);
  const lngDelta = radians(to.lng - from.lng);
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function effectiveRouteMode(requestedMode, from, to) {
  const requested = ['transit', 'walking', 'driving'].includes(requestedMode) ? requestedMode : 'transit';
  return requested === 'walking' && directDistanceKm(from, to) > 1.2 ? 'transit' : requested;
}

function walkingDistance(route, mode) {
  if (mode === 'walking') return safeNumber(route?.distance_m);
  return (route?.segments || []).filter(segment => segment.mode === 'WALKING').reduce((sum, segment) => sum + safeNumber(segment.distance_m), 0);
}

function shiftClock(value, delta) {
  const minutes = clockMinutes(value);
  if (minutes === null) return value;
  const shifted = minutes + delta;
  return `${String(Math.floor(shifted / 60) % 24).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

function routeDescription(route) {
  const lines = (route?.segments || []).filter(segment => segment.line).map(segment => segment.line);
  return lines.length ? lines.join(' → ') : `${Math.round(safeNumber(route?.distance_m) / 1000 * 10) / 10}km`;
}

async function addRouteEvidence(candidates, state, res) {
  const requests = new Map();
  for (const candidate of candidates) {
    for (const day of candidate.itinerary.days || []) {
      for (let index = 1; index < (day.items || []).length; index++) {
        const from = day.items[index - 1].place;
        const to = day.items[index].place;
        if (!from?.lat || !from?.lng || !to?.lat || !to?.lng || from.id === to.id) continue;
        const distanceKm = directDistanceKm(from, to);
        if (distanceKm <= 0.2) {
          day.items[index].short_transfer_distance_m = Math.round(distanceKm * 1000);
          day.items[index].resolved_transport_mode = 'walking';
          continue;
        }
        const mode = effectiveRouteMode(day.items[index].transport_mode, from, to);
        day.items[index].resolved_transport_mode = mode;
        const key = routeKey(mode, from, to);
        if (!requests.has(key)) requests.set(key, { mode, policy: mode === 'transit' ? 'LEAST_WALKING' : undefined, from: { title: from.title, lat: from.lat, lng: from.lng, poi_id: from.id }, to: { title: to.title, lat: to.lat, lng: to.lng, poi_id: to.id } });
      }
    }
  }

  const selectedRequests = [...requests.entries()].slice(0, MAX_ROUTE_REQUESTS);
  const routeResults = new Map();
  for (const [key, args] of selectedRequests) {
    const result = await executeRecordedTool(state, res, 'route_evidence', 'get_route', args);
    if (!result.error && result.routes?.length) routeResults.set(key, result);
  }

  for (const candidate of candidates) {
    const memberWalking = Object.fromEntries((state.trip.members || []).map(member => [member.name, []]));
    for (const day of candidate.itinerary.days || []) {
      const walkingByMember = Object.fromEntries((state.trip.members || []).map(member => [member.name, 0]));
      for (let index = 0; index < (day.items || []).length; index++) {
        const item = day.items[index];
        const participants = itemParticipants(item, state.trip.members || []);
        for (const name of participants) walkingByMember[name] = (walkingByMember[name] || 0) + safeNumber(item.on_site_walking_km);
        if (index === 0) continue;
        const from = day.items[index - 1].place;
        const to = item.place;
        if (from.id === to.id) continue;
        if (item.short_transfer_distance_m !== undefined) {
          const routeWalkingKm = item.short_transfer_distance_m / 1000;
          for (const name of participants) walkingByMember[name] = (walkingByMember[name] || 0) + routeWalkingKm;
          const durationMin = Math.max(1, Math.ceil(routeWalkingKm * 15));
          if ((item.tags || []).includes('return')) {
            item.end_time = state.trip.return_deadline || item.end_time;
            item.start_time = shiftClock(item.end_time, -durationMin);
          }
          item.transport_from_previous = {
            mode: 'WALKING',
            duration_min: durationMin,
            transfer: `步行约 ${item.short_transfer_distance_m} 米`,
            source_request_id: item.place.source_request_id,
            walking_distance_m: item.short_transfer_distance_m,
            evidence_type: 'poi_coordinate_distance'
          };
          continue;
        }
        const mode = item.resolved_transport_mode || effectiveRouteMode(item.transport_mode, from, to);
        const result = routeResults.get(routeKey(mode, from, to));
        const route = result?.routes?.[0];
        if (!route) continue;
        const routeWalkingKm = walkingDistance(route, mode) / 1000;
        for (const name of participants) walkingByMember[name] = (walkingByMember[name] || 0) + routeWalkingKm;
        const previousEnd = clockMinutes(day.items[index - 1].end_time);
        const currentStart = clockMinutes(item.start_time);
        const requiredStart = previousEnd === null ? null : previousEnd + safeNumber(route.duration_min);
        if ((item.tags || []).includes('return')) {
          const deadline = state.trip.return_deadline || item.end_time;
          const departure = shiftClock(deadline, -safeNumber(route.duration_min));
          item.start_time = departure;
          item.end_time = deadline;
          if (clockMinutes(day.items[index - 1].end_time) > clockMinutes(departure)) day.items[index - 1].end_time = departure;
        } else if (requiredStart !== null && currentStart !== null && currentStart < requiredStart) {
          const delta = requiredStart - currentStart;
          for (let later = index; later < day.items.length; later++) {
            day.items[later].start_time = shiftClock(day.items[later].start_time, delta);
            day.items[later].end_time = shiftClock(day.items[later].end_time, delta);
          }
        }
        item.transport_from_previous = {
          mode: mode.toUpperCase(),
          duration_min: route.duration_min,
          transfer: routeDescription(route),
          source_request_id: result.request_id,
          walking_distance_m: Math.round(routeWalkingKm * 1000),
          estimated_cost: route.price_cny ?? route.taxi_fare_cny ?? null
        };
      }
      for (const member of state.trip.members || []) memberWalking[member.name].push(Math.round((walkingByMember[member.name] || 0) * 10) / 10);
    }
    candidate.itinerary.member_daily_walking_km = memberWalking;
  }
  return routeResults;
}

function evidenceForCandidates(candidates, routeResults) {
  const evidence = new Map();
  for (const candidate of candidates) {
    for (const item of (candidate.itinerary.days || []).flatMap(day => day.items || [])) {
      if (item.place?.source_request_id) evidence.set(item.place.source_request_id, { source: '腾讯地图地点搜索', request_id: item.place.source_request_id, claim: `${item.place.title} 的地点与坐标` });
      const routeId = item.transport_from_previous?.source_request_id;
      if (routeId) evidence.set(routeId, { source: '腾讯地图路线规划', request_id: routeId, claim: `前往 ${item.place.title} 的路线与预计时间` });
    }
  }
  for (const result of routeResults.values()) {
    if (result.request_id && !evidence.has(result.request_id)) evidence.set(result.request_id, { source: result.source, request_id: result.request_id, claim: `${result.from} 到 ${result.to} 的路线` });
  }
  return [...evidence.values()];
}

function validateTripInput(trip) {
  const errors = [];
  if (!String(trip?.destination || '').trim()) errors.push('目的地不能为空');
  if (!String(trip?.origin || '').trim()) errors.push('出发点不能为空');
  const members = Array.isArray(trip?.members) ? trip.members : [];
  if (members.length < 2 || members.length > 8) errors.push('同行成员数量必须为 2 至 8 人');
  const names = members.map(member => String(member.name || '').trim());
  if (names.some(name => !name)) errors.push('成员称呼不能为空');
  if (new Set(names).size !== names.length) errors.push('成员称呼不能重复');
  if (!Number.isInteger(Number(trip?.days)) || Number(trip.days) < 1 || Number(trip.days) > 14) errors.push('旅行天数必须为 1 至 14 天');
  for (const member of members) {
    if (!(safeNumber(member.budget_max) > 0)) errors.push(`${member.name || '成员'} 的预算上限必须大于 0`);
    if (!(safeNumber(member.walking_limit_km) > 0)) errors.push(`${member.name || '成员'} 的步行上限必须大于 0`);
    const earliest = clockMinutes(member.earliest_start);
    const latest = clockMinutes(member.latest_end);
    if (earliest === null || latest === null || earliest >= latest) errors.push(`${member.name || '成员'} 的可参与时间无效`);
  }
  return errors;
}

async function runAgent(req, res) {
  const body = await readJsonBody(req);
  const trip = body.trip;
  const validationErrors = validateTripInput(trip);
  if (validationErrors.length) return json(res, 400, { error: '旅行需求校验失败', details: validationErrors });
  if (!MODEL_API_KEY || !TENCENT_MAP_KEY) {
    return json(res, 503, {
      error: '真实 Agent 尚未配置运行凭证',
      missing: [!MODEL_API_KEY && 'MODEL_API_KEY', !TENCENT_MAP_KEY && 'TENCENT_MAP_KEY'].filter(Boolean),
      setup: '复制 .env.example 为 .env，填入模型与腾讯地图 WebService Key 后启动。'
    });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  const session = body.session_id ? await getSession(body.session_id) : null;
  const state = session || { id: crypto.randomUUID(), created_at: new Date().toISOString(), messages: [], events: [], final: null };
  state.trip = trip;
  state.evaluation_case_id = body.evaluation_case_id || state.evaluation_case_id || null;
  state.votes = {};
  state.status = 'running';
  state.events = [];
  state.final = null;
  delete state.error;
  emit(res, 'session', { session_id: state.id });
  await saveSession(state);

  try {
    emit(res, 'thinking', { stage: 'conflict_analysis', message: '正在结构化成员约束并确定有限检索范围' });
    const keywords = searchKeywordsForTrip(trip);
    state.events.push({ type: 'stage', stage: 'conflict_analysis', keywords });

    const searchResults = [];
    for (const keyword of keywords) {
      const city = String(trip.destination).replace(/市区$/, '').trim();
      const result = await executeRecordedTool(state, res, 'place_evidence', 'search_places', { keyword, city, page_size: 5 });
      if (result.error && result.retryable === false) throw new Error(result.error);
      if (!result.error) searchResults.push(result);
    }
    const places = compactPlaces(searchResults);
    if (places.length < 4) throw new Error('真实地点证据不足，无法生成候选方案');
    emit(res, 'thinking', { stage: 'candidate_generation', message: `已获得 ${places.length} 个真实地点，开始生成三个候选方案` });

    let planned = await generateCandidatePackage(trip, places, state, res);
    let candidates = hydrateCandidates(planned.candidates, places, trip);
    emit(res, 'thinking', { stage: 'route_evidence', message: '正在为三个候选方案补齐相邻节点路线证据' });
    let routeResults = await addRouteEvidence(candidates, state, res);

    emit(res, 'thinking', { stage: 'deterministic_assessment', message: '正在逐一执行确定性硬约束与公平性校验' });
    for (const candidate of candidates) {
      candidate.assessment = await executeRecordedTool(state, res, 'deterministic_assessment', 'assess_itinerary', { trip, itinerary: candidate.itinerary });
    }

    if (candidates.some(candidate => candidate.assessment?.verdict !== 'PASS')) {
      const feedback = candidates.flatMap(candidate => candidate.assessment?.hard_violations || []).filter(Boolean).slice(0, 30).join('；');
      emit(res, 'replan', { stage: 'candidate_repair', reason: '候选方案未全部通过确定性校验，执行一次有界修订', violations: feedback });
      planned = await generateCandidatePackage(trip, places, state, res, feedback);
      candidates = hydrateCandidates(planned.candidates, places, trip);
      routeResults = await addRouteEvidence(candidates, state, res);
      for (const candidate of candidates) {
        candidate.assessment = await executeRecordedTool(state, res, 'deterministic_reassessment', 'assess_itinerary', { trip, itinerary: candidate.itinerary });
      }
    }

    const allPassed = candidates.every(candidate => candidate.assessment?.verdict === 'PASS');
    const final = {
      status: 'final',
      summary: planned.summary || '三个候选方案已完成真实地点、路线与确定性约束校验。',
      requires_consensus: !allPassed,
      consensus_message: allPassed ? '候选方案均通过硬约束校验，可以开始投票。' : '部分候选方案在一次自动修订后仍未通过，请先确认协商方向。',
      conflicts: conflictSummary(trip, planned.conflicts),
      members: (trip.members || []).map(member => member.name),
      evidence: evidenceForCandidates(candidates, routeResults),
      candidates,
      voting: {
        mode: 'approval',
        min_choices_per_member: 1,
        max_choices_per_member: 2,
        tie_breakers: ['fairness_floor', 'hard_constraint_pass_rate', 'average_satisfaction', 'organizer_decision']
      }
    };
    state.status = allPassed ? 'completed' : 'needs_consensus';
    state.final = final;
    state.completed_at = new Date().toISOString();
    await saveSession(state);
    emit(res, 'final', { session_id: state.id, ...final });
    res.end();
  } catch (error) {
    state.status = 'blocked';
    state.final = { status: 'blocked', reason: error.message, needed: '检查外部服务，或缩小地点范围后重试' };
    await saveSession(state);
    emit(res, 'blocked', state.final);
    res.end();
  }
}

function applyNegotiationAgreement(trip, candidate) {
  const adjustedTrip = structuredClone(trip);
  const parameters = candidate.negotiation_parameters || {};
  if (candidate.negotiation_direction === 'downgrade_must_visit') {
    const member = adjustedTrip.members?.find(item => item.name === parameters.member);
    const downgraded = new Set(parameters.downgraded_must_visits || []);
    if (member) member.must_visit = (member.must_visit || []).filter(place => !downgraded.has(place));
  }
  if (candidate.negotiation_direction === 'relax_walking') {
    for (const memberName of parameters.members || []) {
      const member = adjustedTrip.members?.find(item => item.name === memberName);
      if (member) member.walking_limit_km = safeNumber(parameters.proposed_limit_km, member.walking_limit_km);
    }
  }
  adjustedTrip.confirmed_negotiation = {
    direction: candidate.negotiation_direction,
    parameters,
    relaxed_constraints: candidate.relaxed_constraints,
    confirmed_by: candidate.required_confirmations
  };
  return adjustedTrip;
}

function confirmCandidateBranches(candidate) {
  const confirmed = structuredClone(candidate);
  if (confirmed.negotiation_direction === 'subgroup') {
    for (const day of confirmed.itinerary?.days || []) {
      for (const item of day.items || []) {
        if ((item.participants || []).length) item.confirmation_status = 'confirmed';
      }
    }
    for (const branch of confirmed.itinerary?.branches || []) branch.confirmation_status = 'confirmed';
  }
  return confirmed;
}

function placesFromSession(session) {
  return compactPlaces((session.events || [])
    .filter(event => event.type === 'tool' && event.name === 'search_places' && !event.result?.error)
    .map(event => event.result));
}

function finalPlanPrompt(trip, candidate, places, violations) {
  return `你是最终行程收敛器。成员已经投票确认协商方向，请基于已确认条件输出一份可执行的单一方案 JSON，不要 Markdown。

已确认方向：${candidate.negotiation_label}
已确认放宽项：${JSON.stringify(candidate.relaxed_constraints)}
调整后的旅行约束：${JSON.stringify(trip)}
上一版方案：${JSON.stringify(candidate.itinerary)}
仍需修复的问题：${JSON.stringify(violations)}
可用真实 POI：${JSON.stringify(places)}

要求：
1. 只能使用可用 POI 的 id 或精确 title，不得新增地点。
2. 除已确认放宽项外，预算、返程、时间、饮食和其他硬约束必须满足。
3. 每天最后一个活动不能晚于参与者最早的 latest_end；末日必须预留真实交通时间并在截止前到达出发点。
4. 每个节点填写 participants、on_site_walking_km、estimated_cost 和英文 tags。
5. 同地点的用餐、休息和游览合并为一个节点，避免重复路线。
6. 输出结构只能是：{"candidate":{"title":"","summary":"","estimated_budget_per_person":0,"days":[{"day":1,"theme":"","items":[{"start_time":"10:00","end_time":"11:00","place_id":"","activity":"","tags":[],"on_site_walking_km":0,"estimated_cost":0,"transport_mode":"transit","participants":[],"confirmation_status":"confirmed","reason":""}]}],"member_tradeoffs":[{"member":"","gains":[],"concessions":[]}],"branches":[]}}`;
}

async function resolveConsensus(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) return json(res, 404, { error: '会话不存在' });
  const voting = votingSnapshot(session);
  if (!voting.ready_for_replan || !voting.winner) return json(res, 409, { error: '胜出方向尚未完成必要成员确认', voting });
  const selected = session.final?.candidates?.find(candidate => candidate.id === voting.winner.candidate_id);
  if (!selected) return json(res, 404, { error: '胜出方案不存在' });

  const adjustedTrip = applyNegotiationAgreement(session.trip, selected);
  let resolved = confirmCandidateBranches(selected);
  let assessment = assessItinerary({ trip: adjustedTrip, itinerary: resolved.itinerary });
  const places = placesFromSession(session);

  if (assessment.verdict !== 'PASS') {
    const { message, usage, model } = await callModel([
      { role: 'system', content: '你只输出紧凑、合法的 JSON，不输出解释或 Markdown。' },
      { role: 'user', content: finalPlanPrompt(adjustedTrip, resolved, places, assessment.hard_violations) }
    ], { tools: false, json: true, maxTokens: 7000, thinking: false });
    session.events.push({ type: 'model', stage: 'consensus_resolution', model, usage, content: message.content || null, tool_calls: [] });
    const parsed = parseFinal(message.content);
    if (!parsed?.candidate) return json(res, 502, { error: '模型未返回合法最终方案 JSON' });
    const repaired = hydrateCandidates([parsed.candidate], places, adjustedTrip)[0];
    resolved = {
      ...repaired,
      id: selected.id,
      type: 'resolved',
      negotiation_direction: selected.negotiation_direction,
      negotiation_label: selected.negotiation_label,
      required_confirmations: selected.required_confirmations,
      relaxed_constraints: selected.relaxed_constraints,
      negotiation_parameters: selected.negotiation_parameters
    };
    resolved = confirmCandidateBranches(resolved);
    const routeResults = await addRouteEvidence([resolved], session, null);
    resolved.evidence = evidenceForCandidates([resolved], routeResults);
    assessment = await executeRecordedTool(session, null, 'consensus_reassessment', 'assess_itinerary', { trip: adjustedTrip, itinerary: resolved.itinerary });
  }

  resolved.assessment = assessment;
  session.resolved_plan = resolved;
  session.resolved_trip = adjustedTrip;
  session.resolved_at = new Date().toISOString();
  session.status = assessment.verdict === 'PASS' ? 'finalized' : 'needs_consensus';
  await saveSession(session);
  return json(res, assessment.verdict === 'PASS' ? 200 : 422, {
    status: session.status,
    negotiation: voting.winner,
    resolved_plan: resolved,
    remaining_violations: assessment.hard_violations || []
  });
}

function votingSnapshot(session) {
  const candidates = session.final?.candidates || [];
  const votes = session.votes || {};
  const tallies = Object.fromEntries(candidates.map(candidate => [candidate.id, 0]));
  for (const candidateIds of Object.values(votes)) {
    for (const candidateId of candidateIds || []) {
      if (candidateId in tallies) tallies[candidateId] += 1;
    }
  }
  const ranked = candidates.map(candidate => {
    const scores = candidate.assessment?.member_scores?.map(item => safeNumber(item.preference_score)) || [];
    const requiredConfirmations = candidate.required_confirmations || [];
    const confirmedBy = requiredConfirmations.filter(member => (votes[member] || []).includes(candidate.id));
    return {
      candidate_id: candidate.id,
      title: candidate.title,
      negotiation_label: candidate.negotiation_label,
      votes: tallies[candidate.id] || 0,
      fairness_floor: safeNumber(candidate.assessment?.fairness_floor),
      average_satisfaction: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0,
      eligible: candidate.assessment?.verdict === 'PASS' || Boolean(candidate.negotiation_direction),
      required_confirmations: requiredConfirmations,
      confirmed_by: confirmedBy,
      confirmation_complete: requiredConfirmations.length === confirmedBy.length
    };
  }).sort((a, b) => b.votes - a.votes || b.fairness_floor - a.fairness_floor || b.average_satisfaction - a.average_satisfaction);
  const winner = ranked.length && ranked[0].votes > 0 ? ranked[0] : null;
  return {
    votes,
    tallies,
    ranked,
    winner,
    ready_for_replan: Boolean(winner?.confirmation_complete) && Object.keys(votes).length === (session.trip?.members?.length || 0),
    participation_count: Object.keys(votes).length,
    member_count: session.trip?.members?.length || 0
  };
}

async function recordVote(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) return json(res, 404, { error: '会话不存在' });
  const body = await readJsonBody(req);
  const member = String(body.member || '').trim();
  const candidateIds = [...new Set(Array.isArray(body.candidate_ids) ? body.candidate_ids.map(String) : [])];
  if (!(session.trip?.members || []).some(item => item.name === member)) return json(res, 400, { error: '投票成员不在本次旅行中' });
  if (candidateIds.length < 1 || candidateIds.length > 2) return json(res, 400, { error: '每位成员必须选择 1 至 2 个方案' });
  const candidates = session.final?.candidates || [];
  const selected = candidateIds.map(id => candidates.find(candidate => candidate.id === id));
  if (selected.some(candidate => !candidate)) return json(res, 400, { error: '候选方案不存在' });
  if (selected.some(candidate => candidate.assessment?.verdict !== 'PASS' && !candidate.negotiation_direction)) return json(res, 409, { error: '该方案既未通过硬约束，也没有明确协商方向' });
  session.votes = session.votes || {};
  session.votes[member] = candidateIds;
  session.voting_updated_at = new Date().toISOString();
  await saveSession(session);
  return json(res, 200, votingSnapshot(session));
}

async function serveStatic(req, res) {
  let requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (requested === '/') requested = '/index.html';
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        runtime: 'real-agent',
        model: { configured: Boolean(MODEL_API_KEY), base_url: MODEL_BASE_URL, name: MODEL_NAME },
        tencent_map: { configured: Boolean(TENCENT_MAP_KEY), provider: '腾讯地图 WebService' },
        persistence: 'data/sessions.json'
      });
    }
    const resolveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && resolveMatch) return resolveConsensus(req, res, resolveMatch[1]);
    const voteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/votes$/);
    if (req.method === 'POST' && voteMatch) return recordVote(req, res, voteMatch[1]);
    if (req.method === 'GET' && voteMatch) {
      const session = await getSession(voteMatch[1]);
      return session ? json(res, 200, votingSnapshot(session)) : json(res, 404, { error: '会话不存在' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      const session = await getSession(url.pathname.split('/').pop());
      return session ? json(res, 200, { ...session, voting: votingSnapshot(session) }) : json(res, 404, { error: '会话不存在' });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/run') return runAgent(req, res);
    return serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`同行真实 Agent 已启动：http://127.0.0.1:${PORT}`);
  console.log(`模型：${MODEL_NAME}（${MODEL_API_KEY ? '已配置' : '未配置'}）`);
  console.log(`腾讯地图 WebService：${TENCENT_MAP_KEY ? '已配置' : '未配置'}`);
});