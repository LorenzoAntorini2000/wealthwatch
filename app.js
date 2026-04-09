// ── SUPABASE INIT ───────────────────────────────────────────────────
const SUPABASE_URL = 'https://ylmynyndlqpnwulwewyt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ltjdILZ1g36cGEBcZgkZrg_KiuNbglJ';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// URL that Enable Banking redirects to after bank authorisation.
// In production: your GitHub Pages URL. In development: http://localhost:PORT
const BANK_REDIRECT_URL = 'https://lorenzoantorini2000.github.io/wealthwatch/';

// ── STATE ───────────────────────────────────────────────────────────
let currentUser = null;
let accounts = [];
let snapshots = [];
let bankConnections = [];

// ── FORMATTING ──────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0
  }).format(n || 0);
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── AUTH ────────────────────────────────────────────────────────────
let authMode = 'signin';

function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  document.getElementById('auth-btn').textContent = authMode === 'signin' ? 'Sign in' : 'Create account';
  document.getElementById('switch-btn').textContent = authMode === 'signin'
    ? 'No account yet? Sign up'
    : 'Already have an account? Sign in';
  document.getElementById('auth-error').style.display = 'none';
}

async function handleAuth() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  const loadEl = document.getElementById('auth-loading');

  if (!email || !password) {
    showAuthError('Please enter your email and password.');
    return;
  }

  errEl.style.display = 'none';
  loadEl.style.display = 'block';
  loadEl.textContent = authMode === 'signin' ? 'Signing in…' : 'Creating account…';
  document.getElementById('auth-btn').disabled = true;

  let result;
  if (authMode === 'signin') {
    result = await sb.auth.signInWithPassword({ email, password });
  } else {
    result = await sb.auth.signUp({ email, password });
  }

  loadEl.style.display = 'none';
  document.getElementById('auth-btn').disabled = false;

  if (result.error) {
    showAuthError(result.error.message);
    return;
  }

  if (authMode === 'signup' && !result.data.session) {
    showAuthError('Account created! Check your email to confirm, then sign in.', false);
    toggleAuthMode();
    return;
  }

  currentUser = result.data.user;
  await bootApp();
}

function showAuthError(msg, isError = true) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.color = isError ? '#f87171' : '#4ade80';
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
  accounts = [];
  snapshots = [];
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
}

// ── BOOT ────────────────────────────────────────────────────────────
async function bootApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('user-email-display').textContent = currentUser.email;

  await Promise.all([loadAccounts(), loadSnapshots()]);

  // Check if we're returning from a bank authorisation redirect
  const urlParams = new URLSearchParams(window.location.search);
  const authCode  = urlParams.get('code');
  const accountId = urlParams.get('state');  // account_id was passed as the state param

  if (authCode && accountId) {
    // Clean the URL so a refresh doesn't re-trigger
    window.history.replaceState({}, '', window.location.pathname);

    const sessionId = localStorage.getItem('eb_pending_session_id');
    const bankName  = localStorage.getItem('eb_pending_bank_name') || '';
    localStorage.removeItem('eb_pending_session_id');
    localStorage.removeItem('eb_pending_bank_name');

    if (sessionId) {
      await completeBankLink(authCode, sessionId, accountId, bankName);
    }
  }

  showView('dashboard');
}

// ── DATA LOADING ─────────────────────────────────────────────────────
async function loadAccounts() {
  const { data, error } = await sb.from('accounts').select('*').order('created_at');
  if (!error) accounts = data || [];
}

async function loadSnapshots() {
  const { data, error } = await sb.from('snapshots').select('*').order('date');
  if (!error) snapshots = data || [];
}

async function loadBankConnections() {
  const { data, error } = await sb.from('bank_connections').select('*').order('created_at');
  if (!error) bankConnections = data || [];
}

// ── TOTALS ──────────────────────────────────────────────────────────
function totalByType(type) {
  return accounts.filter(a => a.type === type).reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
}
function grandTotal() {
  return totalByType('bank') + totalByType('invest') + totalByType('crypto');
}

// ── VIEW SWITCHING ───────────────────────────────────────────────────
function showView(name, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item, .mob-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[data-view="' + name + '"]').forEach(b => b.classList.add('active'));
  if (name === 'dashboard') renderDashboard();
  if (name === 'accounts') renderAccounts();
  if (name === 'history') renderHistory();
  if (name === 'update') renderUpdate();
}

// ── DASHBOARD ────────────────────────────────────────────────────────
let nwChart = null;
let allocChart = null;
let currentRange = 3;
let currentNWCategory = '';
let currentNWBlockId = null;
let allocModeBlock = false;

function setChartFilter(category, btn) {
  currentNWCategory = category || '';
  currentNWBlockId = null;
  document.querySelectorAll('#chart-cat-filters .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderBlockFilters();
  renderNWChart();
}

function renderBlockFilters() {
  const container = document.getElementById('chart-block-filters');
  if (!currentNWCategory) {
    container.innerHTML = '';
    return;
  }
  const blocks = accounts.filter(a => a.type === currentNWCategory);
  if (!blocks.length) {
    container.innerHTML = '<span class="small-text">No blocks in this category.</span>';
    return;
  }
  container.innerHTML = `
    <button class="filter-btn ${currentNWBlockId ? '' : 'active'}" onclick="setNWBlockFilter(null, this)">All</button>
    ${blocks.map(b => `<button class="filter-btn ${currentNWBlockId === b.id ? 'active' : ''}" onclick="setNWBlockFilter('${b.id}', this)">${b.name}</button>`).join('')}
  `;
}

function setNWBlockFilter(blockId, btn) {
  currentNWBlockId = blockId || null;
  document.querySelectorAll('#chart-block-filters .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderNWChart();
}

function setAllocView(isBlock, btn) {
  allocModeBlock = isBlock;
  document.getElementById('alloc-cat-btn').classList.toggle('active', !isBlock);
  document.getElementById('alloc-block-btn').classList.toggle('active', isBlock);
  renderAllocChart();
}

function renderDashboard() {
  const now = new Date();
  document.getElementById('dash-date').textContent =
    now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  document.getElementById('nw-total').textContent = fmt(grandTotal());
  document.getElementById('total-bank').textContent = fmt(totalByType('bank'));
  document.getElementById('total-invest').textContent = fmt(totalByType('invest'));
  document.getElementById('total-crypto').textContent = fmt(totalByType('crypto'));

  renderBlockFilters();

  const deltaEl = document.getElementById('nw-delta');
  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2].total;
    const diff = grandTotal() - prev;
    const pct = prev ? ((diff / prev) * 100).toFixed(1) : 0;
    deltaEl.textContent = (diff >= 0 ? '▲ +' : '▼ ') + fmt(diff) + ' (' + pct + '%) vs last snapshot';
    deltaEl.className = 'nw-delta ' + (diff >= 0 ? 'pos' : 'neg');
  } else {
    deltaEl.textContent = 'No previous snapshot to compare';
    deltaEl.className = 'nw-delta';
  }

  renderNWChart();
  renderAllocChart();
}

function getFilteredSnapshots(months) {
  if (!months) return snapshots;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return snapshots.filter(s => new Date(s.date) >= cutoff);
}

function setRange(months, btn) {
  currentRange = months;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderNWChart();
}

function renderNWChart() {
  const snaps = getFilteredSnapshots(currentRange);
  const labels = snaps.map(s => fmtDate(s.date));

  let data;
  let chartLabel;
  let color;

  if (!currentNWCategory) {
    data = snaps.map(s => s.total);
    chartLabel = 'Total net worth';
    color = '#e8e0d0';
  } else if (!currentNWBlockId) {
    data = snaps.map(s => parseFloat(s[currentNWCategory]) || 0);
    chartLabel = `${currentNWCategory.charAt(0).toUpperCase() + currentNWCategory.slice(1)} Over Time`;
    color = currentNWCategory === 'bank' ? '#2563eb' : currentNWCategory === 'invest' ? '#16a34a' : '#d97706';
  } else {
    const block = accounts.find(a => a.id === currentNWBlockId);
    const balance = block ? parseFloat(block.balance) || 0 : 0;
    data = snaps.map(() => balance);
    chartLabel = block ? `${block.name} (current)` : 'Block';
    color = '#f59e0b';
  }

  document.getElementById('nw-chart-title').textContent = currentNWCategory
    ? (currentNWBlockId ? `Net worth: ${chartLabel}` : `Net worth: ${chartLabel}`)
    : 'Net worth over time';

  if (nwChart) nwChart.destroy();
  const ctx = document.getElementById('nwChart').getContext('2d');
  nwChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: chartLabel,
        data,
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color,
        pointRadius: data.length <= 12 ? 4 : 2,
        pointHoverRadius: 6,
        fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, color === '#e8e0d0' ? 'rgba(232,224,208,0.15)' : 'rgba(37,99,235,0.15)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          return g;
        },
        tension: 0.4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: '#222', titleColor: '#888', bodyColor: '#e8e0d0',
        callbacks: { label: ctx => ' ' + fmt(ctx.parsed.y) }
      }},
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 11 }, callback: v => fmt(v) } }
      }
    }
  });
}

function renderAllocChart() {
  let labels = [];
  let data = [];
  let colors = [];

  if (!allocModeBlock) {
    const bank = totalByType('bank');
    const invest = totalByType('invest');
    const crypto = totalByType('crypto');
    labels = ['Bank', 'Investments', 'Crypto'];
    data = [bank, invest, crypto];
    colors = ['#2563eb', '#16a34a', '#d97706'];
  } else {
    labels = accounts.map(a => a.name || 'Unnamed');
    data = accounts.map(a => parseFloat(a.balance) || 0);
    colors = accounts.map((_, idx) => [
      '#2563eb', '#16a34a', '#d97706', '#9333ea', '#14b8a6', '#f59e0b', '#db2777', '#0ea5e9'
    ][idx % 8]);
  }

  const total = data.reduce((sum, x) => sum + x, 0) || 1;

  if (allocChart) allocChart.destroy();
  const ctx = document.getElementById('allocChart').getContext('2d');
  allocChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: '#181818', borderWidth: 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '70%',
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: '#222', bodyColor: '#e8e0d0',
        callbacks: { label: ctx => ' ' + fmt(ctx.parsed) + ' (' + ((ctx.parsed / total) * 100).toFixed(1) + '%)' }
      }}
    }
  });

  const legendEl = document.getElementById('alloc-legend');
  legendEl.innerHTML = labels.map((label, i) => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${colors[i]}"></span>
      <span>${label}</span>
      <span class="legend-pct">${((data[i] / total) * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}

// ── ACCOUNTS ─────────────────────────────────────────────────────────
const ICONS = { bank: '🏦', invest: '📈', crypto: '₿' };

function renderAccounts() {
  ['bank', 'invest', 'crypto'].forEach(type => {
    const list = document.getElementById('list-' + type);
    const accs = accounts.filter(a => a.type === type);
    if (!accs.length) {
      list.innerHTML = '<div class="empty-state">No accounts yet</div>';
      return;
    }
    list.innerHTML = accs.map(a => `
      <div class="account-row" onclick="openEditModal('${a.id}')">
        <div class="acc-icon">${ICONS[a.type]}</div>
        <div class="acc-info">
          <div class="acc-name">${a.name}</div>
          ${a.note ? `<div class="acc-note">${a.note}</div>` : ''}
        </div>
        <div class="acc-balance">${fmt(a.balance)}</div>
      </div>
    `).join('');
  });
}

// ── HISTORY ──────────────────────────────────────────────────────────
let stackedChart = null;

function renderHistory() {
  const tbody = document.getElementById('snapshot-tbody');
  if (!snapshots.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">No snapshots yet — use "Save snapshot" to record today\'s balances</td></tr>';
  } else {
    tbody.innerHTML = [...snapshots].reverse().map((s) => `
      <tr>
        <td>${fmtDate(s.date)}</td>
        <td>${fmt(s.bank)}</td>
        <td>${fmt(s.invest)}</td>
        <td>${fmt(s.crypto)}</td>
        <td class="td-total">${fmt(s.total)}</td>
        <td class="td-del" onclick="deleteSnapshot('${s.id}')">✕</td>
      </tr>
    `).join('');
  }
  renderStackedChart();
}

function renderStackedChart() {
  const labels = snapshots.map(s => fmtDate(s.date));
  if (stackedChart) stackedChart.destroy();
  const ctx = document.getElementById('stackedChart').getContext('2d');
  stackedChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Bank', data: snapshots.map(s => s.bank), backgroundColor: 'rgba(37,99,235,0.7)', stack: 'a' },
        { label: 'Investments', data: snapshots.map(s => s.invest), backgroundColor: 'rgba(22,163,74,0.7)', stack: 'a' },
        { label: 'Crypto', data: snapshots.map(s => s.crypto), backgroundColor: 'rgba(217,119,6,0.7)', stack: 'a' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#888', font: { family: 'DM Mono', size: 11 }, boxWidth: 10, padding: 16 } },
        tooltip: { backgroundColor: '#222', titleColor: '#888', bodyColor: '#e8e0d0',
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } }
      },
      scales: {
        x: { stacked: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 11 } } },
        y: { stacked: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555', font: { family: 'DM Mono', size: 11 }, callback: v => fmt(v) } }
      }
    }
  });
}

async function deleteSnapshot(id) {
  if (!confirm('Delete this snapshot?')) return;
  const { error } = await sb.from('snapshots').delete().eq('id', id);
  if (error) { showToast('Error deleting snapshot'); return; }
  snapshots = snapshots.filter(s => s.id !== id);
  renderHistory();
  showToast('Snapshot deleted');
}

function exportCSV() {
  if (!snapshots.length) { showToast('No snapshots to export'); return; }
  const rows = [['Date', 'Bank', 'Investments', 'Crypto', 'Total']];
  snapshots.forEach(s => rows.push([s.date, s.bank, s.invest, s.crypto, s.total]));
  const csv = rows.map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv,' + encodeURIComponent(csv);
  a.download = 'wealthwatch-export.csv';
  a.click();
  showToast('CSV exported');
}

// ── UPDATE VIEW ──────────────────────────────────────────────────────
function renderUpdate() {
  const list = document.getElementById('update-list');
  if (!accounts.length) {
    list.innerHTML = '<div class="empty-state">Add accounts first in the Accounts tab</div>';
    document.getElementById('crypto-refresh-section').style.display = 'none';
    return;
  }
  list.innerHTML = accounts.map(a => `
    <div class="update-row">
      <div style="width:32px;height:32px;font-size:13px;background:var(--surface2);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICONS[a.type]}</div>
      <div class="update-name">${a.name}</div>
      <div class="update-input-wrap">
        <span class="update-currency">€</span>
        <input type="number" class="update-input" data-id="${a.id}" value="${a.balance}" step="0.01">
      </div>
    </div>
  `).join('');
  document.getElementById('crypto-refresh-section').style.display =
    accounts.some(a => a.type === 'crypto') ? '' : 'none';
}

async function fetchCryptoTotal() {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(SUPABASE_URL + '/functions/v1/crypto-balance', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + session.access_token,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Edge Function error ${res.status}: ${body.error || 'unknown'}`);
  }
  return (await res.json()).total_eur;
}

async function refreshCryptoAccount() {
  const cryptoAcc = accounts.find(a => a.type === 'crypto');
  if (!cryptoAcc) { showToast('No crypto account found'); return; }

  const btn = document.getElementById('refresh-crypto-btn');
  btn.disabled = true;
  btn.textContent = '⟳ Refreshing…';

  try {
    const totalEur = await fetchCryptoTotal();
    const { error } = await sb.from('accounts').update({ balance: totalEur }).eq('id', cryptoAcc.id);
    if (error) throw new Error('DB update failed');
    cryptoAcc.balance = totalEur;
    renderUpdate();
    renderDashboard();
    showToast('Crypto balance updated: ' + fmt(totalEur));
  } catch (err) {
    console.error('refreshCryptoAccount:', err);
    showToast('Failed to refresh crypto balance');
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Refresh from Crypto.com';
  }
}

// ── BANK LINKING ─────────────────────────────────────────────────────
async function startBankLink(accountId, bankName) {
  const { data: { session } } = await sb.auth.getSession();
  console.log('[bank-connect] session:', session ? 'ok' : 'NULL', '| token prefix:', session?.access_token?.slice(0, 20));
  const url = SUPABASE_URL + '/functions/v1/bank-connect';
  console.log('[bank-connect] POST', url, { action: 'start', account_id: accountId, bank_name: bankName });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + session?.access_token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'start', account_id: accountId, bank_name: bankName })
  });
  console.log('[bank-connect] response status:', res.status, res.statusText);
  const resBody = await res.clone().text();
  console.log('[bank-connect] response body:', resBody);
  if (!res.ok) { showToast('Failed to start bank link'); return; }
  const { auth_url, session_id } = await res.json();

  // Persist session_id and bank_name so completeBankLink can use them after the redirect
  localStorage.setItem('eb_pending_session_id', session_id);
  localStorage.setItem('eb_pending_bank_name', bankName);

  // Redirect the current tab (not a popup) so it works on mobile too
  window.location.href = auth_url;
}

async function completeBankLink(code, sessionId, accountId, bankName) {
  showToast('Completing bank link…');
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(SUPABASE_URL + '/functions/v1/bank-connect', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + session.access_token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'finish', code, session_id: sessionId, account_id: accountId, bank_name: bankName })
  });
  if (!res.ok) { showToast('Bank link failed'); return; }
  const { linked_accounts } = await res.json();
  showToast('Bank linked! ' + linked_accounts + ' account(s) connected.');
  await loadBankConnections();
  renderAccounts();
  renderDashboard();
}

async function saveFromUpdate() {
  const inputs = document.querySelectorAll('.update-input');
  const updates = [];
  inputs.forEach(inp => {
    const acc = accounts.find(a => a.id === inp.dataset.id);
    if (acc) {
      acc.balance = parseFloat(inp.value) || 0;
      updates.push(sb.from('accounts').update({ balance: acc.balance }).eq('id', acc.id));
    }
  });
  await Promise.all(updates);
  await takeSnapshot();
  showToast('Balances updated & snapshot saved');
}

// ── SNAPSHOT ─────────────────────────────────────────────────────────
async function takeSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  const snap = {
    user_id: currentUser.id,
    date: today,
    bank: Math.round(totalByType('bank')),
    invest: Math.round(totalByType('invest')),
    crypto: Math.round(totalByType('crypto')),
    total: Math.round(grandTotal()),
  };

  // Upsert: replace if same day already exists
  const { data, error } = await sb.from('snapshots')
    .upsert(snap, { onConflict: 'user_id,date' })
    .select()
    .single();

  if (error) { showToast('Error saving snapshot'); return; }

  const idx = snapshots.findIndex(s => s.date === today);
  if (idx >= 0) snapshots[idx] = data;
  else snapshots.push(data);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  showToast('Snapshot saved for ' + fmtDate(today));
  renderDashboard();
}

// ── MODAL ─────────────────────────────────────────────────────────────
let editingId = null;

function openAddModal() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Add account';
  document.getElementById('f-name').value = '';
  document.getElementById('f-type').value = 'bank';
  document.getElementById('f-balance').value = '';
  document.getElementById('f-note').value = '';
  document.getElementById('modal-delete-btn').style.display = 'none';
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-name').focus(), 50);
}

function openEditModal(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  editingId = id;
  document.getElementById('modal-title').textContent = 'Edit account';
  document.getElementById('f-name').value = acc.name;
  document.getElementById('f-type').value = acc.type;
  document.getElementById('f-balance').value = acc.balance;
  document.getElementById('f-note').value = acc.note || '';
  document.getElementById('modal-delete-btn').style.display = 'block';
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

async function saveAccount() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { document.getElementById('f-name').focus(); return; }
  const type = document.getElementById('f-type').value;
  const balance = parseFloat(document.getElementById('f-balance').value) || 0;
  const note = document.getElementById('f-note').value.trim();

  if (editingId) {
    const { error } = await sb.from('accounts').update({ name, type, balance, note }).eq('id', editingId);
    if (error) { showToast('Error updating account'); return; }
    const acc = accounts.find(a => a.id === editingId);
    if (acc) Object.assign(acc, { name, type, balance, note });
    showToast('Account updated');
  } else {
    const { data, error } = await sb.from('accounts')
      .insert({ user_id: currentUser.id, name, type, balance, note })
      .select().single();
    if (error) { showToast('Error adding account'); return; }
    accounts.push(data);
    showToast('Account added');
  }

  closeModal();
  renderAccounts();
  renderDashboard();
}

async function deleteAccount() {
  if (!confirm('Delete this account?')) return;
  const { error } = await sb.from('accounts').delete().eq('id', editingId);
  if (error) { showToast('Error deleting account'); return; }
  accounts = accounts.filter(a => a.id !== editingId);
  closeModal();
  renderAccounts();
  renderDashboard();
  showToast('Account deleted');
}

// ── KEYBOARD ──────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && document.getElementById('modal-overlay').classList.contains('open')) saveAccount();
  if (e.key === 'Enter' && document.getElementById('auth-screen').style.display !== 'none') handleAuth();
});

// ── TOAST ─────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── INIT ──────────────────────────────────────────────────────────────
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    currentUser = session.user;
    await bootApp();
  }
  // else: auth screen is already visible by default
})();
