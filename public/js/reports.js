/* global Chart */

let messagesChart = null;
let responseChart = null;

document.addEventListener('DOMContentLoaded', () => {
    applyStoredTheme();
    setupDateFilters();
    document.getElementById('refreshReports').addEventListener('click', loadReports);
    loadReports();
});

function applyStoredTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);

    const accent = localStorage.getItem('uiAccent');
    if (accent) {
        const root = document.documentElement;
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent-hover', adjustColor(accent, -20));
        root.style.setProperty('--accent-light', adjustColor(accent, 50));
    }
}

function adjustColor(hex, amount) {
    const value = hex.replace('#', '');
    if (value.length !== 6) return hex;
    const num = parseInt(value, 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

function setupDateFilters() {
    const endInput = document.getElementById('endDate');
    const startInput = document.getElementById('startDate');
    const now = new Date();
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);

    endInput.valueAsDate = endDate;
    startInput.valueAsDate = startDate;
}

function getRangeParams() {
    const startInput = document.getElementById('startDate').value;
    const endInput = document.getElementById('endDate').value;
    const interval = document.getElementById('intervalSelect').value;

    const startDate = new Date(startInput);
    const endDate = new Date(endInput);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return null;
    }

    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59, 999).getTime();

    return { start, end, interval };
}

async function loadReports() {
    const range = getRangeParams();
    if (!range) return;

    const query = `start=${range.start}&end=${range.end}&interval=${range.interval}`;

    const [overview, trends, response] = await Promise.all([
        fetchJson(`/api/reports/overview?${query}`),
        fetchJson(`/api/reports/trends?${query}`),
        fetchJson(`/api/reports/response-time?${query}`)
    ]);

    if (overview) {
        renderOverview(overview);
        renderTopChats(overview.topChats || []);
    }
    if (trends) {
        renderMessageTrend(trends.points || [], trends.interval, trends.range);
    }
    if (response) {
        renderResponseSummary(response.summary || {});
        renderResponseTrend(response.trend || [], response.interval, response.range);
        renderResponseTable(response.byChat || []);
    }
}

async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
        console.error('Report fetch failed', url);
        return null;
    }
    return response.json();
}

function renderOverview(data) {
    const overview = data.overview || {};
    document.getElementById('overviewTotal').textContent = formatNumber(overview.total || 0);
    document.getElementById('overviewSent').textContent = formatNumber(overview.sent || 0);
    document.getElementById('overviewReceived').textContent = formatNumber(overview.received || 0);
    document.getElementById('overviewActive').textContent = formatNumber(overview.active_chats || 0);
}

function renderTopChats(rows) {
    const container = document.getElementById('topChatsTable');
    if (!rows.length) {
        container.innerHTML = '<p class="empty-state">Veri bulunamadi.</p>';
        return;
    }

    const header = `
        <div class="table-row header">
            <span>Sohbet</span>
            <span>Toplam</span>
            <span>Gonderilen</span>
            <span>Alinan</span>
        </div>
    `;

    const body = rows.map(row => `
        <div class="table-row">
            <span>${escapeHtml(row.name)}</span>
            <span>${formatNumber(row.message_count || 0)}</span>
            <span>${formatNumber(row.sent || 0)}</span>
            <span>${formatNumber(row.received || 0)}</span>
        </div>
    `).join('');

    container.innerHTML = header + body;
}

function renderMessageTrend(points, interval, range) {
    const labels = points.map(point => interval === 'weekly' ? point.week_start : point.bucket);
    const sentData = points.map(point => point.sent || 0);
    const receivedData = points.map(point => point.received || 0);

    if (messagesChart) {
        messagesChart.destroy();
    }

    const ctx = document.getElementById('messagesChart');
    messagesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Gonderilen',
                    data: sentData,
                    borderColor: '#00a884',
                    backgroundColor: 'rgba(0, 168, 132, 0.15)',
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Alinan',
                    data: receivedData,
                    borderColor: '#4c9aff',
                    backgroundColor: 'rgba(76, 154, 255, 0.15)',
                    tension: 0.3,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });

    document.getElementById('trendRange').textContent = formatRange(range);
}

function renderResponseSummary(summary) {
    const responses = summary.responses || 0;
    const avg = summary.avg_ms ? formatDuration(summary.avg_ms) : '—';
    const min = summary.min_ms ? formatDuration(summary.min_ms) : '—';
    const max = summary.max_ms ? formatDuration(summary.max_ms) : '—';

    document.getElementById('responseSummary').textContent = `${responses} yanit • Ort: ${avg} • Min: ${min} • Max: ${max}`;
}

function renderResponseTrend(points, interval, range) {
    const labels = points.map(point => interval === 'weekly' ? point.week_start : point.bucket);
    const data = points.map(point => point.avg_ms ? Math.round(point.avg_ms / 1000) : 0);

    if (responseChart) {
        responseChart.destroy();
    }

    const ctx = document.getElementById('responseChart');
    responseChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Ortalama yanit (sn)',
                    data,
                    backgroundColor: 'rgba(241, 158, 38, 0.6)',
                    borderColor: '#f19e26'
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });

    document.getElementById('responseRange').textContent = formatRange(range);
}

function renderResponseTable(rows) {
    const container = document.getElementById('responseTable');
    if (!rows.length) {
        container.innerHTML = '<p class="empty-state">Yanit suresi verisi bulunamadi.</p>';
        return;
    }

    const header = `
        <div class="table-row header">
            <span>Sohbet</span>
            <span>Yanit</span>
            <span>Ortalama</span>
            <span></span>
        </div>
    `;

    const body = rows.map(row => `
        <div class="table-row">
            <span>${escapeHtml(row.name)}</span>
            <span>${formatNumber(row.responses || 0)}</span>
            <span>${formatDuration(row.avg_ms || 0)}</span>
            <span></span>
        </div>
    `).join('');

    container.innerHTML = header + body;
}

function formatNumber(value) {
    return new Intl.NumberFormat('tr-TR').format(value);
}

function formatDuration(ms) {
    if (!ms) return '0 sn';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} sn`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    if (minutes < 60) return `${minutes} dk ${remaining} sn`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours} sa ${mins} dk`;
}

function formatRange(range) {
    if (!range) return '';
    const start = new Date(range.start);
    const end = new Date(range.end);
    return `${start.toLocaleDateString('tr-TR')} - ${end.toLocaleDateString('tr-TR')}`;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
