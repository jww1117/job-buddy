// HireBuddy web server: live agent console, public job pages, outbox, calendar files, REST + MCP endpoints.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./src/store');
const L = require('./src/lib');
const agent = require('./src/agent');
const mcp = require('./src/mcp');
const llm = require('./src/llm');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data));
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// One shell for every page: skip link, labelled landmarks, the current page marked for screen readers,
// and a text-size control that is applied before first paint.
const NAV = [['/', 'Find work'], ['/me', 'My page'], ['/jobs', 'Jobs'], ['/outbox', 'Emails'], ['/about', 'How it works']];
function page(title, inner, { current = '', scripts = '', description = 'HireBuddy: say what work you want in one sentence. An agent finds jobs that suit blind and low-vision people, applies, books interviews and checks its own work.' } = {}) {
  const nav = NAV.map(([href, label]) => `<li><a href="${href}"${href === current ? ' aria-current="page"' : ''}${href === '/me' ? ' id="me-link"' : ''}>${label}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · HireBuddy</title><meta name="description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap">
<link rel="stylesheet" href="/style.css">
<script>try{var z=localStorage.getItem('hirebuddy.size');if(z&&z!=='normal')document.documentElement.dataset.size=z;}catch(e){}</script>
</head><body>
<a class="skip" href="#main">Skip to main content</a>
<header class="top"><div class="top-inner">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="36" height="36">HireBuddy</a>
<nav aria-label="Main"><ul>${nav}</ul></nav>
<div class="textsize" role="group" aria-label="Text size"><span aria-hidden="true">Text size</span>
<button type="button" class="secondary" data-size="normal" aria-label="Normal text">A</button><button type="button" class="secondary" data-size="large" aria-label="Large text">A+</button><button type="button" class="secondary" data-size="larger" aria-label="Largest text">A++</button></div>
</div></header>
<main id="main" tabindex="-1">${inner}</main>
<footer><p>Screen-reader and keyboard friendly. Demo people and employers are fictional.</p></footer>
<script src="/common.js"></script>${scripts}
</body></html>`;
}

function staticPage(file) {
  const raw = fs.readFileSync(path.join(PUBLIC, 'pages', file), 'utf8');
  const meta = (raw.match(/^<!--\s*(\{.*\})\s*-->/) || [])[1];
  return { opts: meta ? JSON.parse(meta) : {}, body: raw.replace(/^<!--.*-->\n?/, '') };
}

function accessFacts(j) {
  const a = j.access || {};
  const mode = a.workMode || 'on-site';
  const rows = [['Where you work', mode === 'remote' ? 'Remote, from home' : `${mode === 'hybrid' ? 'Hybrid: partly from home, partly' : 'On site'} in ${j.area}`]];
  if (mode !== 'remote') rows.push(['Getting there', a.transit ? `${a.transit.walkMin}-minute walk from ${a.transit.station}` : 'No train or bus stop listed']);
  rows.push(['Screen readers', a.computerWork === false ? 'Not needed: no computer work' : (a.assistiveTech || []).length ? `Supported: ${a.assistiveTech.join(', ')}` : 'Not stated. HireBuddy asks the employer for you']);
  rows.push(['Tasks that need sight', (a.sightTasks || []).length ? a.sightTasks.join('; ') : 'None listed']);
  rows.push(['Interview', (a.interviewFormats || ['in person']).join(', ')]);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function jobView(j, base) {
  const apps = store.db.applications.filter(a => a.jobId === j.id);
  const wage = L.checkWage(j.pay, j.payUnit);
  return page(`${j.title} at ${j.business}`, `
<article aria-labelledby="job-title">
  <h1 id="job-title">${esc(j.title)}</h1>
  <p class="lede">${esc(j.business)}, ${esc(j.area)}</p>
  <dl class="facts">
    <dt>Pay</dt><dd>RM${esc(j.pay)} per ${esc(j.payUnit)}. <span class="status-word ${wage.ok ? 'good' : 'bad'}">${wage.ok ? 'Meets the legal minimum wage' : 'Below the legal minimum wage'}</span></dd>
    <dt>Hours</dt><dd>${esc(L.describeSchedule(j.schedule))}</dd>
    ${j.startDate ? `<dt>Starts</dt><dd>${esc(j.startDate)}</dd>` : ''}
    <dt>Must have</dt><dd>${esc(j.requirements.join(', '))}</dd>
    ${j.niceToHave?.length ? `<dt>Nice to have</dt><dd>${esc(j.niceToHave.join(', '))}</dd>` : ''}
  </dl>
  <h2>About the job</h2>
  <p>${esc(j.description)}</p>
  <h2>Access</h2>
  ${accessFacts(j)}
  <p class="small">${apps.length} applicant${apps.length === 1 ? '' : 's'} so far. ${j.runId ? `Posted by <a href="/runs/${esc(j.runId)}">the HireBuddy agent</a>.` : ''} ${j.seed ? '<a href="/about#demo-data">Demo data</a>.' : ''}</p>
</article>
<section aria-labelledby="apply-title">
  <h2 id="apply-title">Apply</h2>
  <p>Or let HireBuddy apply for you from <a href="/">one sentence</a>.</p>
  <form method="post" action="/jobs/${esc(j.id)}/apply">
    <p><label for="f-name">Name</label><input id="f-name" name="name" type="text" autocomplete="name" required></p>
    <p><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required></p>
    <p><label for="f-area">Where you live</label><span class="hint" id="f-area-hint">For example Subang Jaya</span><input id="f-area" name="area" type="text" aria-describedby="f-area-hint" required></p>
    <p><label for="f-skills">Skills</label><span class="hint" id="f-skills-hint">Separate them with commas</span><input id="f-skills" name="skills" type="text" aria-describedby="f-skills-hint"></p>
    <p><label for="f-free">When you are free</label><span class="hint" id="f-free-hint">For example weekdays 9am to 5pm</span><input id="f-free" name="free" type="text" aria-describedby="f-free-hint"></p>
    <p><label for="f-bio">About you</label><textarea id="f-bio" name="bio" rows="4"></textarea></p>
    <button type="submit">Send application</button>
  </form>
</section>`);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const base = baseUrl(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  // ---- MCP ----
  if (p === '/mcp') {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    return mcp.handle(req, res, await readBody(req), base, url.searchParams.get('tools') === 'all');
  }

  // ---- API ----
  if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\nDisallow: /reset\n'); }
  if (p === '/health') return json(res, 200, { ok: true, mode: llm.enabled() ? `llm:${llm.MODEL}` : 'autopilot', jobs: store.db.jobs.length, students: store.db.students.length });
  if (p === '/api/config') return json(res, 200, { llm: llm.enabled(), model: llm.enabled() ? llm.MODEL : null, email: !!process.env.RESEND_API_KEY });

  if (p === '/api/runs' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const prompt = String(body.prompt || '').trim().slice(0, 2000);
    if (!prompt) return json(res, 400, { error: 'prompt required' });
    const listings = Array.isArray(body.listings) && body.listings.length ? body.listings : null;
    const run = agent.newRun(prompt, ['hirer', 'student'].includes(body.persona) ? body.persona : listings ? 'student' : null, 'web', { listings });
    agent.execute(run, base);
    return json(res, 201, { id: run.id, persona: run.persona, url: `${base}/runs/${run.id}` });
  }
  if (p === '/api/runs' && req.method === 'GET') {
    return json(res, 200, store.db.runs.slice(-30).reverse().map(r => ({ id: r.id, prompt: r.prompt, persona: r.persona, status: r.status, verified: r.verified, createdAt: r.createdAt, source: r.source })));
  }
  let m;
  if ((m = p.match(/^\/api\/runs\/([\w-]+)$/))) {
    const run = store.db.runs.find(r => r.id === m[1]);
    return run ? json(res, 200, { ...run, links: agent.links(run, base) }) : json(res, 404, { error: 'not found' });
  }
  if ((m = p.match(/^\/api\/runs\/([\w-]+)\/stream$/))) {
    const run = store.db.runs.find(r => r.id === m[1]);
    if (!run) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const e of run.events) send(e);
    if (!agent.live.has(run.id)) { send({ type: 'end' }); return res.end(); }
    const fn = e => { send(e); if (e.type === 'final') { send({ type: 'end' }); cleanup(); res.end(); } };
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const cleanup = () => { clearInterval(ping); agent.bus.off(run.id, fn); };
    agent.bus.on(run.id, fn);
    req.on('close', cleanup);
    return;
  }
  if (p === '/api/jobs') {
    return json(res, 200, store.db.jobs.map(j => ({ ...j, url: `${base}/jobs/${j.id}`, applicants: store.db.applications.filter(a => a.jobId === j.id).length })));
  }
  if ((m = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
    const j = store.db.jobs.find(x => x.id === m[1]);
    if (!j) return json(res, 404, { error: 'not found' });
    const applicants = store.db.applications.filter(a => a.jobId === j.id).map(a => {
      const s = store.db.students.find(x => x.id === a.studentId);
      return { applicationId: a.id, name: s?.name, area: s?.area, score: a.score, at: a.at };
    });
    const interviews = store.db.interviews.filter(i => i.jobId === j.id).map(i => ({ name: i.name, when: i.when, start: i.start, status: i.status || 'booked', ics: `${base}/ics/${i.id}.ics` }));
    return json(res, 200, { ...j, url: `${base}/jobs/${j.id}`, applicants, interviews });
  }
  if (p === '/api/students') return json(res, 200, store.db.students.map(({ email, ...s }) => s));

  // ---- Role views (no passwords: you pick who you are, the browser remembers it) ----
  if (p === '/api/people') {
    const businesses = [...new Set(store.db.jobs.map(j => j.business))].reverse();
    return json(res, 200, {
      students: store.db.students.map(s => ({ id: s.id, name: s.name, area: s.area, campus: s.campus, needs: s.needs ? `${s.needs.vision}, uses ${s.needs.tool}` : null }))
        .sort((a, b) => !!b.needs - !!a.needs),
      businesses: businesses.map(b => ({ name: b, jobs: store.db.jobs.filter(j => j.business === b).length })),
    });
  }
  if ((m = p.match(/^\/api\/me\/student\/([\w-]+)$/))) {
    const s = store.db.students.find(x => x.id === m[1]);
    if (!s) return json(res, 404, { error: 'not found' });
    const jobIds = new Set([
      ...store.db.applications.filter(a => a.studentId === s.id).map(a => a.jobId),
      ...store.db.interviews.filter(i => i.studentId === s.id).map(i => i.jobId),
    ]);
    const mine = [...jobIds].map(jid => {
      const j = store.db.jobs.find(x => x.id === jid);
      if (!j) return null;
      const app = store.db.applications.find(a => a.jobId === jid && a.studentId === s.id);
      const iv = store.db.interviews.filter(i => i.jobId === jid && i.studentId === s.id).pop();
      const roundDone = store.db.interviews.some(i => i.jobId === jid);
      const status = iv ? (iv.status === 'declined' ? 'declined' : 'interview') : roundDone ? 'not_selected' : 'applied';
      return {
        jobId: j.id, title: j.title, business: j.business, area: j.area, pay: `RM${j.pay}/${j.payUnit}`, url: `${base}/jobs/${j.id}`,
        status, applied: !!app, appliedAt: app?.at || null, score: app?.score ?? L.scoreMatch(j, s).total,
        interview: iv ? { id: iv.id, when: iv.when, whenLong: iv.whenLong || L.fmtLong(new Date(iv.start)), start: iv.start, mode: iv.mode, format: iv.format || null, howToJoin: iv.howToJoin || null,
          status: iv.status || 'booked', meetUrl: iv.meetUrl || null, ics: `${base}/ics/${iv.id}.ics`, replanRunId: iv.replanRunId || null } : null,
        access: s.needs ? L.accessFit(j, s) : null,
        updatedAt: iv ? (store.db.emails.find(e => e.interviewId === iv.id)?.at || iv.start) : app?.at,
      };
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // Same matcher the agent uses, so "Suits you" here always agrees with what the agent would apply to.
    const open = require('./src/tools').matchJobs(s, { minPay: s.expectedRate || 0, maxDistanceKm: 60, askAboutTech: true })
      .filter(r => !jobIds.has(r.jobId) && r.legalPay)
      .map(r => { const j = store.db.jobs.find(x => x.id === r.jobId); return { jobId: r.jobId, title: r.title, business: r.business, area: r.area, pay: r.pay,
        schedule: L.describeSchedule(j.schedule), distanceKm: L.distanceKm(j.area, s.area), score: r.score, url: `${base}/jobs/${r.jobId}`,
        workMode: r.workMode, access: s.needs ? r.access : null, suitable: r.suitable, whyNot: r.whyNot }; });
    return json(res, 200, { student: { id: s.id, name: s.name, area: s.area, campus: s.campus, skills: s.skills, needs: s.needs || null, minPay: s.expectedRate || null, free: L.describeSchedule(s.availability || {}) }, mine, open });
  }
  if (p === '/api/me/business') {
    const name = url.searchParams.get('name') || '';
    const jobs = store.db.jobs.filter(j => j.business === name).reverse().map(j => {
      const ivs = store.db.interviews.filter(i => i.jobId === j.id).sort((a, b) => a.start.localeCompare(b.start));
      const apps = store.db.applications.filter(a => a.jobId === j.id);
      return {
        id: j.id, title: j.title, area: j.area, pay: `RM${j.pay}/${j.payUnit}`, schedule: L.describeSchedule(j.schedule),
        url: `${base}/jobs/${j.id}`, runId: j.runId || null, createdAt: j.createdAt || null,
        applicants: apps.map(a => ({ name: store.db.students.find(x => x.id === a.studentId)?.name, score: a.score, at: a.at }))
          .sort((a, b) => b.score - a.score),
        interviews: ivs.map(i => ({ name: i.name, when: i.when, ics: `${base}/ics/${i.id}.ics`, status: i.status || 'booked', replanRunId: i.replanRunId || null,
          score: L.scoreMatch(j, store.db.students.find(x => x.id === i.studentId) || {}).total })),
      };
    });
    return json(res, 200, { business: name, jobs });
  }
  // A student answers their invite. Declining hands the slot back to the agent, which books the next best candidate.
  if ((m = p.match(/^\/api\/interviews\/([\w-]+)\/(accept|decline)$/)) && req.method === 'POST') {
    const iv = store.db.interviews.find(i => i.id === m[1]);
    if (!iv) return json(res, 404, { error: 'not found' });
    if (iv.status === 'declined') return json(res, 409, { error: 'already declined', runId: iv.replanRunId || null });
    if (m[2] === 'accept') { iv.status = 'accepted'; store.save(); return json(res, 200, { ok: true, status: iv.status }); }
    iv.status = 'declined';
    iv.declinedAt = new Date().toISOString();
    const run = iv.bookedBy === 'seeker' ? agent.rescheduleAfterDecline(iv, base) : agent.replanAfterDecline(iv, base);
    return json(res, 200, { ok: true, status: iv.status, runId: run.id, url: `${base}/runs/${run.id}` });
  }
  if (p === '/api/emails') return json(res, 200, store.db.emails.slice(-100).reverse());
  // Before a demo: one button puts the demo data back to the start (fresh jobs, no applications or runs).
  if (p === '/reset') {
    const token = process.env.RESET_TOKEN;
    let msg = '';
    if (req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (token && form.get('token') !== token) msg = '<p class="panel bad" role="alert" tabindex="-1" id="msg">Wrong reset code. Nothing was changed.</p>';
      else { store.reset(); msg = `<p class="panel good" role="status" tabindex="-1" id="msg">Done. The demo data is back to the start: ${store.db.jobs.length} open jobs, no applications, no interviews.</p>`; }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
    return res.end(page('Reset the demo', `<h1>Reset the demo</h1>${msg}
      <p>This removes every application, interview, email and agent run, and puts the demo jobs and people back to the start. Use it just before a demo so the run starts fresh.</p>
      <form method="post" action="/reset">${token ? '<label for="token">Reset code</label><input type="text" id="token" name="token" autocomplete="off">' : ''}
      <p class="actions"><button type="submit">Reset the demo data</button></p></form>`, { scripts: msg ? '<script>document.getElementById("msg").focus()</script>' : '' }));
  }
  if (p === '/api/reset' && req.method === 'POST') {
    const token = process.env.RESET_TOKEN;
    if (token && url.searchParams.get('token') !== token) return json(res, 403, { error: 'bad token' });
    store.reset();
    return json(res, 200, { ok: true });
  }

  // ---- Calendar files ----
  if ((m = p.match(/^\/ics\/([\w-]+)\.ics$/))) {
    const iv = store.db.interviews.find(i => i.id === m[1]);
    if (!iv) return json(res, 404, { error: 'not found' });
    const j = store.db.jobs.find(x => x.id === iv.jobId);
    const body = L.interviewIcs(iv, j, base);
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="interview-${iv.id}.ics"` });
    return res.end(body);
  }

  // ---- Pages ----
  if (p === '/jobs') {
    const open = [...store.db.jobs].reverse().filter(j => j.status === 'open');
    const list = open.map(j => `<li><h2><a href="/jobs/${esc(j.id)}">${esc(j.title)}</a></h2>
      <p>${esc(j.business)}, ${esc(j.area)}. RM${esc(j.pay)} per ${esc(j.payUnit)}. ${esc((j.access?.workMode || 'on-site').replace(/^\w/, c => c.toUpperCase()))}${j.access?.transit && j.access.workMode !== 'remote' ? `, ${esc(j.access.transit.walkMin)}-minute walk from ${esc(j.access.transit.station)}` : ''}.${(j.access?.assistiveTech || []).length ? ` Supports ${esc(j.access.assistiveTech.join(', '))}.` : ''}${L.checkWage(j.pay, j.payUnit).ok ? '' : ' <span class="status-word bad">Below the legal minimum wage</span>'}</p></li>`).join('');
    return html(res, 200, page('Open jobs', `<h1>Open jobs (${open.length})</h1><p>Each job lists how you get there, whether screen readers are supported and any tasks that need sight. <a href="/about#demo-data">Employers here are fictional demo data.</a></p><ul class="joblist">${list}</ul>`, { current: '/jobs' }));
  }
  if ((m = p.match(/^\/jobs\/([\w-]+)$/))) {
    const j = store.db.jobs.find(x => x.id === m[1]);
    return j ? html(res, 200, jobView(j, base)) : html(res, 404, page('Not found', '<h1>Job not found</h1>'));
  }
  if ((m = p.match(/^\/jobs\/([\w-]+)\/apply$/)) && req.method === 'POST') {
    const j = store.db.jobs.find(x => x.id === m[1]);
    if (!j) return html(res, 404, page('Not found', '<h1>Job not found</h1>'));
    const f = new URLSearchParams(await readBody(req));
    const parse = require('./src/parse');
    const free = f.get('free') || 'weekends';
    const prof = parse.student(`${free}. ${f.get('skills') || ''}`);
    const email = (f.get('email') || '').trim().toLowerCase();
    let s = store.db.students.find(x => x.email === email);
    const fields = {
      name: (f.get('name') || 'Applicant').slice(0, 80), email, area: L.findArea(f.get('area')) || f.get('area') || 'Subang Jaya',
      skills: (f.get('skills') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
      availability: prof.availability, bio: (f.get('bio') || '').slice(0, 1000), campus: '',
    };
    if (s) Object.assign(s, fields); else { s = { id: store.id('stu'), ...fields }; store.db.students.push(s); }
    if (!store.db.applications.some(a => a.jobId === j.id && a.studentId === s.id)) {
      store.db.applications.push({ id: store.id('app'), jobId: j.id, studentId: s.id, coverNote: fields.bio, at: new Date().toISOString(), score: L.scoreMatch(j, s).total, source: 'web form' });
    }
    store.save();
    return html(res, 200, page('Application sent', `<h1>Application sent</h1><p class="panel good">Thank you, ${esc(s.name)}. Your application for <a href="/jobs/${esc(j.id)}">${esc(j.title)}</a> is in.</p>`));
  }
  if (p === '/outbox') {
    const runFilter = url.searchParams.get('run');
    const mails = store.db.emails.filter(e => !runFilter || e.runId === runFilter).slice(-60).reverse();
    const list = mails.map(e => `<article class="mail" id="${esc(e.id)}" aria-labelledby="${esc(e.id)}-s"><h2 id="${esc(e.id)}-s">${esc(e.subject)}</h2>
<dl class="facts"><dt>To</dt><dd>${esc(e.to)}</dd><dt>Sent</dt><dd>${esc(new Date(e.at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'full', timeStyle: 'short' }))}</dd><dt>Delivered by</dt><dd>${esc(e.delivery?.channel || 'demo outbox')}</dd></dl>
<pre>${esc(e.body)}</pre>${e.attachment ? `<p><a href="${esc(e.attachment)}">Calendar invitation for “${esc(e.subject)}”</a></p>` : ''}</article>`).join('') || '<p>No emails yet.</p>';
    return html(res, 200, page('Emails', `<h1>Emails (${mails.length})</h1><p>Every email the agent sends, in plain text with the time and how to join first. Demo addresses (example.com) stay here instead of being delivered.</p>${list}`, { current: '/outbox' }));
  }
  if (p === '/' || p === '/about' || p === '/me' || /^\/runs\/[\w-]+$/.test(p)) {
    const { opts, body } = staticPage(p === '/about' ? 'about.html' : p === '/me' ? 'me.html' : 'home.html');
    return html(res, 200, page(opts.title || 'HireBuddy', body, { current: p.startsWith('/runs/') ? '' : p, scripts: opts.script ? `<script src="${opts.script}"></script>` : '' }));
  }

  // ---- Static ----
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  html(res, 404, page('Not found', '<h1>Not found</h1>'));
}

http.createServer((req, res) => {
  route(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: e.message }); });
}).listen(PORT, () => console.log(`HireBuddy on :${PORT} (${llm.enabled() ? `LLM ${llm.MODEL}` : 'autopilot'})`));
