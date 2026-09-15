export const homePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Home Assistant · Operations</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --surface: #0d1b2d;
      --border: #213955;
      --text: #ecf4ff;
      --muted: #a1b5cd;
      --accent: #4bd7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 10% 0%, #4bd7ff17, transparent 32rem), var(--bg);
      color: var(--text);
      font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1160px; margin: 0 auto; padding: 72px 28px; }
    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 12px 0; font-size: clamp(32px, 5vw, 52px); line-height: 1.12; letter-spacing: -.035em; }
    .intro { margin: 0; max-width: 640px; color: var(--muted); }
    nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 40px; }
    .card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface);
      color: var(--text);
      text-decoration: none;
    }
    .card:hover { border-color: var(--accent); background: #12243a; }
    .card:focus-visible { outline: 3px solid var(--accent); outline-offset: 5px; }
    .icon { width: 44px; height: 44px; padding: 10px; border-radius: 12px; background: #4bd7ff12; color: var(--accent); }
    h2 { margin: 22px 0 8px; font-size: 22px; line-height: 1.3; }
    .card p { margin: 0 0 28px; color: var(--muted); font-size: 14px; }
    .open { margin-top: auto; color: var(--accent); font-size: 14px; font-weight: 700; }
    @media (max-width: 800px) {
      main { padding: 40px 20px; }
      nav { grid-template-columns: 1fr; gap: 16px; margin-top: 28px; }
      .card { padding: 24px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Home Assistant · Operations</div>
      <h1>Your assistant, at a glance.</h1>
      <p class="intro">Evaluate agent behavior, explore telemetry, and track performance. Choose a workspace to get started.</p>
    </header>
    <nav aria-label="Operations tools">
      <a class="card" href="/dashboards/evals" aria-labelledby="evals-title">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/></svg>
        <h2 id="evals-title">Evals dashboard</h2>
        <p>Run offline simulations, grade recorded sessions, and review regression alerts with supporting evidence.</p>
        <span class="open">Open evals <span aria-hidden="true">→</span></span>
      </a>
      <a class="card" href="/telemetry" aria-labelledby="telemetry-title">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
        <h2 id="telemetry-title">Telemetry</h2>
        <p>Explore agent sessions, inspect execution traces and tool calls, and investigate errors step by step.</p>
        <span class="open">Explore traces <span aria-hidden="true">→</span></span>
      </a>
      <a class="card" href="/dashboards" aria-labelledby="performance-title">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v17h17M9 16v-5m5 5V6m5 10v-8"/></svg>
        <h2 id="performance-title">Performance &amp; reliability</h2>
        <p>Compare models, monitor latency and success rates, and understand tool usage across your agents.</p>
        <span class="open">View dashboards <span aria-hidden="true">→</span></span>
      </a>
    </nav>
  </main>
</body>
</html>`;
