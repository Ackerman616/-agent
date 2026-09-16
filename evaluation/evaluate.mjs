import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluationDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(evaluationDir);
const defaultCasePath = path.join(evaluationDir, 'cases', 'beijing-friends-001.json');
const defaultRunPath = path.join(projectRoot, 'data', 'test-run.ndjson');
const defaultOutputPath = path.join(projectRoot, 'data', 'evaluation-report.json');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true;
    result[name] = value;
  }
  return result;
}

function resolveProjectPath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timeToMinutes(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesBetween(start, end) {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes === null || endMinutes === null) return null;
  return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 1440 - startMinutes;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[\s·—_（）()\-]/g, '');
}

function includesKeyword(text, keyword) {
  return normalizeText(text).includes(normalizeText(keyword));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function check(id, label, status, details) {
  return { id, label, status, details };
}

function scoreChecks(checks) {
  const total = checks.length;
  const passed = checks.filter(item => item.status === 'PASS').length;
  const failed = checks.filter(item => item.status === 'FAIL').length;
  const unknown = checks.filter(item => item.status === 'UNKNOWN').length;
  return {
    total,
    passed,
    failed,
    unknown,
    verified_pass_rate: total ? round(passed / total * 100) : 0,
    all_passed: total > 0 && passed === total
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loadRun(args) {
  if (args.session) {
    const sessions = await readJson(path.join(projectRoot, 'data', 'sessions.json'));
    let session;
    if (args.session === 'latest') {
      session = Object.values(sessions)
        .filter(item => item.status === 'completed')
        .sort((a, b) => String(b.completed_at || b.created_at).localeCompare(String(a.completed_at || a.created_at)))[0];
    } else {
      session = sessions[args.session];
    }
    if (!session) throw new Error(`找不到会话：${args.session}`);
    return {
      source: `session:${session.id}`,
      events: asArray(session.events),
      final: session.final,
      trip: session.trip,
      caseId: session.evaluation_case_id || null,
      startedAt: session.created_at,
      completedAt: session.completed_at
    };
  }

  const runPath = resolveProjectPath(args.ndjson, defaultRunPath);
  const raw = await fs.readFile(runPath, 'utf8');
  const events = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const testCaseEvent = events.find(item => item.event === 'test_case');
  const finalEvent = [...events].reverse().find(item => item.event === 'final');
  const assessCall = events.find(item => item.event === 'tool_call' && item.data?.name === 'assess_itinerary');
  return {
    source: path.relative(projectRoot, runPath),
    events,
    final: finalEvent?.data || null,
    trip: assessCall?.data?.arguments?.trip || null,
    caseId: testCaseEvent?.data?.case_id || null,
    startedAt: events.find(item => item.at)?.at,
    completedAt: [...events].reverse().find(item => item.at)?.at
  };
}

function getToolHistory(events) {
  const calls = [];
  const results = [];
  const errors = [];
  const models = [];
  let replans = 0;

  for (const event of events) {
    if (event.event === 'tool_call') calls.push(event.data);
    if (event.event === 'tool_result') results.push(event.data);
    if (event.event === 'tool_error') errors.push(event.data);
    if (event.event === 'model') models.push(event.data);
    if (event.event === 'replan') replans += 1;
    if (event.type === 'tool') {
      calls.push({ turn: event.turn, id: event.id, name: event.name, arguments: event.arguments });
      if (event.result?.error) errors.push({ turn: event.turn, id: event.id, name: event.name, error: event.result.error });
      else results.push({ turn: event.turn, id: event.id, name: event.name, result: event.result });
    }
    if (event.type === 'model') models.push(event);
  }
  return { calls, results, errors, models, replans };
}

function tripFingerprint(trip) {
  if (!trip) return '';
  return JSON.stringify({
    destination: trip.destination,
    origin: trip.origin,
    start_at: trip.start_at,
    days: trip.days,
    nights: trip.nights,
    return_deadline: trip.return_deadline,
    members: asArray(trip.members).map(member => ({
      name: member.name,
      budget_max: member.budget_max,
      walking_limit_km: member.walking_limit_km,
      earliest_start: member.earliest_start,
      latest_end: member.latest_end,
      must_visit: member.must_visit
    }))
  });
}

function candidateList(final) {
  if (Array.isArray(final?.candidates)) return final.candidates;
  if (Array.isArray(final?.plans)) return final.plans;
  if (final?.itinerary) return [{ id: 'single-plan', type: 'unspecified', itinerary: final.itinerary }];
  return [];
}

function itineraryOf(candidate) {
  return candidate?.itinerary || candidate?.plan || candidate;
}

function textOfItinerary(itinerary) {
  return asArray(itinerary?.days).flatMap(day => asArray(day.items)).map(item => [
    item.place?.title,
    item.activity,
    item.reason,
    ...asArray(item.tags)
  ].join(' ')).join(' ');
}

function memberParticipates(item, memberName) {
  const participants = asArray(item?.participants);
  return participants.length === 0 || participants.includes(memberName);
}

function allItems(itinerary) {
  return asArray(itinerary?.days).flatMap(day => asArray(day.items));
}

function requirementSatisfied(requirement, itinerary, candidate, memberName) {
  const items = allItems(itinerary).filter(item => memberParticipates(item, memberName));
  const itemText = items.map(item => `${item.place?.title || ''} ${item.activity || ''} ${asArray(item.tags).join(' ')}`).join(' ');
  const requirementText = String(requirement);

  if (requirementText.includes('至少一个自然景观')) {
    return items.some(item => asArray(item.tags).some(tag => ['nature', 'park', 'lake'].includes(tag)));
  }
  if (requirementText.includes('特色餐饮')) {
    return items.some(item => asArray(item.tags).includes('food') && (finiteNumber(item.estimated_cost) ?? Infinity) <= 80);
  }

  const alternatives = requirementText.split('或').map(value => value.replace(/区域|至少体验一次|人均.*$/g, '').trim()).filter(Boolean);
  if (alternatives.some(value => includesKeyword(itemText, value))) return true;

  const branches = asArray(candidate?.branches || itinerary?.branches);
  return branches.some(branch => {
    const branchText = `${branch.place?.title || ''} ${branch.title || ''} ${branch.activity || ''}`;
    const matches = alternatives.some(value => includesKeyword(branchText, value));
    const participants = asArray(branch.participants);
    const confirmed = branch.confirmation_status === 'confirmed' || branch.confirmed === true;
    return matches && participants.includes(memberName) && confirmed;
  });
}

function walkingValues(itinerary, memberName) {
  const perMember = itinerary?.member_daily_walking_km?.[memberName];
  if (Array.isArray(perMember)) return perMember.map(finiteNumber);
  if (Array.isArray(itinerary?.daily_walking_km)) return itinerary.daily_walking_km.map(finiteNumber);
  return null;
}

function evaluateHardConstraints(candidate, trip) {
  const itinerary = itineraryOf(candidate);
  const members = asArray(trip.members);
  const days = asArray(itinerary?.days);
  const checks = [];

  checks.push(check('output_days', '行程天数一致', days.length === Number(trip.days) ? 'PASS' : 'FAIL', `期望 ${trip.days} 天，实际 ${days.length} 天`));

  const budget = finiteNumber(itinerary?.estimated_budget_per_person);
  if (budget === null) {
    checks.push(check('budget', '成员预算上限', 'UNKNOWN', '缺少人均预算'));
  } else {
    const exceeded = members.filter(member => budget > Number(member.budget_max));
    checks.push(check('budget', '成员预算上限', exceeded.length ? 'FAIL' : 'PASS', exceeded.length ? `超过：${exceeded.map(item => item.name).join('、')}` : `人均预计 ¥${budget}`));
  }

  const lastItem = asArray(days.at(-1)?.items).at(-1);
  const deadline = timeToMinutes(trip.return_deadline);
  const returnTime = timeToMinutes(lastItem?.end_time);
  const returnedToOrigin = includesKeyword(lastItem?.place?.title, trip.origin);
  if (deadline === null || returnTime === null || !lastItem?.place?.title) {
    checks.push(check('return_deadline', '返程地点与截止时间', 'UNKNOWN', '缺少返程地点或时间'));
  } else {
    checks.push(check('return_deadline', '返程地点与截止时间', returnedToOrigin && returnTime <= deadline ? 'PASS' : 'FAIL', `最后节点：${lastItem.place.title} ${lastItem.end_time}`));
  }

  for (const member of members) {
    const memberItemsByDay = days.map(day => asArray(day.items).filter(item => memberParticipates(item, member.name)));
    const earliest = timeToMinutes(member.earliest_start);
    const latest = timeToMinutes(member.latest_end);
    const scheduleViolations = [];
    memberItemsByDay.forEach((items, index) => {
      if (!items.length) return;
      const first = timeToMinutes(items[0].start_time);
      const last = timeToMinutes(items.at(-1).end_time);
      if (earliest !== null && (first === null || first < earliest)) scheduleViolations.push(`Day ${index + 1} 早于 ${member.earliest_start}`);
      if (latest !== null && (last === null || last > latest)) scheduleViolations.push(`Day ${index + 1} 晚于 ${member.latest_end}`);
    });
    checks.push(check(`schedule_${member.id || member.name}`, `${member.name} 的可参与时间`, scheduleViolations.length ? 'FAIL' : 'PASS', scheduleViolations.join('；') || '共同活动时间符合要求'));

    const walking = walkingValues(itinerary, member.name);
    if (!walking || walking.some(value => value === null)) {
      checks.push(check(`walking_${member.id || member.name}`, `${member.name} 的步行上限`, 'UNKNOWN', '方案缺少可验证的每日步行公里数'));
    } else {
      const exceeded = walking.map((value, index) => ({ value, day: index + 1 })).filter(item => item.value > Number(member.walking_limit_km));
      checks.push(check(`walking_${member.id || member.name}`, `${member.name} 的步行上限`, exceeded.length ? 'FAIL' : 'PASS', exceeded.length ? exceeded.map(item => `Day ${item.day}: ${item.value}km`).join('；') : walking.map((value, index) => `Day ${index + 1}: ${value}km`).join('；')));
    }

    for (const requirement of asArray(member.must_visit)) {
      const satisfied = requirementSatisfied(requirement, itinerary, candidate, member.name);
      checks.push(check(`must_visit_${member.id || member.name}_${normalizeText(requirement)}`, `${member.name} 必去：${requirement}`, satisfied ? 'PASS' : 'FAIL', satisfied ? '已在共同路线或已确认支线中满足' : '未找到满足项或支线未经确认'));
    }

    const itineraryText = textOfItinerary(itinerary);
    const dietaryHits = asArray(member.dietary_rules?.forbidden_keywords).filter(keyword => includesKeyword(itineraryText, keyword));
    checks.push(check(`dietary_${member.id || member.name}`, `${member.name} 的饮食限制`, dietaryHits.length ? 'FAIL' : 'PASS', dietaryHits.length ? `命中禁忌：${dietaryHits.join('、')}` : '未发现明确禁忌关键词'));

    const rules = member.rules || {};
    if (rules.max_major_nodes_per_day) {
      const counts = days.map(day => asArray(day.items).filter(item => {
        const tags = asArray(item.tags);
        return !tags.some(tag => ['meet', 'return', 'transit', 'food', 'cafe', 'relax'].includes(tag));
      }).length);
      checks.push(check(`major_nodes_${member.id || member.name}`, `${member.name} 的主要节点上限`, counts.some(value => value > rules.max_major_nodes_per_day) ? 'FAIL' : 'PASS', `每日主要节点：${counts.join('、')}`));
    }
    if (rules.lunch_break_min) {
      const lunches = allItems(itinerary).filter(item => /午餐|午饭/.test(item.activity || ''));
      const durations = lunches.map(item => minutesBetween(item.start_time, item.end_time));
      const passed = lunches.length >= days.length && durations.every(value => value !== null && value >= rules.lunch_break_min);
      checks.push(check(`lunch_${member.id || member.name}`, `${member.name} 的午餐休息时长`, passed ? 'PASS' : 'FAIL', lunches.length ? `午餐时长：${durations.join('、')} 分钟` : '未找到明确午餐节点'));
    }
    if (rules.max_taxi_fare_per_ride) {
      const taxis = allItems(itinerary).filter(item => /taxi|打车/i.test(item.transport_from_previous?.mode || ''));
      const unknownFare = taxis.some(item => finiteNumber(item.transport_from_previous?.estimated_cost) === null);
      const exceeded = taxis.filter(item => finiteNumber(item.transport_from_previous?.estimated_cost) > rules.max_taxi_fare_per_ride);
      const status = exceeded.length ? 'FAIL' : unknownFare ? 'UNKNOWN' : 'PASS';
      checks.push(check(`taxi_${member.id || member.name}`, `${member.name} 的单次打车上限`, status, taxis.length ? `打车节点 ${taxis.length} 个` : '方案未安排打车'));
    }
    if (rules.max_continuous_transport_min) {
      const exceeded = allItems(itinerary).filter(item => memberParticipates(item, member.name) && finiteNumber(item.transport_from_previous?.duration_min) > rules.max_continuous_transport_min);
      checks.push(check(`transport_${member.id || member.name}`, `${member.name} 的连续乘车上限`, exceeded.length ? 'FAIL' : 'PASS', exceeded.length ? exceeded.map(item => `${item.place?.title}: ${item.transport_from_previous.duration_min} 分钟`).join('；') : '未发现超时路线'));
    }
  }

  const subgroupItems = allItems(itinerary).filter(item => asArray(item.participants).length > 0 && asArray(item.participants).length < members.length);
  const unconfirmed = subgroupItems.filter(item => item.confirmation_status !== 'confirmed' && item.confirmed !== true);
  checks.push(check('branch_confirmation', '个人或分组支线确认', unconfirmed.length ? 'FAIL' : 'PASS', unconfirmed.length ? `${unconfirmed.length} 个分组节点未经确认` : subgroupItems.length ? '所有分组节点均已确认' : '未使用分组支线'));

  return { checks, summary: scoreChecks(checks) };
}

function buildEvidenceContext(history) {
  const successfulRequestIds = new Set();
  const poiIds = new Set();
  const routeRequestIds = new Set();
  for (const event of history.results) {
    const requestId = event.result?.request_id;
    if (requestId) successfulRequestIds.add(requestId);
    if (event.name === 'search_places') {
      asArray(event.result?.places).forEach(place => poiIds.add(String(place.id)));
    }
    if (event.name === 'get_route' && requestId) routeRequestIds.add(requestId);
  }
  return { successfulRequestIds, poiIds, routeRequestIds };
}

function evaluateEvidence(candidate, final, context, origin) {
  const itinerary = itineraryOf(candidate);
  const evidence = asArray(candidate?.evidence).length ? candidate.evidence : asArray(final?.evidence);
  const references = evidence.map(item => item.request_id).filter(Boolean);
  const validReferences = references.filter(id => context.successfulRequestIds.has(id));
  const places = allItems(itinerary).filter(item => item.place?.id && !includesKeyword(item.place?.title, origin));
  const verifiedPlaces = places.filter(item => context.poiIds.has(String(item.place.id)));
  const routedItems = asArray(itinerary?.days).flatMap(day => asArray(day.items).filter((item, index, items) => index > 0 && String(item.place?.id) !== String(items[index - 1].place?.id)));
  const routeRefs = routedItems.map(item => item.transport_from_previous?.source_request_id).filter(Boolean);
  const validRouteRefs = routeRefs.filter(id => context.routeRequestIds.has(id));

  const referenceRate = references.length ? validReferences.length / references.length : 0;
  const placeRate = places.length ? verifiedPlaces.length / places.length : 0;
  const routeRate = routedItems.length ? validRouteRefs.length / routedItems.length : 0;
  const score = round((referenceRate + placeRate + routeRate) / 3 * 100);
  return {
    score,
    reference_valid_rate: round(referenceRate * 100),
    place_evidence_coverage: round(placeRate * 100),
    route_evidence_coverage: round(routeRate * 100),
    details: {
      references: `${validReferences.length}/${references.length}`,
      places: `${verifiedPlaces.length}/${places.length}`,
      routes: `${validRouteRefs.length}/${routedItems.length}`
    }
  };
}

function preferenceMatches(preference, itineraryText, tags) {
  return asArray(preference.tags).some(tag => tags.has(tag) || includesKeyword(itineraryText, tag)) || includesKeyword(itineraryText, preference.label);
}

function evaluateSatisfaction(candidate, trip) {
  const itinerary = itineraryOf(candidate);
  const text = textOfItinerary(itinerary);
  const tags = new Set(allItems(itinerary).flatMap(item => asArray(item.tags)));
  const memberScores = asArray(trip.members).map(member => {
    const high = asArray(member.soft_preferences?.high);
    const medium = asArray(member.soft_preferences?.medium);
    const possible = high.length * 3 + medium.length;
    const matchedHigh = high.filter(item => preferenceMatches(item, text, tags));
    const matchedMedium = medium.filter(item => preferenceMatches(item, text, tags));
    const earned = matchedHigh.length * 3 + matchedMedium.length;
    return {
      member: member.name,
      score: possible ? Math.round(earned / possible * 100) : 0,
      matched_high: matchedHigh.map(item => item.label),
      missed_high: high.filter(item => !matchedHigh.includes(item)).map(item => item.label),
      matched_medium: matchedMedium.map(item => item.label)
    };
  });
  const scores = memberScores.map(item => item.score);
  return {
    member_scores: memberScores,
    fairness_floor: scores.length ? Math.min(...scores) : 0,
    average_satisfaction: scores.length ? round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0,
    satisfaction_gap: scores.length ? Math.max(...scores) - Math.min(...scores) : 0
  };
}

function evaluateConsensus(final, candidates, testCase) {
  const expected = testCase.expected_product_behavior || {};
  const conflictText = asArray(final?.conflicts).map(item => `${item.title || ''} ${item.resolution || ''}`).join(' ');
  const conflictCoverage = asArray(expected.expected_conflicts).map(item => ({
    id: item.id,
    label: item.label,
    covered: asArray(item.keywords).some(keyword => includesKeyword(conflictText, keyword))
  }));
  const tradeoffs = [...asArray(final?.member_tradeoffs), ...candidates.flatMap(candidate => asArray(candidate?.member_tradeoffs))];
  const members = asArray(testCase.trip.members);
  const coveredMembers = members.filter(member => tradeoffs.some(item => item.member === member.name && asArray(item.gains).length && asArray(item.concessions).length));
  const titles = candidates.map(candidate => itineraryOf(candidate)?.title || candidate?.title).filter(Boolean);
  const uniqueTitles = new Set(titles).size;
  const expectedCount = Number(expected.candidate_count || 3);
  const conflictRate = conflictCoverage.length ? conflictCoverage.filter(item => item.covered).length / conflictCoverage.length : 0;
  const tradeoffRate = members.length ? coveredMembers.length / members.length : 0;
  const countRate = Math.min(candidates.length / expectedCount, 1);
  const differentiationRate = candidates.length ? uniqueTitles / candidates.length : 0;
  const negotiationDirections = candidates.map(candidate => candidate.negotiation_direction).filter(Boolean);
  const requiredDirections = ['subgroup', 'downgrade_must_visit', 'relax_walking'];
  const negotiationReady = requiredDirections.every(direction => negotiationDirections.includes(direction))
    && candidates.every(candidate => asArray(candidate.required_confirmations).length > 0 && asArray(candidate.relaxed_constraints).length === 1);
  return {
    score: round((countRate + conflictRate + tradeoffRate + differentiationRate) / 4 * 100),
    candidate_count: candidates.length,
    expected_candidate_count: expectedCount,
    candidate_count_passed: candidates.length === expectedCount,
    unique_candidate_titles: uniqueTitles,
    negotiation_directions: negotiationDirections,
    negotiation_ready: negotiationReady,
    conflict_coverage_rate: round(conflictRate * 100),
    conflicts: conflictCoverage,
    member_tradeoff_coverage: round(tradeoffRate * 100),
    voting_rule: expected.voting
  };
}

function evaluateReliability(run, history) {
  const requiredTools = ['search_places', 'get_route', 'assess_itinerary'];
  const calledTools = new Set(history.calls.map(item => item.name));
  const callsByTurn = new Map();
  history.calls.filter(item => item.turn !== undefined).forEach(item => callsByTurn.set(item.turn, (callsByTurn.get(item.turn) || 0) + 1));
  const maxCallsPerTurn = callsByTurn.size ? Math.max(...callsByTurn.values()) : Math.min(history.calls.length ? 1 : 0, 1);
  const tokens = history.models.reduce((sum, item) => sum + (finiteNumber(item.usage?.total_tokens) || 0), 0);
  const started = Date.parse(run.startedAt || '');
  const completed = Date.parse(run.completedAt || '');
  const duration = Number.isFinite(started) && Number.isFinite(completed) ? round((completed - started) / 1000) : null;
  const checks = [
    Boolean(run.final?.status === 'final'),
    requiredTools.every(name => calledTools.has(name)),
    history.errors.length === 0,
    maxCallsPerTurn <= 3
  ];
  return {
    score: round(checks.filter(Boolean).length / checks.length * 100),
    completed: Boolean(run.final?.status === 'final'),
    required_tools_called: requiredTools.filter(name => calledTools.has(name)),
    missing_required_tools: requiredTools.filter(name => !calledTools.has(name)),
    tool_calls: history.calls.length,
    tool_errors: history.errors.length,
    replans: history.replans,
    model_turns: history.models.length,
    max_tool_calls_per_turn: maxCallsPerTurn,
    total_tokens: tokens,
    duration_seconds: duration
  };
}

export async function evaluateRun({ run, testCase }) {
  const history = getToolHistory(run.events);
  const context = buildEvidenceContext(history);
  const candidates = candidateList(run.final);
  const caseMatched = run.caseId === testCase.id || tripFingerprint(run.trip) === tripFingerprint(testCase.trip);
  const candidateReports = candidates.map((candidate, index) => {
    const hard = evaluateHardConstraints(candidate, testCase.trip);
    const evidence = evaluateEvidence(candidate, run.final, context, testCase.trip.origin);
    const satisfaction = evaluateSatisfaction(candidate, testCase.trip);
    return {
      candidate_index: index + 1,
      candidate_id: candidate.id || null,
      candidate_type: candidate.type || candidate.strategy || 'unspecified',
      title: itineraryOf(candidate)?.title || candidate.title || `方案 ${index + 1}`,
      hard_constraints: hard,
      evidence,
      satisfaction,
      qualified: hard.summary.all_passed && evidence.score >= 90
    };
  });
  const consensus = evaluateConsensus(run.final, candidates, testCase);
  const reliability = evaluateReliability(run, history);
  const hardScore = candidateReports.length ? Math.min(...candidateReports.map(item => item.hard_constraints.summary.verified_pass_rate)) : 0;
  const evidenceScore = candidateReports.length ? Math.min(...candidateReports.map(item => item.evidence.score)) : 0;
  const overall = round(hardScore * 0.4 + evidenceScore * 0.25 + consensus.score * 0.2 + reliability.score * 0.15);
  const qualified = caseMatched && candidates.length === Number(testCase.expected_product_behavior?.candidate_count || 3) && candidateReports.length > 0 && candidateReports.every(item => item.qualified);

  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    case: { id: testCase.id, title: testCase.title, matched: caseMatched },
    run: { source: run.source, case_id: run.caseId, status: run.final?.status || 'missing_final' },
    qualified,
    overall_score: overall,
    score_breakdown: {
      hard_constraints: hardScore,
      evidence: evidenceScore,
      consensus: consensus.score,
      reliability: reliability.score
    },
    candidate_reports: candidateReports,
    consensus,
    reliability,
    manual_review: testCase.manual_review,
    interpretation: qualified
      ? '该次运行达到自动评测门槛，仍需完成人工评审与真实成员投票。'
      : '该次运行未达到产品级合格门槛；UNKNOWN 不视为通过，请根据失败项补充字段、证据或重新规划。'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casePath = resolveProjectPath(args.case, defaultCasePath);
  const outputPath = resolveProjectPath(args.output, defaultOutputPath);
  const [testCase, run] = await Promise.all([readJson(casePath), loadRun(args)]);
  const report = await evaluateRun({ run, testCase });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`案例：${report.case.id}（${report.case.matched ? '匹配' : '不匹配'}）`);
  console.log(`候选方案：${report.consensus.candidate_count}/${report.consensus.expected_candidate_count}`);
  console.log(`总分：${report.overall_score}`);
  console.log(`硬约束 / 证据 / 共识 / 稳定性：${report.score_breakdown.hard_constraints} / ${report.score_breakdown.evidence} / ${report.score_breakdown.consensus} / ${report.score_breakdown.reliability}`);
  console.log(`自动评测结论：${report.qualified ? 'QUALIFIED' : 'NOT_QUALIFIED'}`);
  console.log(`报告：${outputPath}`);
  if (!report.qualified) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(`评测失败：${error.message}`);
    process.exitCode = 1;
  });
}
