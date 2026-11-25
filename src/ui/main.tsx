import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionView } from '../shared/protocol.js';
import { useOffice } from './useOffice.js';
import './style.css';

const colors = ['#b9664b', '#568ca3', '#8a76aa', '#c2933c', '#588062', '#ab637e'];
function color(id: string) { return colors[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]; }
function activity(session: SessionView) {
  if (session.status !== 'working') return session.activity;
  const tool = session.tools.at(-1)?.tool ?? '';
  if (/read|grep|glob|search|fetch|snippet|symbol/.test(tool)) return 'Reading';
  if (/patch|write|edit|replace|insert/.test(tool)) return 'Editing';
  if (/shell|exec|run/.test(tool)) return 'Running commands';
  return tool ? `Using ${tool}` : 'Generating';
}

function Sprite({ session }: { session: SessionView }) {
  return <svg className={`sprite ${session.status}`} viewBox="0 0 64 64" shapeRendering="crispEdges" aria-hidden="true">
    <ellipse cx="32" cy="58" rx="22" ry="4" fill="#57493b" opacity=".2"/>
    <path d="M12 28h40v7H12zM15 35h4v20h-4zM45 35h4v20h-4z" fill="#725136"/>
    <path d="M10 25h44v7H10z" fill="#d7b382"/>
    <path d="M32 12h18v14H32z" fill="#334b44"/><path d="M34 14h14v9H34z" fill={session.status === 'working' ? '#9ed4b5' : '#698a7c'}/>
    <path d="M38 26h6v2h-6zM12 20h6v6h-6z" fill="#faf4d9"/>
    <g className="person"><path d="M21 37h18v15H21zM24 51h5v7h-5zM33 51h5v7h-5z" fill="#344d48"/>
      <path d="M19 32h22v14H19z" fill={color(session.id)}/><path d="M23 20h14v14H23z" fill="#e5b28b"/>
      <path d="M22 19h16v7H22zM20 23h5v9h-5z" fill="#4d3934"/><path d="M28 28h2v2h-2zM35 28h2v2h-2z" fill="#332d29"/>
      <path className="hands" d="M18 32h4v6h-4zM39 31h4v6h-4z" fill="#e5b28b"/>
    </g>
  </svg>;
}

function App() {
  const { snapshot, connection, error } = useOffice();
  const [selectedID, select] = useState<string>();
  const [search, setSearch] = useState('');
  const [project, setProject] = useState('');
  const [page, setPage] = useState(0);
  const sessions = snapshot?.sessions ?? [];
  const selected = sessions.find(s => s.id === selectedID);
  const projects = [...new Map(sessions.map(s => [s.projectID, s.projectName])).entries()];
  const filtered = sessions.filter(s => (!project || s.projectID === project) && `${s.title} ${s.agent} ${s.projectName}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 40));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * 40, current * 40 + 40);
  const working = sessions.filter(s => s.status === 'working').length;
  const waiting = sessions.filter(s => s.status === 'waiting').length;
  return <>
    <header><div className="brand"><span className="brand-icon" aria-hidden="true">▦</span><div><h1>Pixel Office</h1><p>Your OpenCode agents, under one roof.</p></div></div><div className={`connection ${connection}`} role="status"><i/>{connection === 'live' ? 'Office connected' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'offline' ? 'Office offline' : 'Connecting…'}</div></header>
    <main>
      {error && <div className="notice" role="alert">{error}</div>}
      {connection === 'reconnecting' && <div className="notice">Showing the last received state. Waiting for the collector to reconnect.</div>}
      <div className="toolbar"><div className="counts"><strong>{sessions.length}</strong> agents in the office <span><b>{working}</b> working</span><span><b>{waiting}</b> need input</span></div><div className="filters"><label>Find an agent<input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Session, agent or project"/></label><label>Project<select value={project} onChange={e => { setProject(e.target.value); setPage(0); }}><option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div></div>
      <div className="workspace"><section className="office-panel" aria-label="Shared office">
        <div className="room-wall"><div className="window"><i/><i/><i/><i/></div><div className="room-sign">OPEN CODE<br/><small>pixel office</small></div><div className="shelf"><i/><i/><i/><i/><i/></div></div>
        <div className="room-floor"><div className="plant plant-left" aria-hidden="true"><i/></div><div className="plant plant-right" aria-hidden="true"><i/></div>
          {!visible.length ? <div className="empty"><div className="empty-desk" aria-hidden="true">▰</div><h2>{sessions.length ? 'No agents match' : 'The office is ready'}</h2><p>{sessions.length ? 'Try another name or project.' : 'Active OpenCode sessions appear here when the observer connects. Keep working in OpenCode.'}</p>{!snapshot?.connectedSources && <p className="small">No observer connected yet. See the setup steps in README.md.</p>}</div> : <div className="desks">{visible.map(session => <button key={session.id} className={`desk ${selectedID === session.id ? 'selected' : ''}`} onClick={() => select(session.id)} aria-pressed={selectedID === session.id} aria-label={`${session.agent}: ${session.title}, ${session.status}`}><span className={`bubble ${session.status}`}>{session.status === 'waiting' ? '! ' : ''}{activity(session)}</span><Sprite session={session}/><span className="desk-name">{session.agent}{session.parentID ? ' ↳' : ''}</span><span className="desk-project">{session.projectName}</span></button>)}</div>}
        </div>
        <div className="room-footer"><span>{filtered.length ? `${current * 40 + 1}–${Math.min((current + 1) * 40, filtered.length)} of ${filtered.length} agents` : 'No agents displayed'}</span><div><button disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><button disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button></div></div>
      </section><aside aria-label="Agent information">{selected ? <section className="details"><div className="panel-title"><h2>At this desk</h2><button onClick={() => select(undefined)} aria-label="Close agent details">×</button></div><div className="identity"><Sprite session={selected}/><div><strong>{selected.agent}</strong><span className={`status ${selected.status}`}>{selected.status}</span></div></div><h3>{selected.title}</h3><dl><dt>Project</dt><dd>{selected.projectName}</dd><dt>Now</dt><dd>{activity(selected)}</dd><dt>Tools</dt><dd>{selected.tools.map(t => t.tool).join(', ') || 'None running'}</dd><dt>Session</dt><dd className="identifier">{selected.id}</dd>{selected.parentID && <><dt>Parent session</dt><dd className="identifier">{selected.parentID}</dd></>}<dt>Directory</dt><dd>{selected.directory}</dd></dl><h3 className="recent-title">Recent actions</h3><ol className="history">{selected.history.slice(-12).reverse().map((entry, i) => <li key={`${entry.at}-${i}`}><span>{entry.label}</span><time>{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>)}</ol></section> : <section className="roster"><h2>Who's here</h2><p className="hint">Choose a desk to see what an agent is doing.</p>{filtered.length ? <ul>{filtered.map(s => <li key={s.id}><button onClick={() => select(s.id)}><span className={`status-dot ${s.status}`}/><span><strong>{s.title}</strong><small>{s.agent} · {s.projectName}</small></span><span className="roster-status">{s.status}</span></button></li>)}</ul> : <p className="hint">Your live roster will appear here.</p>}</section>}</aside></div>
      {snapshot?.capacityReached && <p className="notice">Office capacity reached (500 retained sessions). Restart the collector to clear older records.</p>}
      <footer><span>Original pixels. Local data. Real agents.</span><span>{snapshot?.connectedSources ?? 0} observer{snapshot?.connectedSources === 1 ? '' : 's'} connected</span></footer>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<App/>);
