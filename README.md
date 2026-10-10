# HireBuddy

**Say the work you want in one sentence. HireBuddy finds jobs that suit you, applies, books interviews and checks everything.**

HireBuddy is an autonomous job agent built first for **blind and low-vision job seekers in Malaysia**. It runs inside **WorkBuddy** (as an MCP server and a Skill) and as a web app that works fully with a screen reader and a keyboard alone.

> *"I'm Nadia Rahim. I'm blind and use NVDA. I live in Subang Jaya and take the LRT. I did customer service calls at a bank hotline for a year and type fast in English and Malay. Free weekdays 9am to 5pm, at least RM12 an hour, phone interviews please."*

From that one sentence, with no further questions, HireBuddy:

1. **Plans** the work as a checklist, where each step names the tool that completes it.
2. **Saves her profile and needs**: blind, uses NVDA, up to a 10-minute walk from a stop, phone interviews, at least RM12 an hour.
3. **Checks every open job** against the law (Minimum Wages Order 2024, RM8.72 an hour) and against her needs: remote or a short walk from a train or bus stop, screen reader support stated, no tasks that need sight (for example riding a motorcycle), an interview format she can use. It says why each unsuitable job is left out.
4. **Applies** with a short note naming the job and her real skills. The employer also receives her interview needs ("send documents as Word or plain text, not scanned images").
5. **Books interviews** inside the employer's interview hours and her free time, never overlapping, by phone where offered. In-person interviews must be reachable by public transport.
6. **Emails her each interview** in plain text with the time on line one and how to join on line two, plus a calendar invitation.
7. **Verifies everything** (28 checks in the demo run) and is **not allowed to finish** until they pass. Then it gives a summary written to be heard on a screen reader.

## What makes it an agent, not a button

- **It adapts toward a goal.** The goal is 3 interviews. When too few jobs suit her, it tries each possible change on paper, picks the one that adds jobs without giving up anything she asked for, logs the decision with its reason, and searches again. In the Nadia demo it includes a clinic job whose listing doesn't mention screen readers and asks the employer about it in the application. It never lowers her pay floor or her walking limit itself: it tells her what that would add and leaves the choice to her.
- **"I can't make it".** On her page, one button hands the interview back to the agent. It finds another time with the same employer (or the next best job), emails her the new time, tells the employer and re-verifies.
- **It refuses illegal pay** from both sides: it never applies to an underpaid job, and an employer who types "RM55 a day, 8-hour shifts" is refused before anything is published.
- **With `LLM_API_KEY`** the model makes these choices itself, judged by the same tools and checks. Without a key, the rule-based planner runs the same loop.

## Built for screen readers and low vision

- Skip link, landmarks and a clear heading structure on every page; the current page is announced in the menu.
- While the agent works, one polite live-region update per step ("Step 3 of 8: Apply, with your interview needs"), not a flood. When it finishes, focus moves to the result.
- Keyboard only throughout, with a thick yellow focus ring. Buttons are at least 48 pixels high.
- AAA-contrast colours, Atkinson Hyperlegible (the Braille Institute's typeface for low vision), a remembered text-size control (up to 150%), dark mode, reduced motion respected.
- Status always in words ("Suits you", "Not suitable", "Passed"), never colour alone. Tables have captions and header cells.
- "Read aloud" speaks the result for people who don't use a screen reader; "Speak instead" takes the sentence by voice where the browser supports it.
- Automated check: axe-core reports 0 WCAG 2.2 AA violations on every page, in light and dark mode, on desktop and phone widths.

## Try it

**Live app: https://hirebuddy-k543.onrender.com** (free tier, so the first load after idle can take about a minute)

- **Web app:** type a sentence on the home page, or pick an example.
- **My page (`/me`):** pick who you are, with no password. A job seeker hears their interviews first (when, how to join), can accept or say they can't make it, then sees jobs that suit them and why others don't. An employer sees their jobs and booked interviews.
- **From WorkBuddy:** see [WorkBuddy setup](#workbuddy-setup).
- **From a terminal:** `node workbuddy/hirebuddy-skill/scripts/hirebuddy.js "<your sentence>"`

The employer side still works too: `Need a weekend barista for MIXUE in Subang, RM12/hr, start next week` publishes the job, screens candidates with quoted evidence and books interviews; `Need 3 weekend baristas in Cyberjaya, must have latte art and Mandarin, RM13/hr` shows it widening the search and relaxing a requirement.

## Architecture

```
WorkBuddy ──(Skill / MCP)──┐
                           ▼
Web console ──REST/SSE──▶ Agent ──▶ Tools ──▶ store (jobs, students, applications, interviews, emails, runs)
                           │          │
                    LLM planner or    ├─ public job pages + apply form
                    rule autopilot    ├─ .ics calendar files
                                      ├─ email (Resend) / outbox
                                      └─ HTTP self-checks against its own public URLs
```

- **Agent** (`src/agent.js`): with `LLM_API_KEY` set, an OpenAI-compatible model (OpenAI, DeepSeek, Groq, Tencent Hunyuan…) plans and calls tools in a loop. It has a stuck-loop guard and a finish gate. Without a key, a rule-based **autopilot** drives the same tools, so the demo never depends on a network call to a model.
- **Tools** (`src/tools.js`): deterministic and auditable. Each returns either a result or a list of specific `problems`, and the agent fixes those and retries. The timeline shows each fix as "Caught a problem, fixing it".
- **Scoring** (`src/lib.js`): must-have skills 35, nice-to-have 5, shift-availability overlap 25, distance 15 (Haversine over Klang Valley areas), experience 15, pay fit 5.
- **MCP server** (`src/mcp.js`): Streamable HTTP at `/mcp`. By default it exposes only `hirebuddy_run` (the whole job from one prompt, returning only when it is verified) plus two read tools. That way a client's model can't stop halfway. Add `?tools=all` to the URL, or set `HIREBUDDY_MCP_TOOLS=all` for the bridge, to expose every step tool as well.
- **No dependencies.** Plain Node 20+, so it deploys anywhere in seconds.

## Run locally

```bash
node server.js          # http://localhost:3000
npm test                # boots a fresh server and runs the hirer, illegal-wage, student and tutor flows plus MCP
```

Environment variables (all optional):

| Var | Purpose |
|---|---|
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Any OpenAI-compatible chat API. Default base `https://api.openai.com/v1`, model `gpt-4o-mini` |
| `BREVO_API_KEY`, `DEMO_INBOX` | Send real email through Brevo's free plan. Real mail **only** goes to inboxes you control: demo candidates are delivered to `DEMO_INBOX` with a +tag (`you+aina@gmail.com`), and anything else stays in the outbox. `MAIL_ALLOW` adds more addresses. `MAIL_FROM` defaults to `DEMO_INBOX` |
| `RESEND_API_KEY` | Alternative provider (without your own domain it only reaches your signup email) |
| `PUBLIC_URL` | Public base URL (auto-detected on Render) |
| `RESET_TOKEN` | Protects `POST /api/reset?token=…` |
| `DATA_DIR` | Where `db.json` lives |

## Deploy (Render, free)

1. Fork or push this repo to GitHub.
2. On Render, choose **New → Blueprint** and select the repo. `render.yaml` sets everything up.
3. Optional: add `LLM_API_KEY` (and `LLM_BASE_URL` / `LLM_MODEL` for a non-OpenAI provider) in the service's Environment tab.

## WorkBuddy setup

WorkBuddy is Tencent's desktop AI agent. HireBuddy plugs into it in two ways:

**Quickest:** from the repo root run `node workbuddy/setup.js`. It checks the live app, then prints the MCP entry below with your machine's path filled in, ready to paste.

**A. MCP server (recommended).** Add HireBuddy to WorkBuddy's MCP servers (`mcp_servers.json` in WorkBuddy's config directory; see `workbuddy/mcp_servers.json`):

```json
{
  "mcpServers": {
    "hirebuddy": {
      "command": "node",
      "args": ["/path/to/hirebuddy/workbuddy/hirebuddy-mcp.js"],
      "env": { "HIREBUDDY_URL": "https://hirebuddy-k543.onrender.com" }
    }
  }
}
```

`hirebuddy-mcp.js` is a zero-dependency stdio-to-HTTP bridge. Clients that support remote MCP can point straight at `https://hirebuddy-k543.onrender.com/mcp`. Restart WorkBuddy, then type the one prompt. WorkBuddy calls `hirebuddy_run` and shows the verified result, the self-checks and the links.

**WorkBuddy runs the steps.** For a job seeker the Skill has WorkBuddy run the job itself: it searches job sites, then calls `hirebuddy_1_understand`, `hirebuddy_2_check_jobs`, `hirebuddy_3_apply_and_book` and `hirebuddy_4_verify` in turn. When there are fewer than 3 interviews, WorkBuddy chooses how to widen the search (HireBuddy refuses any option that gives up something the user asked for). At the end it saves the summary, calendar files and drafted applications on the user's computer. Every step result has a `next` field so the client never stops to ask. `hirebuddy_run` remains the one-call backup and the employer flow.

**Jobs on real sites.** For a job seeker, the Skill tells WorkBuddy to search JobStreet, Indeed, Hiredly or Maukerja on the user's own machine first and pass what it found as `listings` in the same single call. HireBuddy never fetches those sites itself. It checks each listing the same way as its own jobs (legal pay, the seeker's pay floor, tasks that need sight, screen reader support, hours, travel) and drafts an application with the questions the listing leaves open. It can't apply or book on those sites, so nothing is sent there; the self-check confirms that. With no listings, the flow is unchanged.

**B. Skill.** Import `workbuddy/hirebuddy-skill/` (which contains `SKILL.md`, `skill.yaml` and `scripts/hirebuddy.js`) through WorkBuddy's Skills panel. The skill tells WorkBuddy when to use HireBuddy, how to call it (MCP, or the script as a fallback), and what to report back.

Every run started from WorkBuddy also appears in the web app's **Recent runs**, labelled "via WorkBuddy/MCP".

## Demo data

The talent pool holds 12 fictional students. The 9 open gigs use made-up shop names, but their role, area, pay and shifts are **modelled on real Klang Valley part-time listings** read on 10 Oct 2026. That includes a weekend cashier at RM55/day, which is below the legal daily minimum, just like a real listing we found. See [docs/demo-data.md](docs/demo-data.md) for the table and sources. All seeded emails use `example.com` and are never delivered.

## License

MIT
