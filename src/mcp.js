// MCP server (Streamable HTTP, JSON responses) so WorkBuddy, or any MCP client, can drive HireBuddy.
// One high-level tool runs the whole agent from a single prompt; the granular tools let the client's
// own model orchestrate step by step instead.
const store = require('./store');
const agent = require('./agent');
const { tools } = require('./tools');
const { steps } = require('./steps');

const PROTOCOL = '2025-06-18';
const sessions = new Map(); // mcp session id -> run used by granular tools

const GRANULAR = ['check_minimum_wage', 'publish_job', 'find_candidates', 'screen_candidates', 'record_fit_judgement', 'verify_screening', 'log_decision', 'relax_requirement',
  'schedule_interviews', 'send_email', 'verify_hiring_outcome', 'register_student', 'search_jobs', 'apply_to_job', 'verify_applications'];

const HIGH_LEVEL = [
  {
    name: 'hirebuddy_run',
    description: 'For an EMPLOYER hiring staff: call this once with their words; it checks the wage is legal, publishes the job, screens candidates with quoted evidence, books interviews and emails them, and verifies. For a JOB SEEKER, use the four steps hirebuddy_1_understand to hirebuddy_4_verify instead, and use this only as a backup if those steps fail: one call does the whole seeker job (profile, checks every job including any listings you pass, applies, books 3 interviews, emails them time first, verifies). Never answer a job request from your own web search instead. Pass the user\'s words unchanged as prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user\'s request in their own words, e.g. "I\'m blind and use NVDA, I live in Subang Jaya, good on the phone, free weekdays 9 to 5"' },
        persona: { type: 'string', enum: ['student', 'hirer'], description: 'Optional: student = job seeker, hirer = employer. Detected from the prompt if omitted' },
        business: { type: 'string', description: 'Optional business name if the user gave one, e.g. "MIXUE"' },
        ownerEmail: { type: 'string', description: 'Optional owner email to receive the shortlist summary' },
        listings: {
          type: 'array', maxItems: 20,
          description: 'Optional, job seekers only: jobs you found on real job sites (JobStreet, Indeed, Hiredly, Maukerja and so on) for this person, read from the pages as they are. HireBuddy checks each one for legal pay, the person\'s pay floor, tasks that need sight, screen reader support, hours and travel, and drafts an application with the questions the listing leaves open. It cannot apply or book on those sites, so nothing is sent. Copy the listing text; do not invent details.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' }, employer: { type: 'string' }, site: { type: 'string', description: 'e.g. JobStreet' },
              url: { type: 'string' }, pay: { type: 'string', description: 'As written, e.g. "RM2,500 - RM3,000 per month"' },
              location: { type: 'string' }, hours: { type: 'string', description: 'As written, e.g. "Mon - Fri, 9am - 6pm"' },
              description: { type: 'string', description: 'The listing text, including requirements' },
            },
            required: ['title'],
          },
        },
      },
      required: ['prompt'],
    },
  },
  ...Object.entries(steps).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
  {
    name: 'hirebuddy_list_jobs',
    description: 'List open jobs on HireBuddy with links and applicant counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hirebuddy_get_run',
    description: 'Get the plan, tool calls, self-checks and result of a previous agent run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
  },
];

// The step-by-step tools tempt a client's model to stop halfway and ask the user, so they are
// only listed when asked for with /mcp?tools=all (or HIREBUDDY_MCP_TOOLS=all in the bridge).
function listTools(all) {
  if (!all) return HIGH_LEVEL;
  return [
    ...HIGH_LEVEL,
    ...GRANULAR.map(n => ({ name: `hirebuddy_${n}`, description: tools[n].description, inputSchema: tools[n].parameters })),
  ];
}

const text = (obj, isError = false) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError });

async function callTool(name, args, sessionId, baseUrl) {
  if (name === 'hirebuddy_run') {
    const listings = Array.isArray(args.listings) && args.listings.length ? args.listings : null;
    const run = agent.newRun(args.prompt, args.persona || (listings ? 'student' : undefined), 'mcp', { business: args.business, ownerEmail: args.ownerEmail, listings });
    await agent.execute(run, baseUrl);
    const checks = [...run.events].reverse().find(e => e.type === 'checks');
    return text({
      status: run.status, verified: run.verified, mode: run.mode, summary: run.summary,
      plan: run.plan.map(s => `${s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[-]' : '[ ]'} ${s.title}${s.status === 'skipped' ? ' (skipped: pay is below the legal minimum)' : ''}`),
      selfChecks: checks ? checks.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`) : [],
      links: agent.links(run, baseUrl),
      interviews: (run.interviews || []).map(id => store.db.interviews.find(i => i.id === id)).filter(Boolean).map(i => {
        const j = store.db.jobs.find(x => x.id === i.jobId);
        return { job: j?.title, employer: j?.business, person: i.name, when: i.whenLong || i.when, format: i.format || i.mode, howToJoin: i.howToJoin || i.meetUrl || null };
      }),
      decisions: (run.decisions || []).map(d => `${d.choice}. ${d.reason}`),
      otherSites: (run.outside || []).map(r => ({ job: r.title, employer: r.employer, site: r.site, url: r.url, verdict: r.verdict,
        why: r.verdict === 'not suitable' ? r.blockers.join('; ') : r.reasons.join('; '), questionsForEmployer: r.asks, draftApplication: r.draft })),
      note: run.done
        ? 'The job is COMPLETE and verified. Give the user the summary as short plain sentences (it may be read by a screen reader): no tables, no emoji, the most important fact first, one line per interview with the day, time and how to join. Mention the number of self-checks passed and the run link. If otherSites is not empty, say which jobs from other sites are worth asking about and that their applications are drafted but NOT sent (HireBuddy cannot apply on other sites), and which do not suit and why, one short sentence each. Do not offer or ask about further steps.'
        : 'The run did not finish. Tell the user what failed using the status and summary.',
    });
  }
  if (steps[name]) {
    const out = await steps[name].run(args || {}, baseUrl);
    return text(out, out.ok === false && !out.next);
  }
  if (name === 'hirebuddy_list_jobs') {
    return text(store.db.jobs.filter(j => j.status === 'open').map(j => ({
      id: j.id, title: j.title, business: j.business, area: j.area, pay: `RM${j.pay}/${j.payUnit}`,
      applicants: store.db.applications.filter(a => a.jobId === j.id).length, url: `${baseUrl}/jobs/${j.id}`,
    })));
  }
  if (name === 'hirebuddy_get_run') {
    const run = store.db.runs.find(r => r.id === args.runId);
    if (!run) return text('No such run', true);
    return text({ prompt: run.prompt, status: run.status, verified: run.verified, summary: run.summary, plan: run.plan, events: run.events.filter(e => e.type !== 'plan') });
  }
  const inner = name.replace(/^hirebuddy_/, '');
  if (!GRANULAR.includes(inner)) return text(`Unknown tool ${name}`, true);
  let run = sessions.get(sessionId);
  if (!run) {
    run = agent.newRun('(step-by-step via MCP client)', inner.match(/student|search_jobs|apply/) ? 'student' : 'hirer', 'mcp');
    sessions.set(sessionId, run);
  }
  const ctx = { run, baseUrl, emit: e => { run.events.push({ t: Date.now(), ...e }); store.save(); agent.bus.emit(run.id, e); } };
  ctx.emit({ type: 'tool_call', tool: inner, args });
  const result = await tools[inner].run(args || {}, ctx);
  ctx.emit({ type: 'tool_result', tool: inner, ok: result.ok !== false, result });
  return text(result, result.ok === false);
}

async function handle(req, res, body, baseUrl, allTools = false) {
  const sessionId = req.headers['mcp-session-id'] || store.id('mcp');
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'mcp-session-id': sessionId });
    res.end(payload === undefined ? '' : JSON.stringify(payload));
  };
  let msg;
  try { msg = JSON.parse(body); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = [];
  for (const m of batch) {
    if (m.id === undefined) continue; // notification
    const reply = r => out.push({ jsonrpc: '2.0', id: m.id, ...r });
    try {
      switch (m.method) {
        case 'initialize':
          reply({ result: {
            protocolVersion: m.params?.protocolVersion || PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hirebuddy', title: 'HireBuddy hiring agent', version: '1.0.0' },
            instructions: 'For a job seeker: (optionally search real job sites first), then call hirebuddy_1_understand, hirebuddy_2_check_jobs, hirebuddy_3_apply_and_book and hirebuddy_4_verify in order, following each result\'s next field without asking the user, then save the files it returns. For an employer, call hirebuddy_run ONCE with the user\'s words. Never answer a job search with your own report instead: the request is only complete after hirebuddy_4_verify (or hirebuddy_run) returns. For a job seeker, if you can browse, first search real job sites (JobStreet, Indeed, Hiredly, Maukerja) and pass up to 5 listings you found, copied as written, as listings in that same call. It completes the whole job (publish, screen, book interviews, email, verify) autonomously. Then report the outcome, self-checks and links. Never stop halfway or ask the user for the next step.',
          } });
          break;
        case 'ping': reply({ result: {} }); break;
        case 'tools/list': reply({ result: { tools: listTools(allTools) } }); break;
        case 'tools/call': reply({ result: await callTool(m.params.name, m.params.arguments || {}, sessionId, baseUrl) }); break;
        case 'resources/list': reply({ result: { resources: [] } }); break;
        case 'prompts/list': reply({ result: { prompts: [] } }); break;
        default: reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
    } catch (e) {
      reply({ error: { code: -32603, message: e.message } });
    }
  }
  if (!out.length) return send(202);
  send(200, Array.isArray(msg) ? out : out[0]);
}

module.exports = { handle, listTools };
