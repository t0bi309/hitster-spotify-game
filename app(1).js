// ===== GLOBALE EINSTELLUNGEN: hier alles zentral anpassen =====
const CONFIG = {
  clientId: 'f06d5ab3cbb3498dbfa313c437dbfdb5',
  redirectUri: location.origin + location.pathname,
  scopes: 'user-read-private playlist-read-private playlist-read-collaborative user-modify-playback-state user-read-playback-state',
  winCards: 10,                 // Karten im Zeitstrahl bis zum Sieg
  minSongs: 10,                 // Mindestanzahl Songs für ein Spiel
  maxPlayers: 8,
  introMs: 1000,                // Einblendung "X ist dran"
  fxBars: 28,                   // Balken der Musik-Animation
  playerColors: ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#b197fc', '#ff922b', '#22b8cf', '#f783ac'],
  cardColors: ['#e6edfc', '#fde6ea', '#e3f5ea', '#fdf1d6', '#ece5fb', '#dff2f6'],  // helle Kartenfarben
  flagWords: /remaster|best of|greatest|deluxe|anniversary|collection|hits|edition|live/i,
  storage: { auth: 'hs_auth', lists: 'hs_lists', sel: 'hs_sel', verifier: 'hs_verifier' }
};

// ===== Hilfsfunktionen =====
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.className = 'show'; setTimeout(() => t.className = '', 4000); };

// ===== Spotify-Login (PKCE, kein Secret nötig) =====
class Auth {
  static data = store.get(CONFIG.storage.auth, null);
  static get loggedIn() { return !!Auth.data; }
  static rand(n = 64) {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return [...crypto.getRandomValues(new Uint8Array(n))].map(x => c[x % 62]).join('');
  }
  static async login() {
    const v = Auth.rand();
    localStorage.setItem(CONFIG.storage.verifier, v);
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: CONFIG.clientId, response_type: 'code', redirect_uri: CONFIG.redirectUri,
      scope: CONFIG.scopes, code_challenge_method: 'S256', code_challenge: ch
    });
  }
  static async token(body) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, ...body })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || 'Login fehlgeschlagen');
    Auth.data = { access: j.access_token, refresh: j.refresh_token || Auth.data?.refresh, expires: Date.now() + j.expires_in * 1000 - 60000 };
    store.set(CONFIG.storage.auth, Auth.data);
  }
  static async handleCallback() {
    const code = new URLSearchParams(location.search).get('code');
    if (!code) return;
    try {
      await Auth.token({ grant_type: 'authorization_code', code, redirect_uri: CONFIG.redirectUri, code_verifier: localStorage.getItem(CONFIG.storage.verifier) });
    } catch (e) { toast(e.message); }
    history.replaceState({}, '', CONFIG.redirectUri);
  }
  static async access() {
    if (Date.now() > Auth.data.expires) await Auth.token({ grant_type: 'refresh_token', refresh_token: Auth.data.refresh });
    return Auth.data.access;
  }
  static logout() { localStorage.removeItem(CONFIG.storage.auth); Auth.data = null; }
}

// ===== Spotify Web API =====
class Api {
  static async call(path, opt = {}) {
    const r = await fetch(path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path, {
      ...opt, headers: { Authorization: 'Bearer ' + await Auth.access(), 'Content-Type': 'application/json' }
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error?.message || 'Fehler ' + r.status);
    return j;
  }
  static async playlist(id) {
    const out = []; let url = `/playlists/${id}/items?limit=50`;
    while (url) { const j = await Api.call(url); out.push(...j.items); url = j.next; }
    return out;
  }
  static track(id) { return Api.call('/tracks/' + id); }
}

// ===== Song-Modell und Songliste =====
class Song {
  constructor(o) { Object.assign(this, o); }
  static fromTrack(t) {
    const a = t.album || {};
    return new Song({
      id: t.id, title: t.name, artist: t.artists.map(x => x.name).join(', '),
      year: parseInt(a.release_date) || 0, album: a.name || '',
      flag: a.album_type === 'compilation' || CONFIG.flagWords.test(a.name || '')
    });
  }
  get uri() { return 'spotify:track:' + this.id; }
}

class Library {
  static lists = [];   // [{ id, name, songs: [] }]
  static sel = [];     // IDs der Listen, die im Spiel verwendet werden
  static init() {
    Library.lists = store.get(CONFIG.storage.lists, []);
    Library.sel = store.get(CONFIG.storage.sel, []);
    const old = store.get('hs_songs', null);   // Übernahme der alten Einzelliste
    if (old && !Library.lists.length) { Library.lists = [{ id: 'alt', name: 'Erste Liste', songs: old }]; Library.sel = ['alt']; localStorage.removeItem('hs_songs'); }
    Library.lists.forEach(l => l.songs = l.songs.map(s => new Song(s)));
    Library.save();
  }
  static save() { store.set(CONFIG.storage.lists, Library.lists); store.set(CONFIG.storage.sel, Library.sel); }
  static get songs() {   // alle Songs der gewählten Listen, ohne Doppelte
    const m = new Map();
    Library.lists.filter(l => Library.sel.includes(l.id)).forEach(l => l.songs.forEach(s => m.set(s.id, s)));
    return [...m.values()];
  }
  static find(id) { for (const l of Library.lists) { const s = l.songs.find(x => x.id === id); if (s) return s; } }
  static async import(input, name) {
    const id = (input.match(/playlist\/([A-Za-z0-9]+)/) || [, input.trim()])[1];
    const items = await Api.playlist(id);
    if (!name) { try { name = (await Api.call(`/playlists/${id}?fields=name`)).name; } catch { name = 'Liste ' + (Library.lists.length + 1); } }
    const songs = items.map(i => i.item || i.track).filter(t => t && t.id && t.type !== 'episode').map(Song.fromTrack);
    Library.lists = Library.lists.filter(l => l.id !== id);
    Library.lists.push({ id, name, songs });
    if (!Library.sel.includes(id)) Library.sel.push(id);
    Library.save();
  }
  static remove(id) {
    Library.lists = Library.lists.filter(l => l.id !== id);
    Library.sel = Library.sel.filter(x => x !== id);
    Library.save();
  }
}

// ===== Wiedergabe: steuert die Spotify-App / ein aktives Gerät =====
class Player {
  static async play(song) {
    try { await Api.call('/me/player/play', { method: 'PUT', body: JSON.stringify({ uris: [song.uri] }) }); }
    catch (e) { toast('Abspielen fehlgeschlagen: ' + e.message + ' (Spotify-App öffnen und kurz einen Song starten)'); }
  }
}

// ===== Kartendarstellung =====
class Card {
  static color(s) { let h = 0; for (const c of s.id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CONFIG.cardColors[h % CONFIG.cardColors.length]; }
  static html(s, hidden = false) {
    return hidden
      ? `<div class="card hidden"><span class="year">?</span></div>`
      : `<div class="card" style="--cc:${Card.color(s)}"><span class="year">${s.year}</span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></div>`;
  }
  static node(inner, hollow = false) { return `<div class="node${hollow ? ' hollow' : ''}">${inner}</div>`; }
  static timeline(inner) { return `<div class="axis"><span>← älter</span><span>jünger →</span></div><div class="line">${inner}</div>`; }
}

// ===== Spiellogik =====
class Game {
  static initials(n) {
    const w = n.trim().split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
  }
  constructor(names, mode, target) {
    this.mode = mode; this.target = target; this.count = 0;   // mode: 'score' oder 'rounds'
    this.deck = shuffle(Library.songs);
    this.players = names.map((n, i) => ({ name: n, ini: Game.initials(n), color: CONFIG.playerColors[i], score: 0, line: [this.deck.pop()] }));
    this.turn = 0; this.current = null; this.ok = false; this.won = false;
  }
  get player() { return this.players[this.turn]; }
  get winners() { const m = Math.max(...this.players.map(p => p.score)); return this.players.filter(p => p.score === m); }
  draw() { return (this.current = this.deck.pop()); }
  place(i) {
    const l = this.player.line, p = l[i - 1], n = l[i], y = this.current.year;
    this.ok = (!p || y >= p.year) && (!n || y <= n.year);
    if (this.ok) { l.splice(i, 0, this.current); this.player.score++; }
    this.count++;
    this.won = this.mode === 'score' ? this.player.score >= this.target : this.count >= this.target * this.players.length;
  }
  next() { this.turn = (this.turn + 1) % this.players.length; this.current = null; }
}

// ===== QR-Scanner für physische Karten =====
class Scanner {
  static async start(video, onId) {
    Scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = Scanner.stream; await video.play();
    const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    Scanner.on = true;
    const tick = () => {
      if (!Scanner.on) return;
      if (video.videoWidth) {
        c.width = video.videoWidth; c.height = video.videoHeight; x.drawImage(video, 0, 0);
        const r = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        const m = r && (r.data.match(/track[\/:]([A-Za-z0-9]{22})/) || r.data.match(/^([A-Za-z0-9]{22})$/));
        if (m) { Scanner.stop(); return onId(m[1]); }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
  static stop() { Scanner.on = false; Scanner.stream?.getTracks().forEach(t => t.stop()); }
}

// ===== Oberfläche: jede Methode ist ein Bildschirm oder eine Aktion (data-act) =====
class UI {
  static names = ['Spieler 1', 'Spieler 2'];
  static opts = { mode: 'score', target: 10 };
  static set(html) { $('#view').innerHTML = html; }
  static fx(on) { $('#fx').classList.toggle('on', on); }
  static board() {
    const g = UI.game;
    $('#board').innerHTML = g ? g.players.map((p, i) => `<div class="pchip${i === g.turn ? ' on' : ''}" style="--pc:${p.color}"><i>${p.ini}</i><b>${p.score}</b></div>`).join('') : '';
  }
  static intro(p) {
    const d = document.createElement('div');
    d.className = 'intro'; d.style.setProperty('--pc', p.color); d.style.animationDuration = CONFIG.introMs + 'ms';
    d.innerHTML = `<div><span>${esc(p.name)}</span> ist dran</div>`;
    document.body.append(d); setTimeout(() => d.remove(), CONFIG.introMs);
  }

  static home() {
    Scanner.stop(); UI.game = null; UI.board(); UI.fx(false);
    if (!Auth.loggedIn) return UI.set(`<p class="muted">Melde dich mit deinem Spotify-Premium-Konto an.</p><button class="primary" data-act="login">Mit Spotify anmelden</button>`);
    UI.set(`<p class="muted">${Library.lists.length} Listen, ${Library.songs.length} Songs ausgewählt</p>
      <button class="primary" data-act="setup">Spiel starten (digital)</button>
      <button data-act="scan">Karten scannen (physisch)</button>
      <button data-act="importView">Playlist importieren und prüfen</button>
      <button class="ghost" data-act="logout">Abmelden</button>`);
  }
  static login() { Auth.login(); }
  static logout() { Auth.logout(); UI.home(); }

  // --- Import ---
  static importView() {
    const lists = Library.lists.map(l => `<div class="row"><span>${esc(l.name)} <span class="muted">(${l.songs.length})</span></span>
      <span><button data-act="editList" data-id="${l.id}">Prüfen</button> <button data-act="removeList" data-id="${l.id}">Entfernen</button></span></div>`).join('');
    UI.set(`<h2>Meine Listen</h2>${lists || '<p class="muted">Noch keine Liste importiert.</p>'}
      <h2>Neue Playlist</h2>
      <p class="muted">Die Playlist muss dir gehören. Fremde Playlists vorher in eine eigene kopieren.</p>
      <input id="pl" placeholder="Playlist-Link oder ID">
      <input id="plname" placeholder="Name, z. B. Metal (optional)">
      <button class="primary" data-act="doImport">Importieren</button>`);
  }
  static async doImport() {
    const v = $('#pl').value; if (!v) return;
    toast('Lade Playlist …');
    try { await Library.import(v, $('#plname').value.trim()); UI.importView(); toast('Importiert'); } catch (e) { toast(e.message); }
  }
  static removeList(el) {
    if (!confirm('Diese Liste wirklich entfernen?')) return;
    Library.remove(el.dataset.id); UI.importView();
  }
  static editList(el) {
    const l = UI.edit = Library.lists.find(x => x.id === el.dataset.id);
    const rows = l.songs.map((s, i) => `<tr class="${s.flag ? 'flag' : ''}"><td>${esc(s.artist)}<br><span class="muted">${esc(s.title)}${s.flag ? ' (' + esc(s.album) + ')' : ''}</span></td><td><input type="number" data-i="${i}" value="${s.year}"></td></tr>`).join('');
    UI.set(`<h2>${esc(l.name)}</h2>
      <p class="muted">Gelb markiert: Das Jahr stammt vermutlich von einem Sampler oder Remaster. Bitte prüfen.</p>
      <div class="scroll"><table>${rows}</table></div>
      <button class="primary" data-act="saveYears">Jahre speichern</button><button class="ghost" data-act="importView">Zurück</button>`);
  }
  static saveYears() {
    document.querySelectorAll('td input').forEach(i => UI.edit.songs[i.dataset.i].year = +i.value || 0);
    Library.save(); toast('Gespeichert');
  }

  // --- Spiel-Setup ---
  static readSetup() {
    UI.names = [...document.querySelectorAll('.pn')].map(i => i.value.trim());
    UI.opts = { mode: $('#mode').value, target: +$('#target').value || 10 };
    Library.sel = [...document.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    Library.save();
  }
  static setup() {
    if (!Library.lists.length) return toast('Erst eine Playlist importieren.');
    const boxes = Library.lists.map(l => `<label class="row"><span>${esc(l.name)} <span class="muted">(${l.songs.length})</span></span>
      <input type="checkbox" value="${l.id}" ${Library.sel.includes(l.id) ? 'checked' : ''}></label>`).join('');
    const players = UI.names.map((n, i) => `<div class="row"><i class="chip" style="--pc:${CONFIG.playerColors[i]}">${Game.initials(n || '?')}</i>
      <input class="pn" value="${esc(n)}" placeholder="Spieler ${i + 1}"><button data-act="delPlayer" data-i="${i}">−</button></div>`).join('');
    const o = UI.opts;
    UI.set(`<h2>Quiz wählen</h2><p class="muted">Eine Liste für ein Genre, mehrere für einen Mix.</p>${boxes}
      <h2>Spieler</h2>${players}
      ${UI.names.length < CONFIG.maxPlayers ? '<button data-act="addPlayer">+ Spieler hinzufügen</button>' : ''}
      <h2>Siegbedingung</h2>
      <div class="row"><select id="mode"><option value="score" ${o.mode === 'score' ? 'selected' : ''}>Wer zuerst so viele Punkte hat</option>
        <option value="rounds" ${o.mode === 'rounds' ? 'selected' : ''}>Feste Rundenzahl pro Spieler</option></select>
        <input id="target" type="number" min="1" value="${o.target}"></div>
      <button class="primary" data-act="startGame">Spiel starten</button>`);
  }
  static addPlayer() { UI.readSetup(); UI.names.push('Spieler ' + (UI.names.length + 1)); UI.setup(); }
  static delPlayer(el) { UI.readSetup(); if (UI.names.length > 1) UI.names.splice(+el.dataset.i, 1); UI.setup(); }
  static startGame() {
    UI.readSetup();
    if (Library.songs.length < CONFIG.minSongs) return toast(`Wähle Listen mit zusammen mindestens ${CONFIG.minSongs} Songs.`);
    UI.game = new Game(UI.names.map((n, i) => n || 'Spieler ' + (i + 1)), UI.opts.mode, UI.opts.target);
    UI.turn();
  }

  // --- Spielablauf ---
  static turn() {
    const g = UI.game, p = g.player; UI.fx(false); UI.board();
    UI.set(`<h2 class="ptitle" style="--pc:${p.color}">${esc(p.name)} ist dran</h2>
      ${Card.timeline(p.line.map(s => Card.node(Card.html(s))).join(''))}
      <button class="primary" data-act="drawCard">Song ziehen und abspielen</button>`);
    UI.intro(p);
  }
  static async drawCard() {
    const s = UI.game.draw();
    if (!s) { toast('Der Stapel ist leer.'); return UI.home(); }
    UI.cur = s; await Player.play(s); UI.place();
  }
  static place() {
    const g = UI.game, slot = i => Card.node(`<button class="slot" data-act="pick" data-i="${i}">+</button>`, true);
    let h = slot(0);
    g.player.line.forEach((s, i) => h += Card.node(Card.html(s)) + slot(i + 1));
    UI.fx(true);
    UI.set(`<h2 class="ptitle" style="--pc:${g.player.color}">${esc(g.player.name)}: Wohin gehört der Song?</h2>
      ${Card.timeline(h)}<button class="ghost" data-act="replay">Nochmal abspielen</button>`);
  }
  static replay() { Player.play(UI.cur); }
  static pick(el) {
    const g = UI.game; g.place(+el.dataset.i); UI.fx(false); UI.board();
    UI.set(`<h2>${g.ok ? 'Richtig!' : 'Leider falsch'}</h2><div class="solo">${Card.html(g.current)}</div>
      ${g.won ? `<h2>${g.winners.map(p => esc(p.name)).join(' & ')} gewinnt!</h2><button class="primary" data-act="home">Zum Menü</button>`
              : `<button class="primary" data-act="nextPlayer">Nächster Spieler</button>`}`);
  }
  static nextPlayer() { UI.game.next(); UI.turn(); }

  // --- Physische Karten scannen ---
  static scan() {
    UI.fx(false);
    UI.set(`<h2>Karte scannen</h2><video id="cam" playsinline muted></video><p class="muted">QR-Code der Karte in die Kamera halten.</p>`);
    Scanner.start($('#cam'), UI.scanned).catch(e => toast('Kamera nicht verfügbar: ' + e.message));
  }
  static async scanned(id) {
    let s = Library.find(id);
    if (!s) { try { s = Song.fromTrack(await Api.track(id)); } catch (e) { toast(e.message); return UI.scan(); } }
    UI.cur = s; await Player.play(s); UI.fx(true);
    UI.set(`<h2>Song läuft</h2><div class="solo">${Card.html(s, true)}</div>
      <button class="primary" data-act="reveal">Aufdecken</button><button class="ghost" data-act="replay">Nochmal abspielen</button>`);
  }
  static reveal() {
    UI.fx(false);
    UI.set(`<div class="solo">${Card.html(UI.cur)}</div>
      <button class="primary" data-act="scan">Nächste Karte scannen</button><button class="ghost" data-act="home">Menü</button>`);
  }
}

// ===== Start =====
(async () => {
  $('#btnHome').onclick = () => UI.home();
  $('#view').addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a && typeof UI[a.dataset.act] === 'function') UI[a.dataset.act](a);
  });
  $('#fx').innerHTML = Array.from({ length: CONFIG.fxBars }, (_, i) => `<i style="--d:${(i * 37 % 11) / 10}s;--h:${30 + (i * 53 % 60)}%"></i>`).join('')
    + [0, 1, 2, 3, 4].map(i => `<em style="left:${10 + i * 19}%;--d:${i * .6}s">${i % 2 ? '♪' : '♫'}</em>`).join('');
  Library.init();
  await Auth.handleCallback();
  UI.home();
})();
