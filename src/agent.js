// The agent: takes one prompt, plans, calls tools, checks its own work and delivers a result.
// Runs with an LLM when LLM_API_KEY is set, otherwise with the rule-based autopilot planner.
const { EventEmitter } = require('events');
const store = require('./store');
const L = require('./lib');
const llm = require('./llm');
const parse = require('./parse');
const outside = require('./outside');
const { tools, HIRER_TOOLS, STUDENT_TOOLS, MINIMUM_MATCH, jobUrl, matchJobs } = require('./tools');

const bus = new EventEmitter();
bus.setMaxListeners(200);
const live = new Map(); // runId -> runtime ctx

function detectPersona(prompt) {
  const t = prompt.toLowerCase();
  if (/\b(blind|low vision|visually impaired|partially sighted|screen ?reader|nvda|jaws|voiceover|talkback|magnifier)\b/.test(t) && !/\bhiring\b|my (cafe|shop|company|business)/.test(t)) return 'student';
  const student = [/\bstudent\b/, /universit|college|campus|\buni\b|semester/, /\b(i am|i'm|im|my name is)\b/, /\bi can\b|my skills|i speak|i have experience/,
    /free (on )?(weekends?|weekdays?|mon|tue|wed|thu|fri|sat|sun)/, /looking for (a )?(part[- ]?time )?(job|gig|work)|find me|want (a )?(job|gig)|at least rm/]
    .filter(re => re.test(t)).length;
  const hirer = [/\b(need|needs|hiring|recruit)\b/, /\bmy (cafe|café|shop|bakery|restaurant|kedai|store|business|company|stall|kopitiam|centre|center)\b/,
    /looking for an? (\w+ )?(barista|cashier|tutor|crew|staff|assistant|helper|waiter|waitress|part[- ]?timer)/, /\bstart (next|this|on|tomorrow)/]
    .filter(re => re.test(t)).length;
  return student > hirer ? 'student' : 'hirer';
}

function newRun(prompt, persona, source = 'web', options = {}) {
  const run = {
    id: store.id('run'), prompt, persona: persona || detectPersona(prompt), source,
    mode: llm.enabled() ? `LLM (${llm.MODEL})` : 'Autopilot (rule-based planner)',
    status: 'running', createdAt: new Date().toISOString(), plan: [], events: [], summary: null, verified: null,
    options: Object.fromEntries(Object.entries(options).filter(([, v]) => v)),
  };
  store.db.runs.push(run);
  store.save();
  return run;
}

function makeCtx(run, baseUrl) {
  const ctx = {
    run, baseUrl,
    emit(ev) {
      const e = { t: Date.now(), ...ev };
      run.events.push(e);
      store.save();
      bus.emit(run.id, e);
    },
  };
  return ctx;
}

function advancePlan(ctx, toolName, status) {
  const plan = ctx.run.plan;
  if (!plan?.length) return;
  let at = plan.findIndex(s => s.tool === toolName && s.status !== 'done');
  if (at < 0) at = plan.map(s => s.tool).lastIndexOf(toolName);
  if (at < 0) return;
  for (let i = 0; i < at; i++) plan[i].status = 'done';
  plan[at].status = status;
  ctx.emit({ type: 'plan', plan });
}

async function callTool(ctx, name, args) {
  const tool = tools[name];
  ctx.emit({ type: 'tool_call', tool: name, args });
  let result;
  try {
    result = tool ? await tool.run(args || {}, ctx) : { ok: false, error: `Unknown tool ${name}` };
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  const ok = result.ok !== false;
  ctx.emit({ type: 'tool_result', tool: name, ok, result });
  if (/^verify_/.test(name) && result.checks) ctx.emit({ type: 'checks', tool: name, pass: result.pass, checks: result.checks });
  if (!ok && (result.problems || result.error)) ctx.emit({ type: 'self_correct', tool: name, problems: result.problems || [result.error] });
  if (name !== 'set_plan') advancePlan(ctx, name, !ok || result.pass === false ? 'retry' : name === 'finish' ? 'done' : 'active');
  return result;
}

const say = (ctx, text) => ctx.emit({ type: 'thought', text });

// ---------------------------------------------------------------------------
// Autopilot: deterministic planner that drives the same tools.

const RADII = [10, 20, 30];

// Who would qualify under a (possibly hypothetical) version of the job: within range or applied,
// meets every must-have, scores at least MINIMUM_MATCH, hasn't declined or been booked already.
function qualifiedUnder(job, radius, skip) {
  const applied = new Set(store.db.applications.filter(a => a.jobId === job.id).map(a => a.studentId));
  return store.db.students.filter(s => {
    if (skip.has(s.id) || store.db.interviews.some(i => i.jobId === job.id && i.studentId === s.id)) return false;
    const km = L.distanceKm(job.area, s.area);
    if (!applied.has(s.id) && !(km != null && km <= radius)) return false;
    const sc = L.scoreMatch(job, s);
    return sc.requiredCoverage === 1 && sc.total >= MINIMUM_MATCH;
  });
}

function hasSkill(job, s, skill) {
  return !!L.scoreMatch({ ...job, requirements: [skill], niceToHave: [] }, s).evidence.length;
}

const names = list => list.map(s => s.name).join(' and ') || 'nobody';

// Goal loop: keep screening and booking until `goal` interviews are booked. Whenever it falls
// short it weighs every option by simulating it, logs the decision with its reason, and acts.
async function bookTowardGoal(ctx, jobId, goal, { radius = RADII[0], relaxBudget = 1, window = 7 } = {}) {
  const booked = [];
  let screened = null;
  let noTime = [];
  for (let round = 1; round <= 8; round++) {
    const found = await callTool(ctx, 'find_candidates', { jobId, maxDistanceKm: radius });
    screened = await callTool(ctx, 'screen_candidates', { jobId, candidateIds: found.candidates.map(c => c.id) });
    const ver = await callTool(ctx, 'verify_screening', { jobId });
    if (!ver.pass) say(ctx, 'Some scores did not reproduce, so I will only book candidates whose checks passed.');
    const passed = new Set(ver.checks.filter(c => c.pass).map(c => c.id));
    const ready = screened.ranked.filter(r => r.qualified && passed.has(r.id)).slice(0, goal - booked.length);
    const job = store.db.jobs.find(j => j.id === jobId);
    say(ctx, `Round ${round} (${radius} km): ${screened.ranked.filter(r => r.qualified).length} candidate(s) meet every must-have (${job.requirements.join(', ')}). ${booked.length} of ${goal} interviews booked so far.`);
    if (ready.length) {
      const sched = await callTool(ctx, 'schedule_interviews', { jobId, candidateIds: ready.map(r => r.id), durationMinutes: 20, withinDays: window });
      booked.push(...sched.scheduled);
      noTime = sched.unscheduled.filter(u => /no common free time/.test(u.reason));
    }
    if (booked.length >= goal) break;

    // Short of the goal: weigh every option by what it would actually change.
    const skip = new Set([...booked.map(b => b.candidateId), ...noTime.map(u => u.id)]);
    const options = [];
    if (noTime.length && window < 14) {
      options.push({ label: `Look 14 days ahead instead of ${window} for ${names(noTime)}`, gain: noTime.length, rank: 0,
        why: `${names(noTime)} qualif${noTime.length === 1 ? 'ies' : 'y'} but ${noTime.length === 1 ? 'has' : 'have'} no free time in the next ${window} days`,
        apply: () => { window = 14; noTime = []; } });
    }
    const next = RADII.find(r => r > radius);
    if (next) {
      const now = qualifiedUnder(job, radius, skip), wider = qualifiedUnder(job, next, skip);
      const core = job.requirements[0];
      const near = store.db.students.filter(s => { const km = L.distanceKm(job.area, s.area); return km != null && km > radius && km <= next && hasSkill(job, s, core); });
      const added = wider.filter(s => !now.includes(s));
      options.push({ label: `Widen the search from ${radius} km to ${next} km`, gain: added.length, potential: near.length, rank: 1,
        why: added.length ? `would add ${names(added)}, who meet every must-have`
          : `nobody within ${radius} km meets every must-have, and ${near.length} more people with ${core} experience live within ${next} km`,
        apply: () => { radius = next; } });
    }
    if (relaxBudget > 0) {
      for (const k of job.requirements.slice(1)) {
        const relaxedJob = { ...job, requirements: job.requirements.filter(r => r !== k), niceToHave: [k, ...(job.niceToHave || [])] };
        const gained = qualifiedUnder(relaxedJob, radius, skip).filter(s => !qualifiedUnder(job, radius, skip).includes(s));
        options.push({ label: `Relax "${k}" from must-have to nice-to-have`, gain: gained.length, rank: 2, skill: k,
          why: gained.length ? `nobody nearby has every must-have; dropping only "${k}" qualifies ${names(gained)}, and ${(rest => `${rest.join(', ')} ${rest.length === 1 ? 'stays' : 'stay'}`)(job.requirements.filter(r => r !== k))} required`
            : `would not add anyone at ${radius} km`,
          apply: async () => {
            await callTool(ctx, 'relax_requirement', { jobId, skill: k, reason: `Only way to reach ${goal} interviews: qualifies ${names(gained)}` });
            relaxBudget--;
          } });
      }
    }
    const stop = { label: `Stop at ${booked.length} and tell the owner who came closest`, gain: 0, rank: 3,
      why: 'no remaining option adds a qualified candidate, and padding the list with weak matches would waste the owner\'s time',
      apply: () => 'stop' };
    options.push(stop);

    const best = [...options].sort((a, b) => b.gain - a.gain || a.rank - b.rank)[0];
    // Nothing helps right now: widening is still worth it if it brings in people with the core skill,
    // because a later relaxation may then qualify them.
    const choice = best.gain > 0 ? best
      : options.find(o => o.rank === 1 && o.potential > 0 && relaxBudget > 0) || stop;
    await callTool(ctx, 'log_decision', {
      situation: `${booked.length} of ${goal} interviews booked after round ${round}; ${qualifiedUnder(job, radius, skip).length || 'no'} other qualified candidate(s) within ${radius} km.`,
      options: options.map(o => `${o.label} (${o.gain ? `+${o.gain} qualified` : 'adds nobody'})`),
      choice: choice.label,
      reason: `${choice.why[0].toUpperCase()}${choice.why.slice(1)}.`,
    });
    if (await choice.apply() === 'stop') break;
  }
  const job = store.db.jobs.find(j => j.id === jobId);
  job.searchRadiusKm = radius;
  store.save();
  return { booked, screened, radius };
}

async function emailInterviews(ctx, job, booked, screened) {
  for (const iv of booked) {
    const s = store.db.students.find(x => x.id === iv.candidateId);
    const cand = screened.details.find(d => d.id === iv.candidateId) || L.scoreMatch(job, s);
    const score = cand.score ?? cand.total;
    const why = cand.why || L.explain(job, s, cand);
    const body = `Hi ${iv.name.split(' ')[0]},\n\nThanks for your interest in the ${job.title} role at ${job.business}. `
      + `You scored ${score}/100 on our screening (${why}).\n\n`
      + `Your interview: ${iv.when} (Malaysia time), 20 minutes, by video call.\n`
      + `Join the video call: ${iv.meetUrl}\n\n`
      + `The calendar invitation is attached. Press Accept to add it to your calendar.\nJob details: ${jobUrl(ctx, job.id)}\n\nCan't make it? Decline on your HireBuddy page (${ctx.baseUrl}/me) and we'll offer the slot to someone else.\n\n${job.business}`;
    await callTool(ctx, 'send_email', { to: iv.email || s.email, subject: `Interview for ${job.title}: ${iv.when}`, body, interviewId: iv.interviewId, kind: 'interview_invite' });
  }
}

function nearMisses(job, screened) {
  return (screened?.ranked || []).filter(r => !r.qualified && !r.unavailable && r.missing?.length && r.missing.length <= 2
    && !r.missing.includes(job.requirements[0]) && r.score >= 40).slice(0, 2);
}

function decisionSummary(ctx) {
  const d = ctx.run.decisions || [];
  return d.length ? ` Decisions I made on the way: ${d.map(x => x.choice.replace(/ \(.*\)$/, '')).join('; ')}.` : '';
}

async function autopilotHirer(ctx) {
  if (ctx.run.options?.replaceInterviewId) return autopilotReplace(ctx);
  const spec = { ...parse.hirer(ctx.run.prompt), ...(ctx.run.options || {}) };
  const goal = Math.max(3, spec.hires);
  ctx.run.goal = goal;
  say(ctx, `Understood the brief: ${spec.title} in ${spec.area}, RM${spec.pay}/${spec.payUnit}, ${L.describeSchedule(spec.schedule)}, start ${spec.startDate}. Must have: ${spec.requirements.join(', ')}. Goal: ${goal} interviews booked.`);
  await callTool(ctx, 'set_plan', { steps: [
    { title: 'Check the pay is legal', tool: 'check_minimum_wage' },
    { title: 'Write and publish the job post', tool: 'publish_job' },
    { title: 'Find candidates nearby', tool: 'find_candidates' },
    { title: 'Screen and rank candidates with evidence', tool: 'screen_candidates' },
    { title: 'Self-check the ranking', tool: 'verify_screening' },
    { title: `Book interviews until ${goal} are set`, tool: 'schedule_interviews' },
    { title: 'If short: decide to widen, relax or stop', tool: 'log_decision' },
    { title: 'Email invites with calendar files', tool: 'send_email' },
    { title: 'Verify the whole outcome', tool: 'verify_hiring_outcome' },
    { title: 'Deliver the report', tool: 'finish' },
  ] });

  const wage = await callTool(ctx, 'check_minimum_wage', { pay: spec.pay, payUnit: spec.payUnit });
  if (!wage.ok) {
    say(ctx, `Stopping before publishing: ${wage.message} Posting this would break the Minimum Wages Order.`);
    ctx.run.wageBlocked = true;
    const perHour = spec.payUnit === 'day' ? ` For ${/^(8|11|18)\b/.test(String(spec.shiftHours || 8)) ? 'an' : 'a'} ${spec.shiftHours || 8}-hour shift that is about RM${(spec.pay / (spec.shiftHours || 8)).toFixed(2)} an hour, and the legal minimum is RM${L.MIN_WAGE.hour} an hour.` : '';
    return callTool(ctx, 'finish', { summary: `I did not publish the job. ${wage.message}${perHour} Raise the offer to at least RM${wage.minimum}/${wage.unit} and run me again. (${L.MIN_WAGE.source}.)` });
  }

  const description = `${spec.business} is hiring a ${spec.title.toLowerCase()} in ${spec.area}. Pay: RM${spec.pay} per ${spec.payUnit}. `
    + `Shifts: ${L.describeSchedule(spec.schedule)}. Start: ${spec.startDate}. `
    + `You need: ${spec.requirements.join(', ')}.${spec.niceToHave.length ? ` Nice to have: ${spec.niceToHave.join(', ')}.` : ''} `
    + 'Great for students who want steady weekend income close to campus.';
  const pub = await callTool(ctx, 'publish_job', { business: spec.business, ownerEmail: spec.ownerEmail || undefined, title: spec.title, area: spec.area,
    pay: spec.pay, payUnit: spec.payUnit, schedule: spec.schedule, startDate: spec.startDate,
    requirements: spec.requirements, niceToHave: spec.niceToHave, description });
  if (!pub.ok) return say(ctx, `Could not publish: ${(pub.problems || []).join(' ')}`);
  const jobId = pub.job.id;
  say(ctx, `Job is live at ${pub.job.url} (self-check fetched it: HTTP ${pub.liveCheck.status}).`);

  const { booked, screened, radius } = await bookTowardGoal(ctx, jobId, goal);
  const job = store.db.jobs.find(j => j.id === jobId);
  await emailInterviews(ctx, job, booked, screened);

  const misses = booked.length < goal ? nearMisses(job, screened) : [];
  const relaxed = (job.relaxed || []).map(r => r.skill);
  if (spec.ownerEmail) {
    const lines = booked.map(iv => `- ${iv.name}: ${iv.when}`).join('\n');
    await callTool(ctx, 'send_email', { to: spec.ownerEmail, kind: 'owner_summary', subject: `Your ${spec.title} shortlist is booked`,
      body: `Job post: ${jobUrl(ctx, jobId)}\n\nInterviews:\n${lines}\n${(ctx.run.decisions || []).map(d => `\nDecision: ${d.choice}. ${d.reason}`).join('')}\n\nFull agent run: ${ctx.baseUrl}/runs/${ctx.run.id}` });
  }

  let check = await callTool(ctx, 'verify_hiring_outcome', { jobId });
  if (!check.pass) {
    say(ctx, `${check.total - check.passed} check(s) failed. Retrying once.`);
    check = await callTool(ctx, 'verify_hiring_outcome', { jobId });
  }
  const final = screened.details;
  const lines = booked.map(iv => `${iv.name} (${final.find(r => r.id === iv.candidateId)?.score ?? '?'}/100) on ${iv.when}`);
  await callTool(ctx, 'finish', { summary: `Published "${spec.title}" at ${jobUrl(ctx, jobId)}. Booked ${lines.length} of ${goal} interviews: ${lines.join('; ')}. Invites with calendar files were emailed.`
    + `${radius > RADII[0] ? ` Searched up to ${radius} km.` : ''}${relaxed.length ? ` Relaxed to nice-to-have: ${relaxed.join(', ')}.` : ''}${decisionSummary(ctx)}`
    + `${misses.length ? ` Closest near misses: ${misses.map(m => `${m.name} (missing ${m.missing.join(', ')})`).join('; ')}.` : ''} ${check.passed}/${check.total} self-checks passed.` });
}

// A student declined: book the next best candidate for that job and re-verify.
async function autopilotReplace(ctx) {
  const declined = store.db.interviews.find(i => i.id === ctx.run.options.replaceInterviewId);
  const job = store.db.jobs.find(j => j.id === declined.jobId);
  ctx.run.jobId = job.id;
  ctx.run.goal = 1;
  await callTool(ctx, 'set_plan', { steps: [
    { title: 'Decide how to fill the declined slot', tool: 'log_decision' },
    { title: 'Find candidates', tool: 'find_candidates' },
    { title: 'Re-screen without anyone who declined or is booked', tool: 'screen_candidates' },
    { title: 'Self-check the ranking', tool: 'verify_screening' },
    { title: 'Book the next best candidate', tool: 'schedule_interviews' },
    { title: 'Email the invite', tool: 'send_email' },
    { title: 'Verify the new booking', tool: 'verify_hiring_outcome' },
    { title: 'Deliver the report', tool: 'finish' },
  ] });
  const others = store.db.interviews.filter(i => i.jobId === job.id && i.status !== 'declined').length;
  await callTool(ctx, 'log_decision', {
    situation: `${declined.name} declined the ${job.title} interview on ${declined.when}. ${others} other interview(s) still stand.`,
    options: ['Book the next best qualified candidate', 'Leave the slot empty and tell the owner'],
    choice: 'Book the next best qualified candidate',
    reason: 'The owner asked for a full shortlist, and the next person in the ranking already passed screening.',
  });
  const relaxBudget = Math.max(0, 1 - (job.relaxed || []).length);
  const { booked, screened } = await bookTowardGoal(ctx, job.id, 1, { radius: job.searchRadiusKm || RADII[0], relaxBudget });
  await emailInterviews(ctx, job, booked, screened);
  if (job.ownerEmail) {
    await callTool(ctx, 'send_email', { to: job.ownerEmail, kind: 'owner_summary', subject: `${declined.name} declined, ${booked[0] ? `${booked[0].name} is booked instead` : 'slot still open'}`,
      body: `${declined.name} declined the interview on ${declined.when}.\n${booked[0] ? `I booked ${booked[0].name} for ${booked[0].when}.` : 'Nobody else qualified, so the slot is open.'}\n\nJob post: ${jobUrl(ctx, job.id)}\nFull agent run: ${ctx.baseUrl}/runs/${ctx.run.id}` });
  }
  const check = await callTool(ctx, 'verify_hiring_outcome', { jobId: job.id });
  await callTool(ctx, 'finish', { summary: booked[0]
    ? `${declined.name} declined, so I booked the next best candidate: ${booked[0].name} (${screened.details.find(d => d.id === booked[0].candidateId)?.score}/100) on ${booked[0].when}, invite emailed. ${check.passed}/${check.total} self-checks passed.`
    : `${declined.name} declined and nobody else qualifies for ${job.title} right now, so the slot stays open.${decisionSummary(ctx)} ${check.passed}/${check.total} self-checks passed.` });
}

// Job seeker (often blind or low vision): find jobs that suit them, apply, book interviews,
// and keep adapting until GOAL interviews are booked or no option is left.
const SEEKER_GOAL = 3;

function seekerEmail(iv, job, s, ctx) {
  // Plain text, most important first: a screen reader reads this top to bottom.
  return `Interview: ${iv.when} (Malaysia time), 30 minutes.\n${iv.howToJoin}\n\n`
    + `Hi ${s.name.split(' ')[0]}, this is HireBuddy. You have an interview for ${job.title} at ${job.business}.\n`
    + `Pay: RM${job.pay} per ${job.payUnit}. Work: ${job.access?.workMode || 'on-site'}.\n`
    + `A calendar invitation is attached.\nJob details: ${jobUrl(ctx, job.id)}\n`
    + `Can't make it? Say so on your HireBuddy page (${ctx.baseUrl}/me) and I will find another time.`;
}

async function applyAndBook(ctx, s, r) {
  const job = store.db.jobs.find(j => j.id === r.jobId);
  const ev = r.evidence.filter(e => e.required).map(e => e.skill);
  const skill = ev[0] || s.skills[0];
  const note = `Hello ${r.business}, I would like to apply for the ${r.title} role. I have ${ev.length ? ev.join(' and ') : skill} experience`
    + ` and I am free ${L.describeSchedule(s.availability)}. Thank you.`;
  const app = await callTool(ctx, 'apply_to_job', { studentId: s.id, jobId: r.jobId, coverNote: note });
  if (!app.ok) return null;
  const iv = await callTool(ctx, 'book_interview', { studentId: s.id, jobId: r.jobId });
  if (!iv.ok) return null;
  const stored = store.db.interviews.find(i => i.id === iv.interviewId);
  await callTool(ctx, 'send_email', { to: s.email, subject: `Interview ${iv.when}: ${r.title}, ${r.business}`, body: seekerEmail(stored, job, s, ctx), interviewId: iv.interviewId, kind: 'interview_invite' });
  return iv;
}

// Ways to find more suitable jobs, each simulated first: jobs = what it would add.
// cost: how much of what they asked for an option gives up. Anything they stated themselves
// (their pay floor, a walking limit they named) is never dropped without their word (yours: true).
function seekerOptions(s, opts, walkStated) {
  const now = new Set(matchJobs(s, opts).filter(r => r.suitable && !r.applied).map(r => r.jobId));
  const gain = o => matchJobs(s, { ...opts, ...o }).filter(r => r.suitable && !r.applied && !now.has(r.jobId));
  const options = [];
  if (s.needs?.screenReader && !opts.askAboutTech) options.push({ id: 'ask_about_screen_reader', label: 'Include jobs that don\'t mention screen reader support, and ask the employer in the application', change: { askAboutTech: true }, cost: 0 });
  if (opts.maxDistanceKm < 60) options.push({ id: 'whole_klang_valley', label: 'Search the whole Klang Valley, not just 25 km', change: { maxDistanceKm: 60 }, cost: 1 });
  if (s.needs && !s.needs.remoteOnly && (opts.maxWalkMin || L.DEFAULT_WALK) < 15) options.push({ id: 'walk_15_minutes', label: `Accept up to a 15-minute walk from the stop (now ${opts.maxWalkMin || L.DEFAULT_WALK})`, change: { maxWalkMin: 15 }, cost: 2, yours: !!walkStated });
  if (opts.minPay > L.MIN_WAGE.hour) options.push({ id: 'lower_pay_floor', label: `Lower your minimum pay from RM${opts.minPay}/h to the legal minimum RM${L.MIN_WAGE.hour}/h`, change: { minPay: 0 }, cost: 3, yours: true });
  for (const o of options) o.jobs = gain(o.change);
  return options;
}

async function autopilotStudent(ctx) {
  if (ctx.run.options?.rescheduleInterviewId) return autopilotReschedule(ctx);
  const p = parse.student(ctx.run.prompt);
  const goal = SEEKER_GOAL;
  ctx.run.goal = goal;
  const n = p.needs;
  say(ctx, `Understood: ${p.name}, based in ${p.area}, free ${L.describeSchedule(p.availability)}, skills ${p.skills.join(', ')}.`
    + `${n ? ` Needs: ${n.vision}, uses ${n.tool}${n.remoteOnly ? ', remote work only' : `, up to a ${n.maxWalkMin}-minute walk from a stop`}${n.interviewFormat ? `, ${n.interviewFormat} interviews` : ''}.` : ''}`
    + `${p.minPay ? ` At least RM${p.minPay}/h.` : ''} Goal: ${goal} interviews.`);
  await callTool(ctx, 'set_plan', { steps: [
    { title: 'Save your profile and needs', tool: 'register_student' },
    { title: 'Find jobs and check each one suits you', tool: 'search_jobs' },
    { title: 'If too few suit you: decide what to change', tool: 'log_decision' },
    { title: 'Apply, with your interview needs', tool: 'apply_to_job' },
    { title: `Book up to ${goal} interviews`, tool: 'book_interview' },
    { title: 'Email you each interview, time first', tool: 'send_email' },
    ...(ctx.run.options?.listings?.length ? [{ title: `Check the ${outside.clean(ctx.run.options.listings).length} jobs WorkBuddy found on other sites`, tool: 'check_outside_listings' }] : []),
    { title: 'Check everything again', tool: 'verify_applications' },
    { title: 'Tell you the result', tool: 'finish' },
  ] });
  const reg = await callTool(ctx, 'register_student', { name: p.name, email: p.email || undefined, area: p.area, campus: p.campus || undefined, skills: p.skills,
    availability: p.availability, expectedRate: p.expectedRate || undefined, bio: p.bio, needs: n || undefined });
  if (!reg.ok) return say(ctx, (reg.problems || []).join(' '));
  const s = store.db.students.find(x => x.id === reg.studentId);

  let opts = { maxDistanceKm: 25, minPay: p.minPay || 0, maxWalkMin: n?.maxWalkMin, askAboutTech: false };
  const booked = [];
  // Run again (a rehearsal, or a second visit): interviews already booked still count toward the goal.
  const existing = store.db.interviews.filter(i => i.studentId === s.id && i.status !== 'declined' && new Date(i.start) > new Date());
  if (existing.length) {
    booked.push(...existing.slice(0, goal));
    ctx.run.interviews = booked.map(i => i.id);
    say(ctx, `You already have ${booked.length} interview${booked.length === 1 ? '' : 's'} booked from before, so I keep ${booked.length === 1 ? 'it' : 'them'} and only look for more if needed.`);
  }
  let found;
  for (let round = 1; round <= 6; round++) {
    found = await callTool(ctx, 'search_jobs', { studentId: s.id, ...opts });
    for (const r of found.results.filter(r => !r.legalPay)) if (round === 1) say(ctx, `Skipping ${r.title} at ${r.business}: ${r.warning}`);
    if (round === 1 && n) {
      const out = found.results.filter(r => r.legalPay && r.access.fit === 'not suitable' && r.score >= MINIMUM_MATCH).slice(0, 3);
      for (const r of out) say(ctx, `Not suitable: ${r.title} at ${r.business}, because ${r.access.blockers[0]}.`);
    }
    const picks = found.results.filter(r => r.suitable && !r.applied).slice(0, goal - booked.length);
    say(ctx, `Round ${round}: ${found.suitable} job(s) suit you${picks.length ? `. Applying to ${picks.map(r => `${r.title} at ${r.business} (${r.score}/100)`).join(', ')}` : ''}.`);
    for (const r of picks) { const iv = await applyAndBook(ctx, s, r); if (iv) booked.push(iv); }
    if (booked.length >= goal) break;

    // Short of the goal: simulate each change and pick the one that adds the most suitable jobs.
    const options = seekerOptions(s, opts, !!p.needs?.walkStated);
    const best = options.filter(o => o.jobs.length && !o.yours).sort((a, b) => a.cost - b.cost)[0];
    const askYou = options.filter(o => o.jobs.length && o.yours);
    if (!best && askYou.length) ctx.run.suggestions = askYou.map(o => `${o.label.replace(/^Lower your/, 'If you lower your').replace(/^Accept/, 'If you accept')}, I could apply to ${o.jobs.map(r => `${r.title} at ${r.business} (${r.pay})`).join(' and ')}. Tell me and I will.`);
    const stopLabel = `Stop at ${booked.length} interview${booked.length === 1 ? '' : 's'} and tell you what came closest`;
    await callTool(ctx, 'log_decision', {
      situation: `${booked.length} of ${goal} interviews booked after round ${round}; no other job suits you with the current settings.`,
      options: [...options.map(o => `${o.label} (${o.jobs.length ? `+${o.jobs.length} job${o.jobs.length === 1 ? '' : 's'}` : 'adds nothing'}${o.yours ? ', needs your OK' : ''})`), `${stopLabel} (adds nothing)`],
      choice: best ? best.label : stopLabel,
      reason: best ? `It adds ${best.jobs.map(r => `${r.title} at ${r.business}`).join(' and ')}, and nothing about your needs is given up.`.replace('and nothing about your needs is given up', best.change.askAboutTech ? 'and the application asks the question for you' : best.change.minPay === 0 ? 'and those jobs still pay at least the legal minimum' : 'and every other need still holds')
        : askYou.length ? `The only changes that add a job give up something you asked for (${askYou.map(o => o.label.replace(/^\w/, c => c.toLowerCase())).join('; ')}), so that is your call, not mine.`
        : 'No change adds a job that suits you. Applying to unsuitable jobs would waste your time.',
    });
    if (!best) break;
    opts = { ...opts, ...best.change };
  }

  if (ctx.run.options?.listings?.length) await callTool(ctx, 'check_outside_listings', { studentId: s.id });
  const check = await callTool(ctx, 'verify_applications', { studentId: s.id });
  const ivs = store.db.interviews.filter(i => (ctx.run.interviews || []).includes(i.id)).sort((a, b) => a.start.localeCompare(b.start));
  const lines = ivs.map((iv, i) => { const j = store.db.jobs.find(x => x.id === iv.jobId); return `${i + 1}. ${j.title} at ${j.business}, ${iv.whenLong}, ${iv.format}${s.needs?.interviewFormat && iv.format !== s.needs.interviewFormat ? ` (they only offer ${(j.access?.interviewFormats || []).join(' or ')})` : ''}. ${iv.howToJoin}`; });
  const skipped = found.results.filter(r => r.legalPay && r.access.fit === 'not suitable' && r.score >= MINIMUM_MATCH).length;
  const why = r => r.whyNot;
  const closest = ivs.length < goal ? found.results.filter(r => r.legalPay && !r.suitable && !r.applied).slice(0, 2) : [];
  if (closest.length) ctx.run.suggestions = (ctx.run.suggestions || []).concat(`Closest other jobs: ${closest.map(r => `${r.title} at ${r.business}, not booked because ${why(r)}`).join('; ')}.`);
  await callTool(ctx, 'finish', { summary: ivs.length
    ? `You have ${ivs.length} interview${ivs.length === 1 ? '' : 's'}.\n${lines.join('\n')}\nEach one is in your email with the time first and a calendar invite.`
      + `${skipped ? ` I left out ${skipped} job${skipped === 1 ? '' : 's'} that did not suit your needs.` : ''}${decisionSummary(ctx)}${(ctx.run.suggestions || []).map(x => ` ${x}`).join('')}${outside.summarise(ctx.run.outside || [])} ${check.passed} of ${check.total} checks passed.`
    : `No job on HireBuddy suits you right now, so I booked nothing. Your profile is saved and employers can find you.${decisionSummary(ctx)}${outside.summarise(ctx.run.outside || [])} ${check.passed} of ${check.total} checks passed.` });
}

// The seeker said they can't make an interview: find another time with the same employer,
// or the next best job if that employer has no other time.
async function autopilotReschedule(ctx) {
  const old = store.db.interviews.find(i => i.id === ctx.run.options.rescheduleInterviewId);
  const job = store.db.jobs.find(j => j.id === old.jobId);
  const s = store.db.students.find(x => x.id === old.studentId);
  ctx.run.goal = 1;
  ctx.run.studentId = s.id;
  await callTool(ctx, 'set_plan', { steps: [
    { title: 'Decide how to replace the interview', tool: 'log_decision' },
    { title: 'Book a new time', tool: 'book_interview' },
    { title: 'Email you the new time', tool: 'send_email' },
    { title: 'Check everything again', tool: 'verify_applications' },
    { title: 'Tell you the result', tool: 'finish' },
  ] });
  await callTool(ctx, 'log_decision', {
    situation: `${s.name} can't make the ${job.title} interview with ${job.business} on ${old.when}.`,
    options: [`Move it to another time with ${job.business}`, 'Book the next best job instead', 'Cancel and tell the employer'],
    choice: `Move it to another time with ${job.business}`,
    reason: `${job.business} was the best match and still has interview hours; only the time was the problem.`,
  });
  let iv = await callTool(ctx, 'book_interview', { studentId: s.id, jobId: job.id, format: old.format });
  let j = job;
  if (!iv.ok) {
    const next = matchJobs(s, ctx.run.search || {}).find(r => r.suitable && !r.applied);
    await callTool(ctx, 'log_decision', { situation: `${job.business} has no other time in the next 14 days.`, options: ['Book the next best job instead', 'Stop and tell you'],
      choice: next ? 'Book the next best job instead' : 'Stop and tell you', reason: next ? `${next.title} at ${next.business} suits you (${next.score}/100).` : 'No other job suits you right now.' });
    if (next) { iv = await applyAndBook(ctx, s, next); j = store.db.jobs.find(x => x.id === next.jobId); }
  } else {
    const stored = store.db.interviews.find(i => i.id === iv.interviewId);
    await callTool(ctx, 'send_email', { to: s.email, subject: `New time ${iv.when}: ${job.title}, ${job.business}`, body: seekerEmail(stored, job, s, ctx), interviewId: iv.interviewId, kind: 'interview_invite' });
    const em = { id: store.id('mail'), to: job.ownerEmail || 'owner@example.com', kind: 'other', subject: `${s.name} moved their interview to ${iv.when}`,
      body: `${s.name} could not make ${old.when}. HireBuddy booked ${iv.when} inside your interview hours instead.\nJob: ${jobUrl(ctx, job.id)}`, at: new Date().toISOString(), runId: ctx.run.id };
    em.delivery = await require('./mail').deliver(em);
    store.db.emails.push(em);
  }
  const check = await callTool(ctx, 'verify_applications', { studentId: s.id });
  await callTool(ctx, 'finish', { summary: iv?.ok
    ? `Done. Your ${j.title} interview with ${j.business} is now ${iv.whenLong}, ${iv.format}. ${iv.howToJoin} The new invite is in your email. ${check.passed} of ${check.total} checks passed.`
    : `${job.business} has no other time and no other job suits you right now, so nothing is booked. ${check.passed} of ${check.total} checks passed.` });
}

// ---------------------------------------------------------------------------
// LLM mode: the model plans and calls the same tools; a gate stops it finishing unverified.

function systemPrompt(persona, baseUrl, GOAL = 3) {
  const now = new Date();
  const today = L.fmtMyt(now);
  const common = `You are HireBuddy, an autonomous hiring agent for Malaysian small businesses and students. Today is ${today} (Malaysia time, UTC+8). The app runs at ${baseUrl}.
Work fully autonomously from the single user prompt. Never ask the user questions; pick sensible defaults and state them.
1. First call set_plan with your steps, each naming the tool that completes it.
2. Execute with tools. When a tool returns ok:false with problems, fix exactly those problems and call it again.
3. Before finishing you MUST run the final verify tool and it must pass. Then call finish with a short plain-language summary including links.
Weekly schedules use day keys Mon Tue Wed Thu Fri Sat Sun with 24h ranges, e.g. {"Sat":["08:00-14:00"]}. Skills are short lowercase phrases.`;
  if (persona === 'student') return `${common}
User: a job seeker, often blind or low vision. Goal: ${GOAL} booked interviews for jobs that truly suit them.
Steps: register_student (bio built only from what they said; fill needs with their sight loss, the tool they use (e.g. NVDA), remote-only, longest walk from a stop, preferred interview format), search_jobs (each result has access.fit and suitable), apply_to_job to suitable jobs only (personal cover note naming the job and a real skill), book_interview for each, send_email each interview to the seeker with interviewId (plain text; line 1 the exact "when", line 2 how to join, then the rest), and keep going until ${GOAL} are booked.
If too few jobs suit them, call log_decision with the real options (askAboutTech to include jobs that do not state screen reader support, maxWalkMin 15, maxDistanceKm 60, lower minPay to the legal minimum, or stop), choose the one that adds suitable jobs without giving up a need they stated, then search again. Never apply to a job with access blockers or illegal pay.
If the message says WorkBuddy found jobs on other sites, call check_outside_listings once before verify_applications and include its result in the summary: which are worth asking about (drafted, not sent) and which do not suit and why. Say plainly that you cannot apply or book on other sites.
If the message has rescheduleInterviewId, they can't make that interview: log_decision, book_interview again for the same job (a new time is found automatically), email them, verify_applications, finish.
Finish with a short summary written to be heard on a screen reader: number of interviews, then one line each with job, employer, day and time, format and how to join.`;
  return `${common}
User: a small-business owner hiring part-timers. Your goal is ${GOAL} booked interviews with candidates who meet every must-have (or 2x the hires requested if more).
Steps: check_minimum_wage (if illegal, explain and finish without publishing), publish_job (write an attractive ad that states pay and area; infer must-have skills), then loop:
- find_candidates (start at 10 km), screen_candidates on all of them.
- Judge fit from what people wrote, not keywords: screen_candidates returns "profiles" with each near miss's bio and missing skills. If a bio shows a missing skill in other words (e.g. "worked at a bubble tea shop" shows drinks preparation), call record_fit_judgement with an exact quote from the bio, then screen again. Never judge a skill the bio does not support.
- verify_screening, then schedule_interviews for qualified candidates (qualified:true) up to the goal.
- If you are short of the goal, call log_decision listing the real options (widen the radius to 20 or 30 km, relax_requirement on one non-core must-have, look further ahead with withinDays 14, or stop and report who came closest), choose the one that actually adds qualified candidates, give the reason, then act and loop. Relax at most one requirement the owner stated.
Then send_email an invite to each booked candidate (pass interviewId; body must contain the exact "when" text, the meetUrl video link and the job link), email the owner a summary if they gave an email, verify_hiring_outcome, finish (mention every decision you made and who came closest if short).
If the user message says a candidate declined (replaceInterviewId), do not publish anything: log_decision on how to fill the slot, then find, screen, verify and book ONE next best qualified candidate for that jobId, email them, verify_hiring_outcome and finish.`;
}

// Some OpenAI-compatible endpoints (e.g. Google Gemini) reject additionalProperties in schemas.
function stripExtras(schema) {
  if (Array.isArray(schema)) return schema.map(stripExtras);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, stripExtras(v)]));
}

function toOpenAiTools(names) {
  const clean = /googleapis|gemini/i.test(llm.BASE);
  return names.map(n => ({ type: 'function', function: { name: n, description: tools[n].description, parameters: clean ? stripExtras(tools[n].parameters) : tools[n].parameters } }));
}

async function llmLoop(ctx) {
  const names = ctx.run.persona === 'student' ? STUDENT_TOOLS : HIRER_TOOLS;
  if (ctx.run.persona === 'hirer') ctx.run.goal = ctx.run.options?.replaceInterviewId ? 1 : Math.max(3, parse.hirer(ctx.run.prompt).hires);
  const messages = [
    { role: 'system', content: systemPrompt(ctx.run.persona, ctx.baseUrl, ctx.run.goal) },
    { role: 'user', content: (() => {
      const { listings, ...rest } = ctx.run.options || {};
      return ctx.run.prompt + (Object.keys(rest).length ? `\n(Details: ${JSON.stringify(rest)})` : '')
        + (listings?.length ? `\n(WorkBuddy found ${outside.clean(listings).length} jobs on other sites. Check them with check_outside_listings.)` : '');
    })() },
  ];
  const defs = toOpenAiTools(names);
  let nudges = 0, lastFail = '', repeats = 0, failStreak = 0;
  for (let turn = 0; turn < 45 && !ctx.run.done; turn++) {
    const msg = await llm.chat(messages, defs);
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    if (msg.content?.trim()) say(ctx, msg.content.trim());
    if (!msg.tool_calls?.length) {
      if (++nudges > 3) break;
      messages.push({ role: 'user', content: 'Continue autonomously with tool calls. Call finish only after the final verification passes.' });
      continue;
    }
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      if (tc.function.name === 'check_minimum_wage') {
        const w = L.checkWage(args.pay, args.payUnit);
        if (!w.ok && ctx.run.persona === 'hirer') ctx.run.wageBlocked = true;
      }
      const result = await callTool(ctx, tc.function.name, args);
      const text = JSON.stringify(result);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: text.length > 8000 ? text.slice(0, 8000) + '...(truncated)' : text });
      if (result.ok === false) {
        const sig = tc.function.name + JSON.stringify(result.problems || result.error);
        repeats = sig === lastFail ? repeats + 1 : 0;
        lastFail = sig;
        failStreak++;
      } else { repeats = 0; failStreak = 0; lastFail = ''; }
      if (ctx.run.done) break;
    }
    if (repeats >= 2) {
      messages.push({ role: 'user', content: 'You repeated a call that keeps failing with the same problems. Re-read the earlier tool results for the correct values (ids, emails, times) and change the arguments.' });
      repeats = 0;
    }
    if (failStreak >= 8) throw new Error('The model kept making failing tool calls; stopped to avoid looping.');
  }
}

async function execute(run, baseUrl) {
  const ctx = makeCtx(run, baseUrl);
  live.set(run.id, ctx);
  ctx.emit({ type: 'start', prompt: run.prompt, persona: run.persona, mode: run.mode });
  try {
    if (llm.enabled()) {
      try {
        await llmLoop(ctx);
      } catch (e) {
        if (run.events.some(ev => ev.type === 'tool_call' && ev.tool !== 'set_plan')) throw e;
        say(ctx, `The language model is unavailable (${e.message}). Switching to the rule-based autopilot.`);
        run.mode = 'Autopilot (LLM fallback)';
      }
    }
    if (!run.done && !run.events.some(ev => ev.type === 'tool_call' && ev.tool !== 'set_plan')) {
      run.plan = [];
      await (run.persona === 'student' ? autopilotStudent(ctx) : autopilotHirer(ctx));
    }
    run.status = run.done ? 'done' : 'incomplete';
  } catch (e) {
    run.status = 'error';
    ctx.emit({ type: 'error', message: e.message });
  }
  // A refused job stops early: the steps it never reached are shown as skipped, not done.
  if (run.done) for (const s of run.plan) s.status = run.wageBlocked && !run.events.some(e => e.type === 'tool_call' && e.tool === s.tool) ? 'skipped' : 'done';
  ctx.emit({ type: 'final', status: run.status, verified: run.verified, summary: run.summary, plan: run.plan, links: links(run, baseUrl) });
  live.delete(run.id);
  store.save();
  return run;
}

function links(run, baseUrl) {
  const out = [{ label: 'Agent run log', url: `${baseUrl}/runs/${run.id}` }];
  if (run.jobId) out.push({ label: 'Published job page', url: `${baseUrl}/jobs/${run.jobId}` });
  for (const id of run.interviews || []) {
    const iv = store.db.interviews.find(i => i.id === id);
    if (iv) out.push({ label: `Calendar invite: ${iv.name}`, url: `${baseUrl}/ics/${iv.id}.ics` });
  }
  if (store.db.emails.some(e => e.runId === run.id)) out.push({ label: 'Emails sent', url: `${baseUrl}/outbox?run=${run.id}` });
  return out;
}

// Let finish through when the agent correctly refused to publish an illegal wage.
const origFinish = tools.finish.run;
tools.finish.run = async (args, ctx) => {
  if (ctx.run.wageBlocked && ctx.run.persona === 'hirer' && !ctx.run.jobId) ctx.run.verified = true;
  return origFinish(args, ctx);
};

// Called when a job seeker says they can't make an interview they booked through HireBuddy.
function rescheduleAfterDecline(iv, baseUrl) {
  const job = store.db.jobs.find(j => j.id === iv.jobId);
  const run = newRun(`${iv.name} can't make the ${job.title} interview with ${job.business} on ${iv.when}. Find another time.`, 'student', 'decline',
    { rescheduleInterviewId: iv.id });
  iv.replanRunId = run.id;
  store.save();
  execute(run, baseUrl);
  return run;
}

// Called when a student declines on My page: the agent books the next best candidate.
function replanAfterDecline(iv, baseUrl) {
  const job = store.db.jobs.find(j => j.id === iv.jobId);
  const run = newRun(`${iv.name} declined the ${job.title} interview at ${job.business}. Book the next best candidate and re-verify.`, 'hirer', 'decline',
    { replaceInterviewId: iv.id, jobId: job.id });
  run.jobId = job.id;
  iv.replanRunId = run.id;
  store.save();
  execute(run, baseUrl);
  return run;
}

module.exports = { newRun, execute, bus, live, detectPersona, links, replanAfterDecline, rescheduleAfterDecline,
  makeCtx, callTool, say, applyAndBook, seekerOptions, decisionSummary, SEEKER_GOAL };
