/* Buu Nails: interface pública, painel da Bruna e controles do PWA. */
const $ = (selector) => document.querySelector(selector);
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((value || 0) / 100);
const APP_VERSION = '1.0.7';
let config = {}, items = [], agendaBlocks = [], deferredPrompt = null, waitingWorker = null, releaseInfo = null, reloadAfterUpdate = false;

function escapeHTML(value) { return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({ detail: 'Não foi possível concluir esta ação.' })); throw new Error(body.detail || 'Não foi possível concluir esta ação.'); }
  return response.status === 204 ? null : response.json();
}
function message(id, text, success = false) { const target = $(id); if (target) { target.className = success ? 'success' : 'error'; target.textContent = text; } }
function openDialog(id) { const dialog = $(id); if (!dialog) return; if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((dialog) => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }); }
document.querySelectorAll('.close').forEach((button) => { button.onclick = closeDialogs; });
function removeDurationControls() {
  ['#booking-duration', '#default-duration', '#manual-duration'].forEach((selector) => {
    const control = $(selector); if (control) control.closest('label')?.remove();
  });
}
removeDurationControls();

async function loadConfig() {
  config = await api('/api/public/config');
  $('#booking-price').textContent = 'Valor atual do atendimento: ' + money(config.price_cents);
}
async function busy() {
  const date = $('#busy-date').value, list = $('#busy-list');
  if (!date || !list) return;
  try {
    const appointments = await api('/api/public/busy?from_date=' + encodeURIComponent(date) + '&to_date=' + encodeURIComponent(date));
    list.innerHTML = appointments.length ? appointments.map((appointment) => '<span class="busy-pill">' + new Date(appointment.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</span>').join('') : '<span class="available">Todos os horários estão livres nesta data ✦</span>';
  } catch (error) { list.textContent = error.message; }
}
$('#busy-date').onchange = busy;
$('#open-booking').onclick = () => { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); $('#booking-date').value = tomorrow.toISOString().slice(0, 10); $('#booking-time').value = '09:00'; message('booking-result', ''); openDialog('#booking-dialog'); };
$('#open-proof').onclick = () => { message('proof-result', ''); openDialog('#proof-dialog'); };

$('#booking-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const reservation = await api('/api/public/reservations', { method: 'POST', body: JSON.stringify({ name: $('#booking-name').value, phone: $('#booking-phone').value, service: $('#booking-service').value, starts_at: $('#booking-date').value + 'T' + $('#booking-time').value + ':00', duration: 60 }) });
    closeDialogs();
    window.alert('Reserva confirmada!\n\nCódigo: ' + reservation.code + '\nValor: ' + money(reservation.price_cents) + '\n\nGuarde este código para enviar seu comprovante depois.');
    $('#proof-code').value = reservation.code;
    busy();
  } catch (error) { message('booking-result', error.message); }
};
$('#proof-form').onsubmit = async (event) => {
  event.preventDefault();
  const file = $('#proof-file').files[0];
  if (!file) return message('proof-result', 'Escolha a imagem do comprovante.');
  const form = new FormData();
  form.append('code', $('#proof-code').value); form.append('name', $('#proof-name').value); form.append('phone', $('#proof-phone').value); form.append('file', file);
  try {
    const response = await fetch('/api/public/payment-proof', { method: 'POST', body: form });
    if (!response.ok) { const body = await response.json().catch(() => ({ detail: 'Não foi possível enviar o comprovante.' })); throw new Error(body.detail); }
    message('proof-result', 'Comprovante enviado para análise da Bruna.', true); event.target.reset();
  } catch (error) { message('proof-result', error.message); }
};

$('#open-admin').onclick = () => openDialog('#admin-dialog');
$('#admin-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('#admin-username').value, password: $('#admin-password').value }) });
    closeDialogs();
    if (result.role === 'tester') { window.alert('Perfil de testes conectado. A agenda e os dados administrativos da Bruna permanecem protegidos.'); if (result.must_change_password) openDialog('#change-password-dialog'); return; }
    $('#public-app').hidden = true; $('#admin-app').hidden = false; ensureAdminEntryUI(); await loadAdmin();
    if (result.must_change_password) openDialog('#change-password-dialog');
  } catch (error) { message('admin-result', error.message); }
};
$('#admin-logout').onclick = async () => { try { await api('/api/admin/logout', { method: 'POST' }); } finally { window.location.reload(); } };
$('#change-password-form').onsubmit = async (event) => {
  event.preventDefault();
  try { await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: $('#new-password').value }) }); closeDialogs(); } catch (error) { message('change-password-result', error.message); }
};

function paymentStatus(payment) { return ({ paid: ['Pago', 'paid'], submitted: ['Comprovante enviado', 'submitted'], pending: ['Sem comprovante', ''] })[payment.status] || ['Pendente', '']; }
function appointmentStatus(status) { return ({ scheduled: 'Agendado', rescheduled: 'Alterado', completed: 'Concluído', cancelled: 'Cancelado' })[status] || status; }
function appointmentLine(appointment, finance) {
  const state = paymentStatus(appointment.payment);
  const visitActions = (appointment.status === 'scheduled' || appointment.status === 'rescheduled') ? '<button type="button" onclick="setAppointmentStatus(' + appointment.id + ',\'completed\')">Concluir</button><button type="button" onclick="setAppointmentStatus(' + appointment.id + ',\'cancelled\')">Cancelar</button>' : '';
  const actions = '<button type="button" onclick="editAppointment(' + appointment.id + ')">Editar</button><button type="button" onclick="openPaymentEntry(' + appointment.id + ')">Lançar pagamento</button>' + visitActions + (finance ? (appointment.payment.proof ? '<button type="button" onclick="showProof(' + appointment.id + ')">Ver comprovante</button>' : '') + (appointment.payment.status === 'submitted' ? '<button type="button" onclick="confirmPayment(' + appointment.id + ')">Confirmar</button>' : '') : '');
  return '<article class="admin-row"><time>' + new Date(appointment.starts_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + '<b>' + new Date(appointment.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</b></time><div><strong>' + escapeHTML(appointment.client) + '</strong><small>' + escapeHTML(appointment.phone || 'Sem telefone') + ' · ' + escapeHTML(appointment.service) + ' · ' + money(appointment.price_cents) + '</small></div><span class="status ' + state[1] + '">' + state[0] + '</span>' + actions + '</article>';
}
function agenda() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const filter = $('#agenda-filter').value; let end = null;
  if (filter === 'day') end = new Date(+start + 864e5);
  if (filter === 'week') end = new Date(+start + 6048e5);
  if (filter === 'month') end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return items.filter((appointment) => new Date(appointment.starts_at) >= start && (!end || new Date(appointment.starts_at) < end));
}
function renderAgenda() { $('#agenda-list').innerHTML = agenda().map((appointment) => appointmentLine(appointment)).join('') || '<p class="muted">Nenhuma reserva neste período.</p>'; }
async function loadAdmin() {
  const result = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/appointments'), api('/api/admin/blocks')]), dashboard = result[0];
  items = result[1]; agendaBlocks = result[2];
  $('#received').textContent = money(dashboard.received_cents); $('#pending').textContent = money(dashboard.pending_cents); $('#submitted').textContent = dashboard.submitted;
  $('#today-count').textContent = dashboard.today; $('#week-count').textContent = dashboard.week; $('#month-count').textContent = dashboard.month;
  $('#default-price').value = (dashboard.price_cents / 100).toFixed(2).replace('.', ',');
  $('#review-list').innerHTML = items.filter((appointment) => appointment.payment.status === 'submitted').map((appointment) => appointmentLine(appointment, true)).join('') || '<p class="muted">Nenhum comprovante aguardando análise.</p>';
  renderAgenda();
  renderBlocks();
  $('#finance-list').innerHTML = items.map((appointment) => appointmentLine(appointment, true)).join('') || '<p class="muted">Nenhum pagamento registrado.</p>';
}
$('#agenda-filter').onchange = renderAgenda;
document.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button)); document.querySelectorAll('.admin-view').forEach((view) => { view.hidden = view.id !== button.dataset.tab; }); }; });
$('#pricing-form').onsubmit = async (event) => {
  event.preventDefault();
  try { const value = $('#default-price').value.replace('.', '').replace(',', '.'); await api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ price_cents: Math.round(parseFloat(value) * 100) }) }); message('price-result', 'Valor atualizado para as próximas reservas.', true); loadConfig().catch(() => {}); } catch (error) { message('price-result', error.message); }
};
window.confirmPayment = async (id) => { try { await api('/api/admin/payments/' + id + '/confirm', { method: 'POST', body: '{}' }); await loadAdmin(); } catch (error) { window.alert(error.message); } };
window.showProof = (id) => window.open('/api/admin/payments/' + id + '/proof', '_blank', 'noopener');

let editingAppointmentId = null;
function localDateTime(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function ensureAdminEntryUI() {
  if ($('#manual-entry-dialog')) return;
  const agendaCard = $('#agenda .card');
  const dialog = document.createElement('dialog');
  dialog.id = 'manual-entry-dialog';
  dialog.innerHTML = '<form id="manual-entry-form"><div class="dialog-head"><div><p class="overline">PAINEL DA BRUNA</p><h2 id="manual-entry-title">Novo lançamento</h2></div><button type="button" class="close">×</button></div><label>Nome ou apelido *<input id="manual-name" required maxlength="100"></label><label>Telefone<input id="manual-phone" inputmode="tel" maxlength="30"></label><label>Serviço<input id="manual-service" maxlength="100" value="Atendimento Buu Nails"></label><div class="two"><label>Data e horário<input id="manual-starts-at" type="datetime-local" required></label><label>Duração<select id="manual-duration"><option value="30">30 min</option><option value="60">1 hora</option><option value="90">1h30</option><option value="120">2 horas</option></select></label></div><label>Valor (R$)<input id="manual-price" inputmode="decimal" required></label><label><input id="manual-paid" type="checkbox"> Já foi pago (mesmo sem comprovante)</label><button class="primary">Salvar lançamento</button><p id="manual-entry-result" class="error"></p></form>';
  document.body.appendChild(dialog);
  removeDurationControls();
  dialog.querySelector('.close').onclick = closeDialogs;
  const openButton = document.createElement('button');
  openButton.type = 'button'; openButton.className = 'secondary admin-action'; openButton.textContent = 'Nova reserva ou lançamento';
  agendaCard.querySelector('.section-title').insertAdjacentElement('afterend', openButton);
  openButton.onclick = () => openManualEntry();
  const paymentButton = document.createElement('button');
  paymentButton.type = 'button'; paymentButton.className = 'secondary admin-action'; paymentButton.textContent = 'Registrar pagamento';
  openButton.insertAdjacentElement('afterend', paymentButton);
  paymentButton.onclick = () => openPaymentEntry();
  const blockButton = document.createElement('button');
  blockButton.type = 'button'; blockButton.className = 'secondary admin-action'; blockButton.textContent = 'Bloquear agenda';
  paymentButton.insertAdjacentElement('afterend', blockButton);
  blockButton.onclick = () => openAgendaBlock();
  const blockList = document.createElement('div');
  blockList.id = 'block-list'; blockList.className = 'admin-list';
  agendaCard.appendChild(blockList);
  $('#manual-entry-form').onsubmit = saveManualEntry;
  const paymentDialog = document.createElement('dialog');
  paymentDialog.id = 'payment-entry-dialog';
  paymentDialog.innerHTML = '<form id="payment-entry-form"><div class="dialog-head"><div><p class="overline">CONTABILIDADE</p><h2>Registrar pagamento</h2></div><button type="button" class="close">×</button></div><label>Reserva da cliente<select id="payment-appointment" required></select></label><p class="muted">Selecione a cliente que já possui reserva. O lançamento será vinculado a ela.</p><label><input id="payment-paid" type="checkbox" checked> Pagamento confirmado</label><button class="primary">Salvar pagamento</button><p id="payment-entry-result" class="error"></p></form>';
  document.body.appendChild(paymentDialog);
  paymentDialog.querySelector('.close').onclick = closeDialogs;
  $('#payment-entry-form').onsubmit = savePaymentEntry;
  const blockDialog = document.createElement('dialog');
  blockDialog.id = 'agenda-block-dialog';
  blockDialog.innerHTML = '<form id="agenda-block-form"><div class="dialog-head"><div><p class="overline">AGENDA DA BRUNA</p><h2>Bloquear período</h2></div><button type="button" class="close">×</button></div><p class="muted">Clientes verão apenas que este período está indisponível.</p><label>Início<input id="block-start" type="datetime-local" required></label><label>Fim<input id="block-end" type="datetime-local" required></label><label>Motivo (opcional)<input id="block-note" maxlength="160" placeholder="Ex.: compromisso pessoal"></label><button class="primary">Bloquear período</button><p id="block-result" class="error"></p></form>';
  document.body.appendChild(blockDialog);
  blockDialog.querySelector('.close').onclick = closeDialogs;
  $('#agenda-block-form').onsubmit = saveAgendaBlock;
}
function openManualEntry(appointment) {
  editingAppointmentId = appointment ? appointment.id : null;
  $('#manual-entry-title').textContent = appointment ? 'Editar reserva' : 'Novo lançamento';
  $('#manual-name').value = appointment ? appointment.client : '';
  $('#manual-phone').value = appointment ? appointment.phone : '';
  $('#manual-service').value = appointment ? appointment.service : 'Atendimento Buu Nails';
  $('#manual-starts-at').value = appointment ? appointment.starts_at.slice(0, 16) : localDateTime(new Date(Date.now() + 864e5));
  $('#manual-price').value = appointment ? (appointment.price_cents / 100).toFixed(2).replace('.', ',') : ((config.price_cents || 0) / 100).toFixed(2).replace('.', ',');
  $('#manual-paid').checked = !!appointment && appointment.payment.status === 'paid';
  message('manual-entry-result', ''); openDialog('#manual-entry-dialog');
}
window.editAppointment = (id) => {
  const appointment = items.find((item) => item.id === id);
  if (appointment) openManualEntry(appointment);
};
async function saveManualEntry(event) {
  event.preventDefault();
  const value = $('#manual-price').value.replace('.', '').replace(',', '.');
  const data = { name: $('#manual-name').value, phone: $('#manual-phone').value, service: $('#manual-service').value, starts_at: $('#manual-starts-at').value, duration: 60, price_cents: Math.round(parseFloat(value) * 100), paid: $('#manual-paid').checked };
  try {
    const url = editingAppointmentId ? '/api/admin/appointments/' + editingAppointmentId : '/api/admin/manual-entry';
    await api(url, { method: editingAppointmentId ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeDialogs(); await loadAdmin();
  } catch (error) { message('manual-entry-result', error.message); }
}
function openPaymentEntry(id) {
  const select = $('#payment-appointment');
  select.innerHTML = items.filter((item) => item.status !== 'cancelled').map((item) => '<option value="' + item.id + '">' + escapeHTML(item.client) + ' — ' + new Date(item.starts_at).toLocaleDateString('pt-BR') + ' às ' + new Date(item.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</option>').join('');
  if (id) select.value = id;
  if (!select.options.length) return window.alert('Não há reservas disponíveis para vincular um pagamento.');
  message('payment-entry-result', ''); openDialog('#payment-entry-dialog');
}
window.openPaymentEntry = openPaymentEntry;
async function savePaymentEntry(event) {
  event.preventDefault();
  try { await api('/api/admin/payments/' + $('#payment-appointment').value + '/confirm', { method: 'POST', body: JSON.stringify({ paid: $('#payment-paid').checked }) }); closeDialogs(); await loadAdmin(); } catch (error) { message('payment-entry-result', error.message); }
}
function renderBlocks() {
  const list = $('#block-list');
  if (!list) return;
  list.innerHTML = agendaBlocks.length ? '<p class="overline">BLOQUEIOS ATIVOS</p>' + agendaBlocks.map((block) => '<article class="admin-row"><time>' + new Date(block.starts_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + '<b>' + new Date(block.starts_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</b></time><div><strong>Agenda bloqueada</strong><small>Até ' + new Date(block.ends_at).toLocaleDateString('pt-BR') + ' às ' + new Date(block.ends_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' · ' + escapeHTML(block.note) + '</small></div><button type="button" onclick="removeAgendaBlock(' + block.id + ')">Liberar</button></article>').join('') : '';
}
function openAgendaBlock() {
  const start = new Date(Date.now() + 864e5); start.setHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  $('#block-start').value = localDateTime(start); $('#block-end').value = localDateTime(end); $('#block-note').value = ''; message('block-result', ''); openDialog('#agenda-block-dialog');
}
async function saveAgendaBlock(event) {
  event.preventDefault();
  try { await api('/api/admin/blocks', { method: 'POST', body: JSON.stringify({ starts_at: $('#block-start').value, ends_at: $('#block-end').value, note: $('#block-note').value }) }); closeDialogs(); await loadAdmin(); } catch (error) { message('block-result', error.message); }
}
window.removeAgendaBlock = async (id) => { try { await api('/api/admin/blocks/' + id, { method: 'DELETE' }); await loadAdmin(); } catch (error) { window.alert(error.message); } };
window.setAppointmentStatus = async (id, status) => {
  try { await api('/api/admin/appointments/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) }); await loadAdmin(); } catch (error) { window.alert(error.message); }
};

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const updateBanner = $('#update-banner'), updateButton = $('#update-now'), notificationButton = $('#enable-notify'), notificationCard = notificationButton && notificationButton.closest('.notify-card');
function preference(key) {
  try { const value = localStorage.getItem(key); if (value) return value; } catch (_) {}
  try { const value = sessionStorage.getItem(key); if (value) return value; } catch (_) {}
  const match = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}
function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
  try { sessionStorage.setItem(key, value); } catch (_) {}
  document.cookie = key + '=' + encodeURIComponent(value) + '; Max-Age=31536000; Expires=Fri, 01 Sep 2034 00:00:00 GMT; Path=/; SameSite=Lax';
}
function hideUpdate() { if (updateBanner) updateBanner.hidden = true; }
function renderUpdate() {
  if (!releaseInfo || !updateBanner || !updateButton) return;
  if (!isStandalone || preference('buu-release-version') === releaseInfo.version) return hideUpdate();
  if (isStandalone && !waitingWorker) return hideUpdate();
  const details = updateBanner.querySelector('div'), kind = releaseInfo.type === 'security' ? 'Atualização de segurança' : (releaseInfo.type === 'fix' ? 'Correção importante' : 'Nova funcionalidade');
  if (details) details.innerHTML = '<strong>' + kind + '</strong><small>' + escapeHTML(releaseInfo.title) + ': ' + escapeHTML(releaseInfo.description) + '</small>';
  updateButton.textContent = isStandalone ? 'Atualizar agora' : 'Entendi'; updateBanner.hidden = false;
}
function refreshNotificationCard() {
  if (!notificationCard || !notificationButton) return;
  if (!isStandalone || !('Notification' in window)) { notificationCard.hidden = true; return; }
  const permission = Notification.permission;
  if (permission === 'granted') { savePreference('buu-notification-enabled', '1'); hideNotificationPrompt(); return; }
  if (permission === 'denied' || preference('buu-notification-enabled') === '1' || preference('buu-notification-dismissed') === '1') { hideNotificationPrompt(); return; }
  notificationButton.textContent = 'Ativar'; notificationCard.hidden = false;
}
function hideNotificationPrompt() {
  if (!notificationCard) return;
  notificationCard.hidden = true;
  notificationCard.style.setProperty('display', 'none', 'important');
}
if (notificationButton) notificationButton.onclick = async () => {
  notificationButton.disabled = true;
  notificationButton.textContent = 'Ativando…';
  savePreference('buu-notification-dismissed', '1'); hideNotificationPrompt();
  if (!('Notification' in window)) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') savePreference('buu-notification-enabled', '1');
    hideNotificationPrompt();
  } catch (_) { hideNotificationPrompt(); }
};
if (updateButton) updateButton.onclick = () => {
  if (releaseInfo) savePreference('buu-release-version', releaseInfo.version);
  if (isStandalone && waitingWorker) { reloadAfterUpdate = true; waitingWorker.postMessage('skipWaiting'); }
  hideUpdate();
};
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredPrompt = event; $('#install').hidden = false; });
$('#install').onclick = async () => { if (!deferredPrompt) return; await deferredPrompt.prompt(); deferredPrompt = null; $('#install').hidden = true; };
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/service-worker.js').then((registration) => {
    waitingWorker = registration.waiting || null; renderUpdate();
    registration.addEventListener('updatefound', () => { const worker = registration.installing; if (!worker) return; worker.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) { waitingWorker = registration.waiting || worker; renderUpdate(); } }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloadAfterUpdate) window.location.reload(); });
}
fetch('/api/public/release', { cache: 'no-store' }).then((response) => response.json()).then((info) => { releaseInfo = info; if (!preference('buu-release-version')) savePreference('buu-release-version', info.version); renderUpdate(); }).catch(hideUpdate);
refreshNotificationCard();
loadConfig().catch(() => message('booking-result', 'Não foi possível carregar os dados agora. Tente novamente em instantes.'));

function resetAppZoom() {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const original = 'width=device-width,initial-scale=1,viewport-fit=cover';
  viewport.content = original + ',maximum-scale=1';
  window.setTimeout(() => { viewport.content = original; }, 80);
}
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', resetAppZoom));
document.addEventListener('focusout', (event) => {
  if (!event.target.matches('input,select,textarea')) return;
  window.setTimeout(() => { if (!document.activeElement.matches('input,select,textarea')) resetAppZoom(); }, 50);
});

function ensureAboutUI() {
  const footer = document.querySelector('footer');
  if (!footer || $('#about-dialog')) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'about-link'; button.textContent = 'Sobre';
  footer.insertBefore(button, footer.firstChild);
  const dialog = document.createElement('dialog');
  dialog.id = 'about-dialog';
  dialog.innerHTML = '<div class="about-content"><div class="dialog-head"><div><p class="overline">BUU NAILS</p><h2>Sobre o aplicativo</h2></div><button type="button" class="close">×</button></div><p>Agenda online da Bruna para reservas, acompanhamento de horários e pagamentos com mais organização.</p><div class="about-version"><strong>Versão instalada: <span id="about-installed"></span></strong><br><span id="about-server">Consulte a versão disponível no servidor.</span></div><div class="about-actions"><button type="button" class="secondary" id="about-check">Buscar atualização</button><button type="button" class="primary" id="about-update" hidden>Atualizar agora</button></div></div>';
  document.body.appendChild(dialog);
  $('#about-installed').textContent = APP_VERSION;
  dialog.querySelector('.close').onclick = closeDialogs;
  button.onclick = () => { $('#about-server').textContent = 'Toque em “Buscar atualização” para conferir o servidor.'; $('#about-update').hidden = true; openDialog('#about-dialog'); };
  $('#about-check').onclick = checkForUpdate;
  $('#about-update').onclick = applyManualUpdate;
}
async function checkForUpdate() {
  const status = $('#about-server'), update = $('#about-update');
  status.textContent = 'Consultando o servidor…'; update.hidden = true;
  try {
    const response = await fetch('/api/public/release', { cache: 'no-store' });
    const server = await response.json();
    if (server.version === APP_VERSION) {
      status.textContent = 'Tudo certo: você já está na versão mais recente (' + server.version + ').';
    } else {
      status.textContent = 'Nova versão ' + server.version + ' disponível: ' + server.title + '.';
      update.hidden = false;
    }
  } catch (_) { status.textContent = 'Não foi possível consultar agora. Verifique sua conexão e tente novamente.'; }
}
async function applyManualUpdate() {
  const status = $('#about-server');
  status.textContent = 'Atualizando o aplicativo…';
  try {
    if ('serviceWorker' in navigator) { const registration = await navigator.serviceWorker.getRegistration(); if (registration) await registration.update(); }
  } catch (_) {}
  window.setTimeout(() => window.location.reload(), 500);
}
ensureAboutUI();
