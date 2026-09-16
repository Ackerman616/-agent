import fs from 'node:fs/promises';

const testCase = JSON.parse(await fs.readFile(new URL('./evaluation/cases/beijing-friends-001.json', import.meta.url), 'utf8'));
const trip = testCase.trip;

const baseUrl = (process.env.AGENT_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const response = await fetch(`${baseUrl}/api/agent/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ trip, evaluation_case_id: testCase.id })
});

if (!response.ok) {
  console.error('HTTP', response.status, await response.text());
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const events = [{
  event: 'test_case',
  at: new Date().toISOString(),
  data: { case_id: testCase.id, title: testCase.title }
}];

while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const event = JSON.parse(line);
    events.push(event);
    if (['tool_call', 'tool_result', 'tool_error', 'replan', 'final', 'blocked', 'error'].includes(event.event)) {
      const label = event.data?.name || event.data?.status || event.data?.message || event.data?.reason || '';
      console.log(`${event.event}: ${label}`);
    }
  }
  if (done) break;
}

await fs.writeFile(new URL('./data/test-run.ndjson', import.meta.url), events.map(x => JSON.stringify(x)).join('\n') + '\n');
const final = events.find(x => x.event === 'final');
const toolCalls = events.filter(x => x.event === 'tool_call').map(x => x.data.name);
const toolResults = events.filter(x => x.event === 'tool_result');
const replans = events.filter(x => x.event === 'replan').length;
console.log(JSON.stringify({
  evaluation_case_id: testCase.id,
  events: events.length,
  tool_calls: toolCalls,
  tool_results: toolResults.length,
  replans,
  completed: Boolean(final),
  session_id: final?.data?.session_id || events.find(x => x.event === 'session')?.data?.session_id || null,
  candidate_count: final?.data?.candidates?.length || 0,
  final_title: final?.data?.candidates?.[0]?.title || final?.data?.itinerary?.title || null
}, null, 2));

if (!final || final.data?.candidates?.length !== 3 || !toolCalls.includes('search_places') || !toolCalls.includes('get_route') || !toolCalls.includes('assess_itinerary')) {
  process.exit(2);
}
