/* Кинозал — клиент */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('kz.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('kz.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- утилиты ----------
  function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function clock(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  let toastTimer;
  function toast(text, ms = 2600) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function randomRoomId() {
    const words = ['popcorn', 'kometa', 'pelmen', 'zvezda', 'luna', 'sova', 'vafli', 'kakao', 'balkon', 'divan', 'pled', 'chai'];
    const w = () => words[Math.floor(Math.random() * words.length)];
    return `${w()}-${w()}-${Math.floor(100 + Math.random() * 900)}`;
  }
  function parseSource(raw) {
    const text = raw.trim();
    if (!text) return null;
    const yt = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
    if (yt) return { type: 'youtube', value: yt[1], title: 'YouTube · ' + yt[1] };
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return { type: 'youtube', value: text, title: 'YouTube · ' + text };
    let url;
    try { url = new URL(text); } catch { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const rt = /(^|\.)rutube\.ru$/i.test(url.hostname) && url.pathname.match(/\/(?:video|play\/embed|shorts)\/(?:private\/)?([a-f0-9]{32})/i);
    if (rt) {
      const p = url.searchParams.get('p');
      const value = rt[1].toLowerCase() + (p && /^[A-Za-z0-9_-]{1,64}$/.test(p) ? `?p=${p}` : '');
      return { type: 'rutube', value, title: 'Rutube · ' + rt[1].slice(0, 8) };
    }
    if (/(^|\.)rutube\.ru$/i.test(url.hostname)) return { error: 'Это ссылка на страницу Rutube, но не на ролик. Откройте нужное видео и скопируйте адрес вида rutube.ru/video/…' };
    if (/(^|\.)(ok\.ru|odnoklassniki\.ru)$/i.test(url.hostname)) return { error: 'Плеер Одноклассников не даёт управлять собой, синхронизировать его нельзя. Скачайте видео и откройте через «Свой файл».' };
    let name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
    return { type: 'url', value: url.href, title: name };
  }

  // ---------- состояние ----------
  const socket = io({ autoConnect: false });
  let roomId = null;
  let me = null;
  let users = [];
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let clockOffset = 0; // серверное время − локальное
  let S = null;        // состояние плеера с сервера
  let localFile = null;
  let pickForRoom = false;
  let seeking = false;

  // ---------- вход ----------
  const pathRoom = (location.pathname.match(/^\/r\/([a-z0-9-]{3,40})\/?$/i) || [])[1];
  $('nameInput').value = store.get('name', '');
  if (pathRoom) {
    $('roomInput').value = pathRoom.toLowerCase();
    $('roomField').hidden = true;
    $('joinBtn').textContent = 'Войти в комнату';
  }
  $('roomInput').addEventListener('input', () => {
    $('joinBtn').textContent = $('roomInput').value.trim() ? 'Войти в комнату' : 'Создать комнату';
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name) return;
    let id = $('roomInput').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) id = randomRoomId();
    if (id.length < 3) { showJoinError('Код комнаты — от 3 символов: латиница, цифры, дефис.'); return; }
    store.set('name', name);
    roomId = id;
    $('joinBtn').disabled = true;
    socket.connect();
  });
  function showJoinError(t) { $('joinError').textContent = t; $('joinError').hidden = false; }

  socket.on('connect', () => {
    $('connState').classList.remove('off'); $('connState').querySelector('.conn-text').textContent = 'онлайн';
    syncClock();
    socket.emit('join', { room: roomId, name: store.get('name', 'Гость') }, (res) => {
      $('joinBtn').disabled = false;
      if (res?.error) { showJoinError(res.error); socket.disconnect(); return; }
      me = res.you;
      iceServers = res.iceServers || iceServers;
      users = res.users;
      enterRoom();
      renderChat(res.chat);
      renderUsers();
      applyState(res.player);
      if (voice.wanted && voice.stream) { watchLevel(me.id, voice.stream); rejoinVoice(); }
    });
  });
  socket.on('disconnect', () => {
    $('connState').classList.add('off'); $('connState').querySelector('.conn-text').textContent = 'переподключение…';
    closeAllPeers();
  });

  function enterRoom() {
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('roomCode').textContent = roomId;
    document.title = `Кинозал · ${roomId}`;
    if (location.pathname !== `/r/${roomId}`) history.replaceState(null, '', `/r/${roomId}`);
  }

  $('copyLinkBtn').addEventListener('click', async () => {
    const link = `${location.origin}/r/${roomId}`;
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована — отправьте её друзьям'); }
    catch { toast(link, 6000); }
  });

  // ---------- синхронизация часов ----------
  async function syncClock() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const server = await new Promise((r) => socket.timeout(3000).emit('time', t0, (err, t) => r(err ? null : t)));
      const t1 = Date.now();
      if (server) samples.push({ rtt: t1 - t0, off: server - (t0 + t1) / 2 });
      await new Promise((r) => setTimeout(r, 150));
    }
    if (samples.length) { samples.sort((a, b) => a.rtt - b.rtt); clockOffset = samples[0].off; }
  }
  setInterval(() => { if (socket.connected) syncClock(); }, 60000);
  const serverNow = () => Date.now() + clockOffset;

  function expectedPos() {
    if (!S) return 0;
    if (!S.playing) return S.position;
    return S.position + ((serverNow() - S.updatedAt) / 1000) * (S.rate || 1);
  }

  // ---------- плееры ----------
  const video = $('video');
  let hls = null;
  let yt = null, ytReady = false, ytApiPromise = null;
  let player = null; // активный адаптер
  let currentKey = null; // идентификатор загруженного источника

  const html5 = {
    kind: 'html5',
    ready: () => video.readyState >= 1,
    play: () => video.play(),
    pause: () => video.pause(),
    seek: (t) => { video.currentTime = t; },
    time: () => video.currentTime || 0,
    duration: () => video.duration || 0,
    paused: () => video.paused,
    buffered: () => { const b = video.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5 && b.end(i) >= video.currentTime) return b.end(i); return 0; },
    setRate: (r) => { video.playbackRate = r; },
    nudge: (r) => { video.playbackRate = r; },
    setVolume: (v, muted) => { video.volume = v; video.muted = muted; },
  };

  const ytAdapter = {
    kind: 'youtube',
    ready: () => ytReady,
    play: () => { yt.playVideo(); return Promise.resolve(); },
    pause: () => yt.pauseVideo(),
    seek: (t) => yt.seekTo(t, true),
    time: () => (ytReady ? yt.getCurrentTime() : 0),
    duration: () => (ytReady ? yt.getDuration() : 0),
    paused: () => !ytReady || [YT.PlayerState.PAUSED, YT.PlayerState.CUED, YT.PlayerState.ENDED, -1].includes(yt.getPlayerState()),
    buffered: () => (ytReady ? yt.getVideoLoadedFraction() * yt.getDuration() : 0),
    setRate: (r) => { if (ytReady) yt.setPlaybackRate(r); },
    nudge: () => {},
    setVolume: (v, muted) => { if (!ytReady) return; yt.setVolume(Math.round(v * 100)); muted ? yt.mute() : yt.unMute(); },
  };

  // Rutube: плеер во фрейме, управление через postMessage
  const rt = { frame: null, ready: false, playing: false, state: 'pause', time: 0, at: 0, dur: 0, rate: 1, onReady: null };
  function rtSend(type, data = {}) {
    if (rt.frame && rt.frame.contentWindow) rt.frame.contentWindow.postMessage(JSON.stringify({ type: 'player:' + type, data }), '*');
  }
  const rutubeAdapter = {
    kind: 'rutube',
    ready: () => rt.ready,
    play: () => { rtSend('play'); return Promise.resolve(); },
    pause: () => rtSend('pause'),
    seek: (t) => { rtSend('setCurrentTime', { time: t }); rt.time = t; rt.at = performance.now(); },
    time: () => rt.time + (rt.playing ? ((performance.now() - rt.at) / 1000) * rt.rate : 0),
    duration: () => rt.dur,
    paused: () => !rt.playing,
    buffered: () => 0,
    setRate: (r) => { if (r !== rt.rate) { rt.rate = r; rtSend('setPlaybackSpeed', { speed: r }); } },
    nudge: () => {},
    setVolume: (v, muted) => { rtSend('setVolume', { volume: v }); rtSend(muted ? 'mute' : 'unMute'); },
  };
  window.addEventListener('message', (e) => {
    if (!rt.frame || e.source !== rt.frame.contentWindow) return;
    let m;
    try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const d = m.data || {};
    switch (m.type) {
      case 'player:ready':
        rt.ready = true; if (rt.onReady) { rt.onReady(); rt.onReady = null; } break;
      case 'player:currentTime':
        if (Number.isFinite(+d.time)) { rt.time = +d.time; rt.at = performance.now(); }
        if (+d.duration > 0) rt.dur = +d.duration;
        break;
      case 'player:durationChange':
        if (+d.duration > 0) rt.dur = +d.duration; break;
      case 'player:changeState':
        rt.state = d.state;
        if (d.state === 'playing') { rt.playing = true; $('tapNotice').hidden = true; }
        if (d.state === 'pause' || d.state === 'completed') rt.playing = false;
        $('buffering').hidden = d.state !== 'buffering';
        if (d.state === 'completed') socket.emit('ended');
        break;
      case 'player:playComplete':
        rt.playing = false; socket.emit('ended'); break;
      case 'player:error':
        toast('Rutube не показывает это видео: возможно, оно платное, закрыто для встраивания или с ограничением по возрасту.', 6000); break;
    }
  });

  function loadYtApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  function unload() {
    if (hls) { hls.destroy(); hls = null; }
    video.pause(); video.removeAttribute('src'); video.load();
    if (yt) { try { yt.destroy(); } catch { /* ignore */ } yt = null; ytReady = false; $('ytWrap').innerHTML = '<div id="ytPlayer"></div>'; }
    $('ytWrap').hidden = true;
    if (rt.frame) { rt.frame.remove(); }
    Object.assign(rt, { frame: null, ready: false, playing: false, state: 'pause', time: 0, at: 0, dur: 0, rate: 1, onReady: null });
    $('rtWrap').hidden = true;
    video.hidden = false;
    player = null; currentKey = null;
  }

  async function loadSource(src) {
    const key = src.type === 'file' ? `file:${src.title}:${localFile ? localFile.name + localFile.size : ''}` : `${src.type}:${src.value}`;
    if (key === currentKey) return;
    unload();
    currentKey = key;
    $('screenEmpty').hidden = true;
    $('fileNotice').hidden = true;

    if (src.type === 'youtube') {
      video.hidden = true;
      $('ytWrap').hidden = false;
      await loadYtApi();
      if (currentKey !== key) return;
      await new Promise((resolve) => {
        yt = new YT.Player('ytPlayer', {
          videoId: src.value,
          playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
          events: {
            onReady: () => { ytReady = true; resolve(); },
            onStateChange: (e) => {
              $('buffering').hidden = e.data !== YT.PlayerState.BUFFERING;
              if (e.data === YT.PlayerState.ENDED) socket.emit('ended');
              if (e.data === YT.PlayerState.PLAYING) $('tapNotice').hidden = true;
            },
            onError: () => toast('YouTube не даёт встроить это видео. Попробуйте другое.', 5000),
          },
        });
      });
      if (currentKey !== key) return;
      player = ytAdapter;
    } else if (src.type === 'rutube') {
      video.hidden = true;
      $('rtWrap').hidden = false;
      const [id, query] = src.value.split('?');
      const f = document.createElement('iframe');
      f.src = `https://rutube.ru/play/embed/${id}/${query ? '?' + query : ''}`;
      f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';
      f.setAttribute('allowfullscreen', '');
      f.title = 'Rutube';
      rt.frame = f;
      $('rtWrap').appendChild(f);
      const ok = await new Promise((resolve) => { rt.onReady = () => resolve(true); setTimeout(() => resolve(false), 15000); });
      if (currentKey !== key) return;
      if (!ok) { toast('Плеер Rutube не ответил. Проверьте ссылку или обновите страницу.', 6000); return; }
      player = rutubeAdapter;
    } else if (src.type === 'url') {
      const isHls = /\.m3u8(\?|$)/i.test(src.value);
      if (isHls && window.Hls && Hls.isSupported()) {
        hls = new Hls(); hls.loadSource(src.value); hls.attachMedia(video);
      } else {
        video.src = src.value;
      }
      player = html5;
    } else if (src.type === 'file') {
      if (!localFile) { currentKey = null; showFileNotice(src); return; }
      video.src = URL.createObjectURL(localFile);
      player = html5;
    }
    applyVolume();
    if (player === html5) await new Promise((r) => { if (video.readyState >= 1) r(); else video.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
    if (currentKey === key) reconcile(true);
  }

  function showFileNotice(src) {
    $('fileNoticeName').textContent = src.title;
    $('fileNotice').hidden = false;
    $('screenEmpty').hidden = true;
  }

  video.addEventListener('waiting', () => { $('buffering').hidden = false; });
  video.addEventListener('playing', () => { $('buffering').hidden = true; $('tapNotice').hidden = true; });
  video.addEventListener('canplay', () => { $('buffering').hidden = true; });
  video.addEventListener('ended', () => socket.emit('ended'));
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') && !hls) return;
    toast('Видео не открывается. Нужна прямая ссылка на файл (.mp4, .webm, .m3u8), а не страница сайта.', 6000);
  });

  // ---------- применение состояния с сервера ----------
  function applyState(p) {
    S = p;
    S.updatedAt = p.serverNow != null ? p.updatedAt : serverNow();
    $('nowTitle').textContent = S.source ? S.source.title : 'ничего';
    const has = !!S.source;
    $('playBtn').disabled = !has; $('seekInput').disabled = !has; $('rateSelect').disabled = !has;
    $('rateSelect').value = String(S.rate || 1);
    $('playBtn').classList.toggle('playing', !!S.playing);
    $('playBtn').setAttribute('aria-label', S.playing ? 'Пауза' : 'Воспроизвести');
    if (!has) { unload(); $('screenEmpty').hidden = false; $('fileNotice').hidden = true; return; }
    if (S.source.type === 'file' && localFile && localFile.name !== S.source.title) {
      // в комнате другой файл, а у нас открыт старый
      if (p.reason === 'source') localFile = null;
    }
    loadSource(S.source).then(() => reconcile(true));
  }

  function reconcile(hard) {
    if (!player || !S || !player.ready()) return;
    player.setRate(S.rate || 1);
    const target = expectedPos();
    const diff = player.time() - target;
    const limit = player.kind === 'html5' ? 1.0 : 1.5;
    if (hard ? Math.abs(diff) > 0.4 : Math.abs(diff) > limit) player.seek(target);
    else if (player.kind === 'html5' && S.playing) {
      // мягкая подстройка скоростью, чтобы не дёргать картинку
      const k = Math.abs(diff) > 0.15 ? Math.max(-0.08, Math.min(0.08, -diff * 0.12)) : 0;
      player.nudge((S.rate || 1) * (1 + k));
    }
    if (S.playing && player.paused()) {
      const pr = player.play();
      if (pr && pr.catch) pr.catch((err) => { if (err && err.name === 'NotAllowedError') $('tapNotice').hidden = false; });
      if (player.kind === 'youtube') setTimeout(() => { if (S.playing && player === ytAdapter && player.paused() && yt.getPlayerState() !== YT.PlayerState.BUFFERING) $('tapNotice').hidden = false; }, 2500);
      if (player.kind === 'rutube') setTimeout(() => { if (S.playing && player === rutubeAdapter && !rt.playing && rt.state !== 'buffering') $('tapNotice').hidden = false; }, 3500);
    } else if (!S.playing && !player.paused()) {
      player.pause();
    }
  }
  setInterval(() => reconcile(false), 1000);

  socket.on('player', (p) => applyState(p));

  $('tapNoticeBtn').addEventListener('click', () => { $('tapNotice').hidden = true; reconcile(true); if (player) player.play(); });

  // ---------- управление ----------
  function localPos() { return player && player.ready() ? player.time() : expectedPos(); }
  function togglePlay() {
    if (!S || !S.source) return;
    socket.emit('control', { action: S.playing ? 'pause' : 'play', position: S.playing ? localPos() : expectedPos() });
  }
  $('playBtn').addEventListener('click', togglePlay);
  $('screenShield').addEventListener('click', togglePlay);

  const seekInput = $('seekInput');
  seekInput.addEventListener('input', () => {
    seeking = true;
    const d = player ? player.duration() : 0;
    const t = (seekInput.value / 1000) * d;
    $('seekFill').style.width = (seekInput.value / 10) + '%';
    $('timeCur').textContent = fmt(t);
    const tip = $('seekTip'); tip.hidden = false; tip.textContent = fmt(t); tip.style.left = (seekInput.value / 10) + '%';
  });
  seekInput.addEventListener('change', () => {
    const d = player ? player.duration() : 0;
    if (d) socket.emit('control', { action: 'seek', position: (seekInput.value / 1000) * d });
    seeking = false; $('seekTip').hidden = true;
  });
  $('rateSelect').addEventListener('change', (e) => socket.emit('control', { action: 'rate', rate: Number(e.target.value) }));

  document.addEventListener('keydown', (e) => {
    if ($('room').hidden || e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space' || e.key === 'k' || e.key === 'л') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!S || !S.source) return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 10 : -10;
      socket.emit('control', { action: 'seek', position: Math.max(0, localPos() + delta) });
    } else if (e.key === 'f' || e.key === 'а') toggleFs();
  });

  // громкость фильма — у каждого своя
  let vol = store.get('vol', 0.9), volMuted = false;
  $('volInput').value = Math.round(vol * 100);
  function applyVolume() {
    if (player) player.setVolume(vol, volMuted);
    else { video.volume = vol; video.muted = volMuted; }
    $('volInput').closest('.vol').classList.toggle('muted', volMuted || vol === 0);
  }
  $('volInput').addEventListener('input', (e) => { vol = e.target.value / 100; volMuted = false; store.set('vol', vol); applyVolume(); });
  $('muteVideoBtn').addEventListener('click', () => { volMuted = !volMuted; applyVolume(); });

  function toggleFs() {
    const stage = $('stage');
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => { if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); });
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  }
  $('fsBtn').addEventListener('click', toggleFs);

  // прогресс
  function tick() {
    if (player && player.ready() && !seeking) {
      const t = player.time(), d = player.duration();
      $('timeCur').textContent = fmt(t);
      $('timeDur').textContent = fmt(d);
      const pct = d ? Math.min(100, (t / d) * 100) : 0;
      $('seekFill').style.width = pct + '%';
      $('seekInput').value = Math.round(pct * 10);
      $('seekBuf').style.width = (d ? Math.min(100, (player.buffered() / d) * 100) : 0) + '%';
    } else if (!player && !seeking) {
      $('timeCur').textContent = fmt(expectedPos());
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- выбор источника ----------
  $('sourceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const src = parseSource($('sourceInput').value);
    if (!src) { toast('Не похоже на ссылку. Вставьте адрес ролика YouTube или Rutube либо прямую ссылку на видеофайл.', 4500); return; }
    if (src.error) { toast(src.error, 6500); return; }
    socket.emit('source', src);
    $('sourceInput').value = '';
  });
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    localFile = f;
    if (pickForRoom && S && S.source && S.source.type === 'file') {
      pickForRoom = false;
      if (f.name !== S.source.title) toast(`У вас «${f.name}», а в комнате «${S.source.title}». Если это то же видео — всё в порядке.`, 5000);
      currentKey = null;
      loadSource(S.source);
    } else {
      pickForRoom = false;
      socket.emit('source', { type: 'file', title: f.name, size: f.size });
    }
  });
  $('fileNoticeBtn').addEventListener('click', () => { pickForRoom = true; $('fileInput').click(); });

  // ---------- реакции ----------
  $('reactionBar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]');
    if (b) socket.emit('reaction', b.dataset.r);
  });
  socket.on('reaction', ({ emoji }) => {
    const el = document.createElement('span');
    el.className = 'float-r'; el.textContent = emoji;
    el.style.left = (8 + Math.random() * 84) + '%';
    $('reactionsLayer').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  });

  // ---------- чат ----------
  const chatList = $('chatList');
  function msgEl(m) {
    const li = document.createElement('li');
    if (m.system) { li.className = 'msg system'; li.textContent = m.text; return li; }
    li.className = 'msg';
    li.style.setProperty('--c', m.color);
    const head = document.createElement('div'); head.className = 'msg-head';
    const n = document.createElement('span'); n.className = 'msg-name'; n.textContent = m.name;
    const t = document.createElement('span'); t.className = 'msg-time'; t.textContent = clock(m.at);
    head.append(n, t);
    const body = document.createElement('div'); body.className = 'msg-text'; body.textContent = m.text;
    li.append(head, body);
    return li;
  }
  function nearBottom() { return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80; }
  function renderChat(list) {
    chatList.replaceChildren(...list.map(msgEl));
    chatList.scrollTop = chatList.scrollHeight;
  }
  socket.on('chat', (m) => {
    const stick = nearBottom() || m.from === me?.id;
    chatList.appendChild(msgEl(m));
    while (chatList.children.length > 300) chatList.firstChild.remove();
    if (stick) chatList.scrollTop = chatList.scrollHeight;
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (!v) return;
    socket.emit('chat', v);
    $('chatInput').value = '';
  });

  // ---------- участники ----------
  const ICON_MIC = '<svg viewBox="0 0 24 24" class="mic-on"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const ICON_MIC_OFF = '<svg viewBox="0 0 24 24" class="mic-off"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  socket.on('users', (list) => { users = list; renderUsers(); });

  function renderUsers() {
    $('userCount').textContent = users.length;
    const ul = $('userList');
    ul.replaceChildren(...users.map((u) => {
      const li = document.createElement('li');
      li.className = 'user'; li.dataset.id = u.id;
      if (speaking.has(u.id)) li.classList.add('speaking');
      const av = document.createElement('span'); av.className = 'avatar'; av.style.setProperty('--c', u.color);
      av.textContent = (u.name.trim()[0] || '?').toUpperCase();
      const nm = document.createElement('span'); nm.className = 'user-name'; nm.textContent = u.name;
      if (u.id === me?.id) { const y = document.createElement('span'); y.className = 'you'; y.textContent = '(вы)'; nm.appendChild(y); }
      const st = document.createElement('span'); st.className = 'user-state';
      if (u.inVoice) {
        const peer = voice.peers.get(u.id);
        if (peer && u.id !== me?.id) {
          const r = document.createElement('input');
          r.type = 'range'; r.min = 0; r.max = 100; r.value = Math.round(peer.audio.volume * 100);
          r.className = 'peer-vol'; r.title = `Громкость: ${u.name}`; r.setAttribute('aria-label', `Громкость голоса ${u.name}`);
          r.addEventListener('input', () => { peer.audio.volume = r.value / 100; });
          st.appendChild(r);
        }
        st.insertAdjacentHTML('beforeend', u.muted ? ICON_MIC_OFF : ICON_MIC);
      }
      li.append(av, nm, st);
      return li;
    }));
  }

  // ---------- голосовой чат (WebRTC, каждый с каждым) ----------
  const voice = { stream: null, peers: new Map(), wanted: false, muted: false };
  const speaking = new Set();
  let audioCtx = null;
  const analysers = new Map(); // id -> analyser

  function voiceUi() {
    const on = !!voice.stream;
    $('voiceJoinBtn').hidden = on;
    $('micBtn').hidden = !on;
    $('voiceLeaveBtn').hidden = !on;
    $('micBtn').textContent = voice.muted ? 'Вкл. микрофон' : 'Выкл. микрофон';
  }

  $('voiceJoinBtn').addEventListener('click', async () => {
    $('voiceError').hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      showVoiceError('Браузер не даёт доступ к микрофону. Откройте сайт по https:// в Chrome, Firefox, Edge или Safari.');
      return;
    }
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      showVoiceError(err.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён. Разрешите его в настройках сайта (значок замка в адресной строке).' : 'Микрофон не найден или занят другой программой.');
      return;
    }
    voice.wanted = true; voice.muted = false;
    ensureAudioCtx();
    watchLevel(me.id, voice.stream);
    voiceUi();
    rejoinVoice();
  });

  function rejoinVoice() {
    if (!voice.stream) return;
    socket.emit('voice-join', (res) => {
      for (const id of res.peers) createPeer(id, true);
      if (voice.muted) socket.emit('voice-mute', true);
      renderUsers();
    });
  }

  $('voiceLeaveBtn').addEventListener('click', () => {
    voice.wanted = false;
    socket.emit('voice-leave');
    closeAllPeers();
    if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop());
    voice.stream = null;
    stopLevel(me.id);
    voiceUi(); renderUsers();
  });

  $('micBtn').addEventListener('click', () => {
    voice.muted = !voice.muted;
    voice.stream?.getAudioTracks().forEach((t) => { t.enabled = !voice.muted; });
    socket.emit('voice-mute', voice.muted);
    voiceUi();
  });

  function showVoiceError(t) { $('voiceError').textContent = t; $('voiceError').hidden = false; }

  function createPeer(id, initiator) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers });
    const audio = new Audio();
    audio.autoplay = true; audio.playsInline = true;
    $('audioSink').appendChild(audio);
    const peer = { pc, audio, initiator, pending: [], makingOffer: false };
    voice.peers.set(id, peer);

    voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(() => {});
      watchLevel(id, stream);
      renderUsers();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        const u = users.find((x) => x.id === id);
        toast(`Не получается соединиться голосом с ${u ? u.name : 'участником'}. Помогает TURN-сервер — см. README.`, 6000);
        if (initiator) pc.restartIce();
      }
    };
    pc.onnegotiationneeded = async () => {
      if (!peer.initiator) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
      } catch (err) { console.error(err); } finally { peer.makingOffer = false; }
    };
    return peer;
  }

  socket.on('signal', async ({ from, data }) => {
    if (!voice.stream) return;
    let peer = voice.peers.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (peer && (peer.makingOffer || peer.pc.signalingState !== 'stable')) {
            // встречные предложения: уступает тот, у кого id «меньше»
            const polite = me.id < from;
            if (!polite) return;
            await peer.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
            peer.initiator = false;
          }
          if (!peer) peer = createPeer(from, false);
          await peer.pc.setRemoteDescription(data.sdp);
          await peer.pc.setLocalDescription();
          socket.emit('signal', { to: from, data: { sdp: peer.pc.localDescription } });
        } else if (peer) {
          await peer.pc.setRemoteDescription(data.sdp);
        }
        if (peer) { for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {}); peer.pending = []; }
      } else if (data.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (err) { console.error('signal', err); }
  });

  socket.on('voice-left', (id) => { closePeer(id); renderUsers(); });

  function closePeer(id) {
    const p = voice.peers.get(id);
    if (!p) return;
    p.pc.close(); p.audio.srcObject = null; p.audio.remove();
    voice.peers.delete(id);
    stopLevel(id);
  }
  function closeAllPeers() { for (const id of [...voice.peers.keys()]) closePeer(id); }

  // индикатор «говорит»
  function ensureAudioCtx() {
    if (!audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (C) audioCtx = new C(); }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function watchLevel(id, stream) {
    ensureAudioCtx();
    if (!audioCtx) return;
    stopLevel(id);
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      analysers.set(id, { an, src, buf: new Float32Array(an.fftSize) });
    } catch { /* ignore */ }
  }
  function stopLevel(id) {
    const a = analysers.get(id);
    if (a) { try { a.src.disconnect(); } catch { /* ignore */ } analysers.delete(id); }
    speaking.delete(id);
  }
  setInterval(() => {
    let changed = false;
    for (const [id, a] of analysers) {
      a.an.getFloatTimeDomainData(a.buf);
      let sum = 0; for (const v of a.buf) sum += v * v;
      const rms = Math.sqrt(sum / a.buf.length);
      const muted = id === me?.id ? voice.muted : users.find((u) => u.id === id)?.muted;
      const on = rms > 0.025 && !muted;
      if (on !== speaking.has(id)) { on ? speaking.add(id) : speaking.delete(id); changed = true; }
    }
    if (changed) document.querySelectorAll('.user').forEach((li) => li.classList.toggle('speaking', speaking.has(li.dataset.id)));
  }, 120);

  window.addEventListener('beforeunload', () => { if (voice.stream) socket.emit('voice-leave'); });
})();
