// HireBuddy agent page. Starts a run and follows it live.
// Screen reader design: one polite announcement per plan step or decision (never a flood),
// focus moves to the result when it is ready, and every status is said in words, not colour.
const $ = s => document.querySelector(s);
const { esc, announce } = window.HB;

const EXAMPLES = {
  student: [
    "I'm Nadia Rahim. I'm blind and use NVDA. I live in Subang Jaya and take the LRT. I did customer service calls at a bank hotline for a year and type fast in English and Malay. Free weekdays 9am to 5pm, at least RM12 an hour, phone interviews please.",
    "I'm Nur Aqilah, I have low vision and use a screen magnifier. Remote work only. I write Malay articles and captions. Free Mon, Wed and Fri 10am-6pm.",
    "I'm Ravi Chandran, I'm blind and use TalkBack. I live in Kuala Lumpur and hold a massage certificate. Free Wednesday to Sunday 11am-7pm.",
  ],
  hirer: [
    'Need a weekend barista for MIXUE in Subang, RM12/hr, start next week',
    'Need a weekend cashier in Subang, RM55 a day, 8-hour shifts',
  ],
};

const TOOL_LABEL = {
  check_minimum_wage: 'Checked the pay is legal', publish_job: 'Published the job page', find_candidates: 'Found candidates',
  screen_candidates: 'Screened candidates', verify_screening: 'Self-check: screening', schedule_interviews: 'Booked interviews',
  send_email: 'Sent an email', verify_hiring_outcome: 'Final self-check', register_student: 'Saved the profile',
  search_jobs: 'Checked jobs against your needs', apply_to_job: 'Applied', book_interview: 'Booked an interview',
  verify_applications: 'Final self-check', check_outside_listings: 'Checked jobs WorkBuddy found on other sites', finish: 'Delivered the result', relax_requirement: 'Relaxed a must-have',
  record_fit_judgement: 'Judged fit from their own words',
};

let persona = 'student';
let outcome = {};
let lastActive = -1;

function setPersona(p) {
  persona = p;
  document.querySelectorAll('input[name="persona"]').forEach(r => { r.checked = r.value === p; });
  $('#go').textContent = p === 'student' ? 'Find me work' : 'Hire for me';
  $('#examples').innerHTML = EXAMPLES[p].map((e, i) => `<li><button type="button" data-i="${i}"><span><b>Use this example:</b> ${esc(e)}</span></button></li>`).join('');
  $('#examples').querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#prompt').value = EXAMPLES[p][b.dataset.i];
    $('#prompt').focus();
    announce('Example copied into your sentence. Press Find me work to start.');
  });
}

document.querySelectorAll('input[name="persona"]').forEach(r => r.addEventListener('change', () => setPersona(r.value)));

fetch('/api/config').then(r => r.json()).then(c => {
  $('#mode').textContent = c.llm
    ? `Thinking with ${c.model}. Every step is checked by the same tools and self-checks.`
    : 'Running the built-in planner (no AI key set). Same tools, same self-checks.';
});

// Speak instead of typing, where the browser supports it (useful on phones and for low vision).
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Rec) {
  const btn = $('#speak');
  btn.hidden = false;
  btn.onclick = () => {
    const rec = new Rec();
    rec.lang = 'en-MY';
    rec.interimResults = false;
    btn.disabled = true;
    btn.textContent = 'Listening…';
    announce('Listening. Say your sentence.');
    rec.onresult = e => { $('#prompt').value = [...e.results].map(r => r[0].transcript).join(' '); announce(`Heard: ${$('#prompt').value}`); };
    rec.onend = () => { btn.disabled = false; btn.textContent = 'Speak instead'; $('#prompt').focus(); };
    rec.start();
  };
}

$('#ask').onsubmit = async e => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  const err = $('#prompt-error');
  if (!prompt) {
    err.hidden = false;
    err.textContent = 'Error: write one sentence about the work you want, or pick an example below.';
    $('#prompt').setAttribute('aria-invalid', 'true');
    $('#prompt').focus();
    return;
  }
  err.hidden = true;
  $('#prompt').removeAttribute('aria-invalid');
  $('#go').disabled = true;
  const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, persona }) }).then(r => r.json());
  history.pushState({}, '', `/runs/${r.id}`);
  openRun(r.id, true);
};

// ---------------------------------------------------------------------------

function openRun(id, fresh) {
  $('#composer').hidden = true;
  $('#recent').hidden = true;
  $('#runview').hidden = false;
  $('#runview').setAttribute('aria-busy', 'true');
  document.title = 'Working on it · HireBuddy';
  $('#run-title').focus();
  if (fresh) announce('Started. I will tell you each step as it happens.');
  outcome = {};
  lastActive = -1;
  const es = new EventSource(`/api/runs/${id}/stream`);
  es.onmessage = m => {
    const e = JSON.parse(m.data);
    if (e.type === 'end') return es.close();
    render(e, fresh);
  };
  es.onerror = () => es.close();
}

const STATE = { done: 'done', active: 'in progress', retry: 'fixing a problem', skipped: 'skipped', pending: 'not started' };

function renderPlan(plan, live) {
  $('#plan').innerHTML = plan.map(s => `<li class="${esc(s.status || 'pending')}"><span class="title">${esc(s.title)}</span> <span class="state">(${STATE[s.status] || 'not started'})</span></li>`).join('');
  const done = plan.filter(s => s.status === 'done').length;
  const at = plan.findIndex(s => s.status === 'active' || s.status === 'retry');
  $('#progress').textContent = `${done} of ${plan.length} steps done.`;
  if (live && at >= 0 && at !== lastActive) {
    lastActive = at;
    announce(`Step ${at + 1} of ${plan.length}: ${plan[at].title}.`);
  }
}

function logItem(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  $('#timeline').appendChild(li);
  return li;
}

const pending = new Map();

function render(e, live) {
  switch (e.type) {
    case 'start':
      $('#rv-persona').textContent = `${e.persona === 'student' ? 'Job seeker' : 'Employer'} · ${e.mode}`;
      $('#rv-prompt').textContent = e.prompt;
      break;
    case 'plan':
      renderPlan(e.plan, live);
      break;
    case 'thought':
      logItem(`<p>${linkify(esc(e.text))}</p>`, 'thought');
      break;
    case 'decision':
      logItem(`<section class="panel decision" aria-label="Decision"><h3>Decision: ${esc(e.choice)}</h3><p>${esc(e.situation)}</p>
        <p><b>Options weighed:</b></p><ul>${e.options.map(o => `<li>${o.startsWith(e.choice) ? '<b>Chosen:</b> ' : ''}${esc(o)}</li>`).join('')}</ul><p><b>Why:</b> ${esc(e.reason)}</p></section>`);
      if (live) announce(`Decision: ${e.choice}. ${e.reason}`);
      outcome.decisions = (outcome.decisions || []).concat(e);
      break;
    case 'tool_call': {
      if (e.tool === 'set_plan' || e.tool === 'log_decision') break;
      pending.set(e.tool, logItem(`<h3>${esc(TOOL_LABEL[e.tool] || e.tool)} <span class="muted small">(${esc(e.tool)})</span></h3><div class="out"><p class="muted">Working…</p></div>`, 'tool'));
      break;
    }
    case 'tool_result': {
      if (e.tool === 'set_plan' || e.tool === 'log_decision') break;
      const li = pending.get(e.tool) || logItem(`<h3>${esc(TOOL_LABEL[e.tool] || e.tool)}</h3><div class="out"></div>`, 'tool');
      pending.delete(e.tool);
      li.classList.add(e.ok ? 'ok' : 'fail');
      if (e.ok && e.tool === 'book_interview') outcome.booked = (outcome.booked || []).concat(e.result);
      if (e.ok && e.tool === 'schedule_interviews') outcome.slots = (outcome.slots || []).concat(e.result.scheduled);
      if (e.ok && e.tool === 'screen_candidates') outcome.screen = e.result.details;
      if (e.ok && e.tool === 'check_outside_listings') outcome.outside = e.result.results;
      li.querySelector('.out').innerHTML = (e.ok ? '' : '<p><b>Problem found.</b></p>') + pretty(e.tool, e.result, e.ok);
      break;
    }
    case 'self_correct':
      if (e.tool !== 'check_minimum_wage') logItem(`<div class="panel fix"><p><b>Caught a problem and fixed it:</b></p><ul>${e.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`);
      break;
    case 'error':
      logItem(`<div class="panel bad"><p><b>Error:</b> ${esc(e.message)}</p></div>`);
      break;
    case 'final':
      if (e.plan?.length) renderPlan(e.plan, false);
      showResult(e, live);
      break;
  }
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<)]+[^\s<).,])/g, '<a href="$1">$1</a>');
}

function accessText(a) {
  if (!a) return '';
  if (a.fit === 'not suitable') return `<span class="status-word bad">Not suitable</span> ${esc(a.blockers.join('; '))}`;
  if (a.fit === 'ask first') return `<span class="status-word">Ask first</span> ${esc([...a.reasons, ...a.asks].join('; '))}`;
  return `<span class="status-word good">Suits you</span> ${esc(a.reasons.join('; ') || 'no access needs to check')}`;
}

function checkList(r) {
  return `<p>${r.passed ?? r.checks.filter(c => c.pass).length} of ${r.total ?? r.checks.length} checks passed.</p><ul class="checks">${r.checks.map(c => `<li><span class="status-word ${c.pass ? 'good' : 'bad'}">${c.pass ? 'Passed' : 'Failed'}</span> ${esc(c.name)}${c.detail ? `<br><span class="muted small">${linkify(esc(c.detail))}</span>` : ''}</li>`).join('')}</ul>`;
}

function pretty(tool, r, ok) {
  if (!ok && r.problems) return `<ul>${r.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  if (!ok) return `<p>${esc(r.error || r.message || 'Failed')}</p>`;
  switch (tool) {
    case 'check_minimum_wage':
      return `<p>${esc(r.message)} <span class="muted">(${esc(r.source)})</span></p>`;
    case 'register_student': {
      const n = r.profile.needs;
      return `<p>${esc(r.profile.name)}, ${esc(r.profile.area)}. Skills: ${esc(r.profile.skills.join(', '))}.</p>${n ? `<p>Needs: ${esc(n.vision)}, uses ${esc(n.tool || 'assistive tech')}${n.remoteOnly ? ', remote only' : `, up to a ${esc(n.maxWalkMin)}-minute walk from a stop`}${n.interviewFormat ? `, ${esc(n.interviewFormat)} interviews` : ''}.</p>` : ''}`;
    }
    case 'search_jobs':
      return `<p>${r.suitable} of ${r.count} jobs suit you.</p><table><caption>Jobs checked</caption><thead><tr><th scope="col">Job</th><th scope="col">Pay</th><th scope="col">Access</th><th scope="col">Match</th></tr></thead><tbody>${r.results.map(j => `<tr><th scope="row"><a href="${esc(j.url)}">${esc(j.title)}</a><br><span class="small">${esc(j.business)}, ${esc(j.workMode)}</span></th><td>${esc(j.pay)}${j.legalPay ? '' : `<br><span class="status-word bad">Illegal pay</span>`}${j.belowMinPay && j.legalPay ? '<br><span class="small">Below your minimum</span>' : ''}</td><td>${accessText(j.access)}</td><td>${j.score} out of 100</td></tr>`).join('')}</tbody></table>`;
    case 'apply_to_job':
      return `<p>Applied to ${esc(r.job)} at ${esc(r.business)}. The employer was emailed your application and your interview needs.</p>`;
    case 'book_interview':
      return `<p><b>${esc(r.whenLong)}</b>, ${esc(r.format)} interview with ${esc(r.business)}. ${esc(r.howToJoin)}</p>`;
    case 'publish_job':
      return `<p>Live at <a href="${esc(r.job.url)}">${esc(r.job.url)}</a>. Fetched it back: HTTP ${esc(r.liveCheck.status)}.</p>`;
    case 'find_candidates':
      return `<p>${r.count} candidates within ${esc(r.radiusKm)} km: ${esc(r.candidates.map(c => c.name).join(', '))}.</p>`;
    case 'screen_candidates':
      return `<table><caption>Candidates ranked</caption><thead><tr><th scope="col">Name</th><th scope="col">Score</th><th scope="col">Why</th></tr></thead><tbody>${r.details.map(d => `<tr><th scope="row">${esc(d.name)}${d.qualified ? '<br><span class="status-word good">Qualified</span>' : ''}${d.unavailable ? `<br><span class="small">${esc(d.unavailable)}</span>` : ''}</th><td>${d.score} out of 100</td><td>${esc(d.why)}${(d.evidence || []).filter(ev => ev.source === 'bio').slice(0, 1).map(ev => `<br><span class="small">Evidence: “${esc(ev.quote)}”</span>`).join('')}</td></tr>`).join('')}</tbody></table>`;
    case 'verify_screening':
      return `<p>${r.checks.filter(c => c.pass).length} of ${r.checked} scores reproduced exactly, and every quote was found word for word.</p>`;
    case 'schedule_interviews':
      return `<ul>${r.scheduled.map(s => `<li>${esc(s.name)}: ${esc(s.when)}</li>`).join('')}${r.unscheduled.map(u => `<li>${esc(u.name || u.id)}: not booked, ${esc(u.reason)}</li>`).join('')}</ul>`;
    case 'send_email':
      return `<p>“${esc(r.subject)}” to ${esc(r.to)}. <a href="${esc(r.viewUrl)}">Read the email</a> <span class="muted small">(${esc(r.delivery?.channel)})</span></p>`;
    case 'verify_hiring_outcome':
    case 'verify_applications':
      return checkList(r);
    case 'relax_requirement':
      return `<p>Must-have now: ${esc(r.requirements.join(', '))}. Nice to have: ${esc(r.niceToHave.join(', '))}.</p>`;
    case 'record_fit_judgement':
      return '<p>Recorded, with a quote checked word for word.</p>';
    case 'finish':
      return '<p>Result delivered.</p>';
    default:
      return '';
  }
}

function showResult(e, live) {
  const ok = e.status === 'done';
  const refused = /^I did not publish/.test(e.summary || '');
  $('#run-title').textContent = ok ? 'Done' : 'Stopped';
  document.title = `${ok ? 'Done' : 'Stopped'} · HireBuddy`;
  const sec = $('#result');
  $('#runview').setAttribute('aria-busy', 'false');
  sec.hidden = false;
  sec.className = `result panel ${ok && !refused ? 'good' : 'bad'}`;
  const lines = (e.summary || 'The agent stopped before finishing. Open the step-by-step list below.').split('\n');
  const head = lines[0];
  const booked = outcome.booked || [];
  const interviews = booked.length
    ? `<h3>Your interviews</h3><ol class="interviews">${booked.map(b => `<li><h4>${esc(b.job)} at ${esc(b.business)}</h4>
        <dl class="facts"><dt>When</dt><dd>${esc(b.whenLong)} (Malaysia time)</dd><dt>How</dt><dd>${esc(b.howToJoin)}${b.preferred && b.preferred !== b.format ? ` You asked for ${esc(b.preferred)}, but they only interview ${esc(b.format)}.` : ''}</dd></dl>
        <p class="actions">${b.meetUrl ? `<a class="btn" href="${esc(b.meetUrl)}">Join the ${esc(b.business)} video call</a>` : ''}<a class="btn secondary" href="${esc(b.icsUrl)}">Add ${esc(b.business)} interview to calendar</a></p></li>`).join('')}</ol>`
    : (outcome.slots || []).length
      ? `<h3>Interviews booked</h3><ul>${outcome.slots.map(s => `<li>${esc(s.name)}: ${esc(s.when)}. <a href="${esc(s.icsUrl)}">Calendar file for ${esc(s.name)}</a></li>`).join('')}</ul>`
      : '';
  const out = outcome.outside || [];
  const others = out.length ? `<h3>Jobs WorkBuddy found on other sites</h3>
    <p>HireBuddy can't apply or book interviews on other sites, so nothing was sent. Each job worth asking about has an application ready for you to send.</p>
    <ol class="joblist">${out.map((r, i) => `<li><h4>${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}${r.employer ? ` at ${esc(r.employer)}` : ''}${r.site ? `, on ${esc(r.site)}` : ''}</h4>
      <p><span class="status-word ${r.verdict === 'not suitable' ? 'bad' : 'good'}">${r.verdict === 'not suitable' ? 'Not suitable' : 'Worth asking'}</span>
      ${esc(r.verdict === 'not suitable' ? r.blockers.join('; ') : r.reasons.join('; '))}.</p>
      ${r.draft ? `<details><summary>Application ready to send, with ${r.questions.length} question${r.questions.length === 1 ? '' : 's'} for ${esc(r.employer || 'the employer')}</summary>
        <pre id="draft-${i}">${esc(r.draft)}</pre><p><button type="button" class="secondary" data-copy="draft-${i}">Copy the application for ${esc(r.employer || r.title)}</button></p></details>` : ''}</li>`).join('')}</ol>` : '';
  const rest = lines.slice(1).filter(l => !/^\d+\. /.test(l) || !booked.length);
  $('#result-body').innerHTML = `<p><span class="status-word ${e.verified && !refused ? 'good' : 'bad'}">${refused ? 'Refused: pay is below the legal minimum' : e.verified ? 'Checked and verified' : ok ? 'Done' : 'Needs attention'}</span></p>
    <p class="lede">${linkify(esc(head))}</p>${interviews}${others}${rest.map(l => `<p>${linkify(esc(l))}</p>`).join('')}
    ${(outcome.decisions || []).length ? `<h3>Decisions HireBuddy made</h3><ul>${outcome.decisions.map(d => `<li><b>${esc(d.choice)}.</b> ${esc(d.reason)}</li>`).join('')}</ul>` : ''}
    <p class="actions"><button type="button" class="secondary" id="read-aloud">Read aloud</button>${(e.links || []).filter(l => !l.label.startsWith('Calendar invite')).map(l => `<a class="btn secondary" href="${esc(l.url)}">${esc(l.label)}</a>`).join('')}</p>`;
  $('#read-aloud').onclick = ev => window.HB.speak((e.summary || '').replace(/https?:\/\/\S+/g, 'the link'), ev.currentTarget);
  if (!('speechSynthesis' in window)) $('#read-aloud').remove();
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); announce('Copied the application.'); b.textContent = 'Copied'; }
    catch { announce('Could not copy. Select the text instead.'); }
  });
  if (live) {
    $('#result-title').focus();
    announce(`${ok ? 'Done' : 'Stopped'}. ${head}`);
  }
}

async function loadRecent() {
  const runs = await fetch('/api/runs').then(r => r.json());
  $('#runs').innerHTML = runs.slice(0, 6).map(r => `<li><h3><a href="/runs/${esc(r.id)}">${esc(r.prompt.length > 120 ? r.prompt.slice(0, 118) + '…' : r.prompt)}</a></h3>
    <p class="small">${r.persona === 'student' ? 'Job seeker' : 'Employer'}${r.source === 'mcp' ? ', from WorkBuddy' : r.source === 'decline' ? ', after a change of plan' : ''}. <span class="status-word ${r.verified ? 'good' : r.status === 'running' ? '' : 'bad'}">${r.verified ? 'Verified' : esc(r.status)}</span></p></li>`).join('') || '<li>No results yet. Try an example above.</li>';
}

const m = location.pathname.match(/^\/runs\/([\w-]+)/);
if (m) openRun(m[1], false); else loadRecent();
window.onpopstate = () => location.reload();
try { const me = JSON.parse(localStorage.getItem('hirebuddy.me')); setPersona(me?.role === 'owner' ? 'hirer' : 'student'); } catch (e) { setPersona('student'); }
