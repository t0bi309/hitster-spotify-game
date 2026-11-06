// ===== GLOBALE EINSTELLUNGEN: hier alles zentral anpassen =====
const CONFIG = {
  clientId: 'f06d5ab3cbb3498dbfa313c437dbfdb5',
  redirectUri: location.origin + location.pathname,
  scopes: 'user-read-private playlist-read-private playlist-read-collaborative user-modify-playback-state user-read-playback-state',
  winCards: 10,                 // Karten im Zeitstrahl bis zum Sieg
  minSongs: 10,                 // Mindestanzahl Songs für ein Spiel
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
  static html(s, hidden = false) {
    return hidden
      ? `<div class="card hidden"><span class="year">?</span></div>`
      : `<div class="card"><span class="year">${s.year}</span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></div>`;
  }
}

// ===== Spiellogik (digitale Timeline) =====
class Game {
  constructor(names) {
    this.deck = shuffle(Library.songs);
    this.players = names.map(n => ({ name: n, line: [this.deck.pop()] }));
    this.turn = 0; this.current = null; this.ok = false; this.won = false;
  }
  get player() { return this.players[this.turn]; }
  draw() { return (this.current = this.deck.pop()); }
  place(i) {
    const l = this.player.line, p = l[i - 1], n = l[i], y = this.current.year;
    this.ok = (!p || y >= p.year) && (!n || y <= n.year);
    if (this.ok) l.splice(i, 0, this.current);
    this.won = this.ok && l.length >= CONFIG.winCards;
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
  static set(html) { $('#view').innerHTML = html; }

  static home() {
    Scanner.stop();
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

  // --- Digitales Spiel ---
  static setup() {
    if (!Library.lists.length) return toast('Erst eine Playlist importieren.');
    const boxes = Library.lists.map(l => `<label class="row"><span>${esc(l.name)} <span class="muted">(${l.songs.length})</span></span>
      <input type="checkbox" value="${l.id}" ${Library.sel.includes(l.id) ? 'checked' : ''}></label>`).join('');
    UI.set(`<h2>Quiz wählen</h2><p class="muted">Eine Liste für ein Genre, mehrere für einen Mix.</p>${boxes}
      <h2>Spieler</h2><input id="names" value="Spieler 1, Spieler 2" placeholder="Namen, mit Komma getrennt">
      <button class="primary" data-act="startGame">Spiel starten</button>`);
  }
  static startGame() {
    Library.sel = [...document.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value); Library.save();
    if (Library.songs.length < CONFIG.minSongs) return toast(`Wähle Listen mit zusammen mindestens ${CONFIG.minSongs} Songs.`);
    const n = $('#names').value.split(',').map(x => x.trim()).filter(Boolean);
    if (!n.length) return;
    UI.game = new Game(n); UI.turn();
  }
  static turn() {
    const g = UI.game, p = g.player;
    UI.set(`<h2>${esc(p.name)} ist dran</h2>
      <p class="muted">${g.players.map(x => esc(x.name) + ': ' + x.line.length + '/' + CONFIG.winCards).join(' | ')}</p>
      <div class="line">${p.line.map(s => Card.html(s)).join('')}</div>
      <button class="primary" data-act="drawCard">Song ziehen und abspielen</button>`);
  }
  static async drawCard() {
    const s = UI.game.draw();
    if (!s) { toast('Der Stapel ist leer.'); return UI.home(); }
    UI.cur = s; await Player.play(s); UI.place();
  }
  static place() {
    const g = UI.game; let h = `<button class="slot" data-act="pick" data-i="0">+</button>`;
    g.player.line.forEach((s, i) => h += Card.html(s) + `<button class="slot" data-act="pick" data-i="${i + 1}">+</button>`);
    UI.set(`<h2>${esc(g.player.name)}: Wohin gehört der Song?</h2><p class="muted">Der Song läuft in Spotify.</p>
      <div class="line">${h}</div><button class="ghost" data-act="replay">Nochmal abspielen</button>`);
  }
  static replay() { Player.play(UI.cur); }
  static pick(el) {
    const g = UI.game; g.place(+el.dataset.i);
    UI.set(`<h2>${g.ok ? 'Richtig!' : 'Leider falsch'}</h2><div class="line">${Card.html(g.current)}</div>
      ${g.won ? `<h2>${esc(g.player.name)} gewinnt!</h2><button class="primary" data-act="home">Zum Menü</button>`
              : `<button class="primary" data-act="nextPlayer">Nächster Spieler</button>`}`);
  }
  static nextPlayer() { UI.game.next(); UI.turn(); }

  // --- Physische Karten scannen ---
  static scan() {
    UI.set(`<h2>Karte scannen</h2><video id="cam" playsinline muted></video><p class="muted">QR-Code der Karte in die Kamera halten.</p>`);
    Scanner.start($('#cam'), UI.scanned).catch(e => toast('Kamera nicht verfügbar: ' + e.message));
  }
  static async scanned(id) {
    let s = Library.find(id);
    if (!s) { try { s = Song.fromTrack(await Api.track(id)); } catch (e) { toast(e.message); return UI.scan(); } }
    UI.cur = s; await Player.play(s);
    UI.set(`<h2>Song läuft</h2><div class="line">${Card.html(s, true)}</div>
      <button class="primary" data-act="reveal">Aufdecken</button><button class="ghost" data-act="replay">Nochmal abspielen</button>`);
  }
  static reveal() {
    UI.set(`<div class="line">${Card.html(UI.cur)}</div>
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
  Library.init();
  await Auth.handleCallback();
  UI.home();
})();
