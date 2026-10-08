import { useEffect, useState } from 'react';
import { TestKit } from 'local-session-replay/react';

const companies = [
  ['Meridian Health', 'Healthcare', '$12.4B'], ['Northwind Labs', 'Technology', '$3.1B'],
  ['Solace Energy', 'Energy', '$8.7B'], ['Cobalt Therapeutics', 'Healthcare', '$1.9B'],
  ['Arcwise', 'Technology', '$22.0B'], ['Helio Grid', 'Energy', '$4.4B'],
];

const tasks = [
  { id: 'filter', prompt: 'Filter the list to healthcare companies', successHint: 'Sector filter set to Healthcare', timeLimit: 90 },
  { id: 'detail', prompt: 'Open the company profile for Meridian Health', successHint: 'Company page for Meridian Health is open' },
  { id: 'export', prompt: 'Go back to the list and export the current view', followUp: 'Was anything about exporting unclear?' },
];

// A one-page app with client-side routing (pushState), which TestKit records as navigation.
const companyFromUrl = () => new URLSearchParams(location.search).get('company');

function navigate(company) {
  const params = new URLSearchParams(location.search);
  if (company) params.set('company', company);
  else params.delete('company');
  history.pushState(null, '', `?${params}`);
}

export default function App() {
  const [company, setCompany] = useState(companyFromUrl);
  useEffect(() => {
    const onPop = () => setCompany(companyFromUrl());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const open = (name) => { navigate(name); setCompany(name); };

  return (
    <>
      {/* Mount first: its effect reads ?test=1 before later siblings' useEffects
          run. Layout-effect, render-time, and loader redirects run earlier; keep the
          `test` param in those. */}
      <TestKit study="grid-filters-react" tasks={tasks} />
      <header>
        <strong>Prototype</strong>
        <a href="?" onClick={(e) => { e.preventDefault(); open(null); }}>Companies</a>
      </header>
      <main>{company ? <Company name={company} onBack={() => open(null)} /> : <Companies onOpen={open} />}</main>
    </>
  );
}

function Companies({ onOpen }) {
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState('');
  const [applied, setApplied] = useState({ query: '', sector: '' });
  const [toast, setToast] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  const rows = companies.filter(([n, s]) => (!applied.sector || s === applied.sector) && n.toLowerCase().includes(applied.query.toLowerCase()));

  return (
    <>
      <h1>Companies</h1>
      <div className="toolbar">
        <label>Search <input name="search" type="search" placeholder="Company name" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <label>Sector
          <select name="sector" value={sector} onChange={(e) => setSector(e.target.value)}>
            <option value="">All sectors</option>
            <option>Healthcare</option><option>Technology</option><option>Energy</option>
          </select>
        </label>
        <button type="button" onClick={() => setApplied({ query, sector })}>Apply</button>
        <button type="button" className="secondary" onClick={() => setToast(true)}>Export view</button>
      </div>
      <table>
        <thead><tr><th>Company</th><th>Sector</th><th>Market cap</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={3}>No companies match.</td></tr>}
          {rows.map(([n, s, cap]) => (
            <tr key={n}>
              <td><a href={`?company=${encodeURIComponent(n)}`} onClick={(e) => { e.preventDefault(); onOpen(n); }}>{n}</a></td>
              <td>{s}</td>
              <td>{cap}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {toast && <div className="toast" role="status">Export started — check your downloads</div>}
    </>
  );
}

function Company({ name, onBack }) {
  const row = companies.find(([n]) => n === name);
  return (
    <>
      <p><button type="button" className="secondary" onClick={onBack}>← Back to companies</button></p>
      <div className="card">
        <h1>{name}</h1>
        {row ? <p>{row[1]} · Market cap {row[2]}</p> : <p>Company not found.</p>}
      </div>
    </>
  );
}
