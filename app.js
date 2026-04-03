// ── STATE ──────────────────────────────────────────────────────────
const STORE = 'wealthwatch_v1';

let state = {
  accounts: [],   // { id, name, type, balance, note }
  snapshots: [],  // { date, bank, invest, crypto, total }
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) state = JSON.parse(raw);
  } catch(e) {}
}

function saveState() {
  localStorage.setItem(STORE, JSON.stringify(state));
}

// ── FORMATTING ─────────────────────────────────────────────────────
function fmt(n) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0
  }).format(n || 0);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── TOTALS ─────────────────────────────────────────────────────────
function totalByType(type) {
  return state.accounts.filter(a => a.type === type).reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
}
function grandTotal() {
  return totalByType('bank') + totalByType('invest') + totalByType('crypto');
}

// ── VIEW SWITCHING ──────────────────────────────────────────────────
function showView(name, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.mob-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // also sync mobile buttons
  document.querySelectorAll('[data-view="' + name + '"]').forEach(b => b.classList.add('active'));

  if (name === 'dashboard') renderDashboard();
  if (name === 'accounts') renderAccounts();
  if (name === 'history') renderHistory();
  if (name === 'update') renderUpdate();
}

// ── DASHBOARD ──────────────────────────────────────────────────────
let nwChart = null;
let allocChart = null;
let currentRange = 3;

function renderDashboard() {
  const now = new Date();
  document.getElementById('dash-date').textContent =
    now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const total = grandTotal();
  document.getElementById('nw-total').textContent = fmt(total);
  document.getElementById('total-bank').textContent = fmt(totalByType('bank'));
  document.getElementById('total-invest').textContent = fmt(totalByType('invest'));
  document.getElementById('total-crypto').textContent = fmt(totalByType('crypto'));

  // Delta vs last snapshot
  const deltaEl = document.getElementById('nw-delta');
  if (state.snapshots.length >= 2) {
    const prev = state.snapshots[state.snapshots.length - 2].total;
    const diff = total - prev;
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
  if (!months) return state.snapshots;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return state.snapshots.filter(s => new Date(s.date) >= cutoff);
}

function setRange(months, btn) {
  currentRange = months;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderNWChart();
}

function renderNWChart() {
  const snaps = getFilteredSnapshots(currentRange);
  const labels = snaps.map(s => fmtDate(s.date));
  const data = snaps.map(s => s.total);

  if (nwChart) nwChart.destroy();

  const ctx = document.getElementById('nwChart').getContext('2d');
  nwChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#e8e0d0',
        borderWidth: 2,
        pointBackgroundColor: '#e8e0d0',
        pointRadius: data.length <= 12 ? 4 : 2,
        pointHoverRadius: 6,
        fill: true,
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, 'rgba(232,224,208,0.15)');
          g.addColorStop(1, 'rgba(232,224,208,0)');
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
  const bank = totalByType('bank');
  const invest = totalByType('invest');
  const crypto = totalByType('crypto');
  const total = bank + invest + crypto || 1;

  if (allocChart) allocChart.destroy();
  const ctx = document.getElementById('allocChart').getContext('2d');
  allocChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Bank', 'Investments', 'Crypto'],
      datasets: [{
        data: [bank, invest, crypto],
        backgroundColor: ['#2563eb', '#16a34a', '#d97706'],
        borderColor: '#181818',
        borderWidth: 3,
        hoverBorderWidth: 3,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: '#222', bodyColor: '#e8e0d0',
        callbacks: { label: ctx => ' ' + fmt(ctx.parsed) + ' (' + ((ctx.parsed / total) * 100).toFixed(1) + '%)' }
      }}
    }
  });

  const legendEl = document.getElementById('alloc-legend');
  const cats = [
    { label: 'Bank', val: bank, color: '#2563eb' },
    { label: 'Investments', val: invest, color: '#16a34a' },
    { label: 'Crypto', val: crypto, color: '#d97706' },
  ];
  legendEl.innerHTML = cats.map(c => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${c.color}"></span>
      <span>${c.label}</span>
      <span class="legend-pct">${((c.val / total) * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}

// ── ACCOUNTS ───────────────────────────────────────────────────────
const ICONS = { bank: '🏦', invest: '📈', crypto: '₿' };

function renderAccounts() {
  ['bank', 'invest', 'crypto'].forEach(type => {
    const list = document.getElementById('list-' + type);
    const accounts = state.accounts.filter(a => a.type === type);
    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">No accounts yet — add one above</div>';
      return;
    }
    list.innerHTML = accounts.map(a => `
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

// ── HISTORY ────────────────────────────────────────────────────────
let stackedChart = null;

function renderHistory() {
  const tbody = document.getElementById('snapshot-tbody');
  if (!state.snapshots.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">No snapshots yet — use "Save snapshot" to record today\'s balances</td></tr>';
  } else {
    tbody.innerHTML = [...state.snapshots].reverse().map((s, i) => `
      <tr>
        <td>${fmtDate(s.date)}</td>
        <td>${fmt(s.bank)}</td>
        <td>${fmt(s.invest)}</td>
        <td>${fmt(s.crypto)}</td>
        <td class="td-total">${fmt(s.total)}</td>
        <td class="td-del" onclick="deleteSnapshot(${state.snapshots.length - 1 - i})">✕</td>
      </tr>
    `).join('');
  }

  renderStackedChart();
}

function renderStackedChart() {
  const snaps = state.snapshots;
  const labels = snaps.map(s => fmtDate(s.date));

  if (stackedChart) stackedChart.destroy();
  const ctx = document.getElementById('stackedChart').getContext('2d');
  stackedChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Bank', data: snaps.map(s => s.bank), backgroundColor: 'rgba(37,99,235,0.7)', stack: 'a' },
        { label: 'Investments', data: snaps.map(s => s.invest), backgroundColor: 'rgba(22,163,74,0.7)', stack: 'a' },
        { label: 'Crypto', data: snaps.map(s => s.crypto), backgroundColor: 'rgba(217,119,6,0.7)', stack: 'a' },
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

function deleteSnapshot(idx) {
  if (!confirm('Delete this snapshot?')) return;
  state.snapshots.splice(idx, 1);
  saveState();
  renderHistory();
  showToast('Snapshot deleted');
}

function exportCSV() {
  if (!state.snapshots.length) { showToast('No snapshots to export'); return; }
  const rows = [['Date', 'Bank', 'Investments', 'Crypto', 'Total']];
  state.snapshots.forEach(s => rows.push([s.date, s.bank, s.invest, s.crypto, s.total]));
  const csv = rows.map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv,' + encodeURIComponent(csv);
  a.download = 'wealthwatch-export.csv';
  a.click();
  showToast('CSV exported');
}

// ── UPDATE VIEW ─────────────────────────────────────────────────────
function renderUpdate() {
  const list = document.getElementById('update-list');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="empty-state">Add accounts first in the Accounts tab</div>';
    return;
  }
  list.innerHTML = state.accounts.map(a => `
    <div class="update-row">
      <div class="acc-icon" style="width:32px;height:32px;font-size:13px;background:var(--surface2);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICONS[a.type]}</div>
      <div class="update-name">${a.name}</div>
      <div class="update-input-wrap">
        <span class="update-currency">€</span>
        <input type="number" class="update-input" data-id="${a.id}" value="${a.balance}" step="0.01">
      </div>
    </div>
  `).join('');
}

function saveFromUpdate() {
  document.querySelectorAll('.update-input').forEach(inp => {
    const acc = state.accounts.find(a => a.id === inp.dataset.id);
    if (acc) acc.balance = parseFloat(inp.value) || 0;
  });
  saveState();
  takeSnapshot();
  showToast('Balances updated & snapshot saved');
}

// ── SNAPSHOT ───────────────────────────────────────────────────────
function takeSnapshot() {
  const snap = {
    date: new Date().toISOString().split('T')[0],
    bank: Math.round(totalByType('bank')),
    invest: Math.round(totalByType('invest')),
    crypto: Math.round(totalByType('crypto')),
    total: Math.round(grandTotal()),
  };
  // Replace if same day
  const today = snap.date;
  const idx = state.snapshots.findIndex(s => s.date === today);
  if (idx >= 0) state.snapshots[idx] = snap;
  else state.snapshots.push(snap);
  saveState();
  showToast('Snapshot saved for ' + fmtDate(today));
  renderDashboard();
}

// ── MODAL: ADD / EDIT ───────────────────────────────────────────────
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
  const acc = state.accounts.find(a => a.id === id);
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

function saveAccount() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { document.getElementById('f-name').focus(); return; }
  const type = document.getElementById('f-type').value;
  const balance = parseFloat(document.getElementById('f-balance').value) || 0;
  const note = document.getElementById('f-note').value.trim();

  if (editingId) {
    const acc = state.accounts.find(a => a.id === editingId);
    if (acc) Object.assign(acc, { name, type, balance, note });
  } else {
    state.accounts.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2), name, type, balance, note });
  }
  saveState();
  closeModal();
  renderAccounts();
  renderDashboard();
  showToast(editingId ? 'Account updated' : 'Account added');
}

function deleteAccount() {
  if (!confirm('Delete this account?')) return;
  state.accounts = state.accounts.filter(a => a.id !== editingId);
  saveState();
  closeModal();
  renderAccounts();
  renderDashboard();
  showToast('Account deleted');
}

// ── KEYBOARD / CLICK OUTSIDE ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && document.getElementById('modal-overlay').classList.contains('open')) saveAccount();
});

// ── TOAST ───────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── SEED DEMO DATA (first run) ──────────────────────────────────────
function seedDemo() {
  if (state.accounts.length) return;
  state.accounts = [
    { id: 'a1', name: 'Intesa Sanpaolo', type: 'bank', balance: 12400, note: '' },
    { id: 'a2', name: 'Revolut', type: 'bank', balance: 3200, note: '' },
    { id: 'a3', name: 'Fineco ETF Portfolio', type: 'invest', balance: 28500, note: '' },
    { id: 'a4', name: 'Bitcoin', type: 'crypto', balance: 4100, note: '0.052 BTC' },
  ];
  // Seed 6 months of snapshots
  const base = { bank: 15000, invest: 24000, crypto: 3200 };
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const jitter = () => Math.round((Math.random() - 0.3) * 1200);
    const bank = base.bank + jitter() + (5 - i) * 300;
    const invest = base.invest + jitter() + (5 - i) * 800;
    const crypto = base.crypto + jitter() + (5 - i) * 150;
    state.snapshots.push({
      date: d.toISOString().split('T')[0],
      bank: Math.round(bank), invest: Math.round(invest), crypto: Math.round(crypto),
      total: Math.round(bank + invest + crypto)
    });
  }
  saveState();
}

// ── INIT ────────────────────────────────────────────────────────────
loadState();
seedDemo();
showView('dashboard');
