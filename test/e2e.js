// End-to-end check: boots the server on a spare port with a fresh data dir and runs every demo flow.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hirebuddy-'));
const env = { ...process.env, PORT, DATA_DIR: dir, LLM_API_KEY: '', PUBLIC_URL: '', RENDER_EXTERNAL_URL: '' };
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });
const base = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(prompt, listings) {
  const { id } = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, listings }) }).then(r => r.json());
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const r = await fetch(`${base}/api/runs/${id}`).then(r => r.json());
    if (r.status !== 'running') return r;
  }
  throw new Error('timeout');
}

const NADIA = "I'm Nadia Rahim. I'm blind and use NVDA. I live in Subang Jaya and take the LRT. I did customer service calls at a bank hotline for a year and type fast in English and Malay. Free weekdays 9am to 5pm, at least RM12 an hour, phone interviews please.";
const cases = [
  ['blind seeker (Nadia)', NADIA, r => r.verified && r.persona === 'student' && r.interviews.length === 3 && (r.decisions || []).length >= 1
    && !r.events.some(e => e.type === 'tool_call' && e.tool === 'apply_to_job' && e.args.jobId === 'job-delivery-subang')],
  ['low vision, remote only', "I'm Nur Aqilah, I have low vision and use a screen magnifier. Remote work only. I write Malay articles and captions. Free Mon, Wed and Fri 10am-6pm.",
    r => r.verified && r.interviews.length >= 1 && r.events.filter(e => e.type === 'tool_result' && e.tool === 'book_interview' && e.ok).every(e => e.result.format === 'video')],
  ['hirer', 'Need a weekend barista in Subang, RM12/hr, start next week', r => r.verified && r.jobId && r.interviews.length >= 2],
  ['illegal wage', 'Need a cashier for my kedai in USJ, RM7/hr, weekends', r => r.verified && !r.jobId && /below the legal minimum/.test(r.summary)],
  ['student', "I'm Aisyah from Sunway University, living in Bandar Sunway. I can make espresso and do latte art, good with customers. Free weekends 8am-2pm, want at least RM11/hr.", r => r.verified && r.persona === 'student' && r.applications.length >= 1],
  ['RM50-60/day refused', 'Need a weekend cashier in Subang, RM50-60 a day, 8-hour shifts', r => r.verified && !r.jobId && /an 8-hour shift that is about RM6.25 an hour/.test(r.summary) && r.plan.some(s => s.status === 'skipped')],
  ['RM8.50 refused', 'Need a part-time barista in Subang Jaya, RM8.50/hr, weekends', r => r.verified && !r.jobId && /RM8.72/.test(r.summary)],
  ['tutor', 'Looking for an SPM maths tutor in Subang Jaya, RM30/hr, Saturday mornings', r => r.verified && r.interviews.length >= 1],
  ['replans (Cyberjaya)', 'Need 3 weekend baristas in Cyberjaya, must have latte art and Mandarin, RM13/hr',
    r => r.verified && (r.decisions || []).length >= 2 && r.interviews.length >= 2 && r.events.some(e => e.tool === 'relax_requirement' && e.ok)],
];

(async () => {
  await sleep(800);
  let fail = 0;
  for (const [name, prompt, ok] of cases) {
    const r = await run(prompt);
    const pass = !!ok(r);
    if (!pass) fail++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${r.summary}`);
  }
  const aina = await fetch(`${base}/api/me/student/stu-aina`).then(r => r.json());
  const booked = aina.mine.some(a => a.status === 'interview' && a.interview?.when);
  if (!booked) fail++;
  console.log(`${booked ? 'PASS' : 'FAIL'} student view: Aina sees ${aina.mine.map(a => `${a.title}=${a.status}`).join(', ')}`);
  // Aina declines her MIXUE-style interview: the agent must book the next best person, never Aina again.
  const ainaIv = aina.mine.find(a => a.status === 'interview' && a.title === 'Weekend Barista' && a.area === 'Subang Jaya')?.interview;
  const dec = await fetch(`${base}/api/interviews/${ainaIv.id}/decline`, { method: 'POST' }).then(r => r.json());
  let rr;
  for (let i = 0; i < 60; i++) { await sleep(250); rr = await fetch(`${base}/api/runs/${dec.runId}`).then(r => r.json()); if (rr.status !== 'running') break; }
  const after = await fetch(`${base}/api/me/student/stu-aina`).then(r => r.json());
  const replacement = rr.interviews.length === 1 && !rr.events.some(e => e.tool === 'schedule_interviews' && e.result?.scheduled?.some(s => s.candidateId === 'stu-aina'));
  const declineOk = rr.verified && rr.source === 'decline' && replacement && rr.decisions.length >= 1 && after.mine.some(a => a.status === 'declined');
  if (!declineOk) fail++;
  console.log(`${declineOk ? 'PASS' : 'FAIL'} decline: ${rr.summary}`);
  // Nadia can't make her first interview: the agent finds another time with the same employer.
  const nadia = await fetch(`${base}/api/me/student/stu-nadia`).then(r => r.json());
  const first = nadia.mine.find(a => a.status === 'interview');
  const res2 = await fetch(`${base}/api/interviews/${first.interview.id}/decline`, { method: 'POST' }).then(r => r.json());
  let rs;
  for (let i = 0; i < 80; i++) { await sleep(250); rs = await fetch(`${base}/api/runs/${res2.runId}`).then(r => r.json()); if (rs.status !== 'running') break; }
  const moved = await fetch(`${base}/api/me/student/stu-nadia`).then(r => r.json());
  const now = moved.mine.find(a => a.jobId === first.jobId);
  const reOk = rs.verified && now.status === 'interview' && now.interview.start !== first.interview.start && rs.decisions.length >= 1;
  if (!reOk) fail++;
  console.log(`${reOk ? 'PASS' : 'FAIL'} can't make it, rebooked: ${rs.summary}`);
  // WorkBuddy passes jobs it found on real sites: each is checked, suitable ones get a draft, nothing is sent.
  const found = [
    { title: 'Customer Service Executive (Inbound Calls)', employer: 'Example Telco', site: 'JobStreet', url: 'https://example.com/1', pay: 'RM2,600 - RM3,000 per month', location: 'Subang Jaya', hours: 'Mon - Fri, 9am - 6pm', description: 'Answer customer calls in English and Malay. Near SS15 LRT.' },
    { title: 'Despatch Rider', employer: 'Example Courier', site: 'Indeed', pay: 'RM1,800 a month', location: 'Petaling Jaya', description: 'Own motorcycle and valid driving licence required.' },
    { title: 'Part-time Call Agent', employer: 'Example Contact Centre', site: 'Hiredly', pay: 'RM9 per hour', location: 'Remote', hours: 'Weekdays 9am to 1pm', description: 'Work from home. OKU candidates welcome.' },
    { title: 'Customer Service Representative' }, // a bare search snippet: no pay or hours, so they become questions
  ];
  const ro = await run(NADIA, found);
  const emailsBefore = ro.events.filter(e => e.type === 'tool_result' && e.tool === 'send_email').length;
  const o = ro.events.find(e => e.type === 'tool_result' && e.tool === 'check_outside_listings')?.result;
  const outOk = ro.verified && o && o.checked === 4 && o.results[0].verdict === 'worth asking' && /NVDA/.test(o.results[0].draft)
    && o.results.slice(1, 3).every(r => r.verdict === 'not suitable')
    && o.results[3].verdict === 'worth asking' && /What is the pay\?/.test(o.results[3].draft) && /working hours/.test(o.results[3].draft) && /nothing was sent/.test(ro.summary) && emailsBefore === 0;
  if (!outOk) fail++;
  console.log(`${outOk ? 'PASS' : 'FAIL'} other-site listings: ${ro.summary.slice(ro.summary.indexOf('I also checked'))}`);
  // WorkBuddy-led: the client calls the four steps itself, following `next`, and widens the search once.
  const mcpCall = async (name, args) => JSON.parse((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }) }).then(r => r.json())).result.content[0].text);
  let st = await mcpCall('hirebuddy_1_understand', { prompt: NADIA.replace('Nadia Rahim', 'Nadia Rahman'), listings: found.slice(3) });
  const runId = st.runId, trail = ['1'];
  for (let i = 0; i < 8 && st.next; i++) {
    const tool = (st.next.match(/hirebuddy_\w+/) || [])[0];
    if (!tool) break;
    const args = { runId };
    if (tool === 'hirebuddy_3_apply_and_book') args.jobIds = JSON.parse(st.next.match(/jobIds (\[.*?\])/)[1]);
    const ch = st.next.match(/change "(\w+)"/) || st.next.match(/Suggested: (\w+)/);
    if (tool === 'hirebuddy_2_check_jobs' && ch) Object.assign(args, { change: ch[1], reason: 'adds a job without giving up a stated need' });
    st = await mcpCall(tool, args);
    trail.push(tool.match(/_(\d)_/)[1] + (args.change ? '+' : ''));
    if (tool === 'hirebuddy_4_verify') break;
  }
  const stepsOk = st.verified && /You have 3 interviews/.test(st.summary) && trail.includes('2+') && st.saveToComputer.files.some(f => /\.ics$/.test(f.path) && /BEGIN:VCALENDAR/.test(f.content))
    && st.saveToComputer.files.some(f => /Application/.test(f.path));
  if (!stepsOk) fail++;
  console.log(`${stepsOk ? 'PASS' : 'FAIL'} WorkBuddy-led steps (${trail.join(' > ')}): ${(st.summary || st.problem || '').split('\n')[0]} ${st.selfChecks?.length} checks`);
  // Refusing an option that gives up a stated need (her pay floor).
  const no = await mcpCall('hirebuddy_2_check_jobs', { runId, change: 'lower_pay_floor', reason: 'more jobs' });
  const noOk = no.ok === false && /only they can choose/.test(no.problem);
  if (!noOk) fail++;
  console.log(`${noOk ? 'PASS' : 'FAIL'} step tools refuse to lower her pay floor: ${no.problem}`);
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(r => r.json());
  const mcpOk = mcp.result.tools.some(t => t.name === 'hirebuddy_run');
  if (!mcpOk) fail++;
  console.log(`${mcpOk ? 'PASS' : 'FAIL'} mcp: ${mcp.result.tools.length} tools listed`);
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
