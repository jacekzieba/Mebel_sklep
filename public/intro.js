'use strict';
/*
 * Intro promocyjne — film na pełnym ekranie przy pierwszym wejściu w danej sesji.
 * Zamknięcie (przycisk „Pomiń", Esc albo koniec materiału) odsłania konfigurator.
 *
 * Decyzja „pokazać czy nie" zapada synchronicznie w <head>, przed pierwszym
 * malowaniem strony — dzięki temu widz nie zobaczy ani mignięcia konfiguratora
 * pod filmem, ani mignięcia filmu przy powrocie na stronę.
 *
 * Bez JS klasa `intro-active` nigdy nie trafia na <html>, overlay pozostaje
 * ukryty w CSS i strona działa normalnie — nic jej nie zasłania.
 */
(function () {
  var SEEN_KEY = 'sobczak:intro-seen';
  var VIDEO_SRC = '/media/sobczak-promo.mp4';
  var POSTER_SRC = '/media/sobczak-promo.jpg';
  var STALL_MS = 8000;   // film nie ruszył w tym czasie → przepuszczamy widza dalej
  var FADE_MS = 520;     // musi odpowiadać transition na .intro w styles.css

  var root = document.documentElement;

  function hasSeen() {
    try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch (err) { return false; }
  }
  function markSeen() {
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (err) { /* tryb prywatny: pokaże się ponownie */ }
  }

  if (hasSeen()) return;
  root.classList.add('intro-active');

  // Plakat startuje już teraz, jeszcze zanim powstanie <body> — pierwsza klatka
  // jest na ekranie, zanim film zdąży się zbuforować.
  var preload = document.createElement('link');
  preload.rel = 'preload';
  preload.as = 'image';
  preload.href = POSTER_SRC;
  document.head.appendChild(preload);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  function setup() {
    var overlay = document.getElementById('intro');
    var video = document.getElementById('intro-video');
    var skipBtn = document.getElementById('intro-skip');
    var soundBtn = document.getElementById('intro-sound');
    var playBtn = document.getElementById('intro-play');
    var bar = document.getElementById('intro-bar');
    var behind = [document.querySelector('.topbar'), document.querySelector('.layout')];

    // Brakuje czegokolwiek → nie blokuj strony.
    if (!overlay || !video || !skipBtn) { root.classList.remove('intro-active'); return; }

    video.poster = POSTER_SRC;
    video.src = VIDEO_SRC;

    var closed = false;
    var detached = false;
    var stallTimer = 0;
    var userPaused = false;   // pauza z ręki widza — nie wznawiamy jej automatycznie

    // ---- zamykanie ----------------------------------------------------------
    function detach() {
      if (detached) return;
      detached = true;
      root.classList.remove('intro-leaving');
      overlay.remove();
      var heading = document.getElementById('panel-title');
      if (heading) heading.focus();
    }

    function close() {
      if (closed) return;
      closed = true;
      markSeen();
      window.clearTimeout(stallTimer);
      try { video.pause(); } catch (err) { /* nieodtworzone wideo — nic do zatrzymania */ }

      // Blokada przewijania znika od razu, sam overlay dopiero po wygaszeniu.
      root.classList.remove('intro-active');
      root.classList.add('intro-leaving');
      behind.forEach(function (node) { if (node) node.removeAttribute('inert'); });
      document.dispatchEvent(new CustomEvent('intro:end'));

      overlay.addEventListener('transitionend', function (e) {
        if (e.target === overlay && e.propertyName === 'opacity') detach();
      });
      window.setTimeout(detach, FADE_MS + 200);   // gdyby transitionend nie doszedł
    }

    // ---- treść pod spodem poza zasięgiem klawiatury i czytników ekranu ------
    behind.forEach(function (node) { if (node) node.setAttribute('inert', ''); });

    skipBtn.addEventListener('click', close);
    video.addEventListener('ended', close);
    video.addEventListener('error', close);   // brak pliku / niewspierany kodek
    document.addEventListener('keydown', function (e) {
      if (!closed && (e.key === 'Escape' || e.key === 'Esc')) close();
    });

    // ---- odtwarzanie --------------------------------------------------------
    function armStallTimer() {
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(close, STALL_MS);
    }

    function showPlayPrompt() {
      window.clearTimeout(stallTimer);   // czekamy na widza, nie na sieć
      overlay.classList.add('is-idle');
    }

    function start() {
      overlay.classList.remove('is-idle');
      var attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(showPlayPrompt);
    }

    video.addEventListener('playing', function () {
      window.clearTimeout(stallTimer);
      overlay.classList.remove('is-idle');
    });

    if (playBtn) playBtn.addEventListener('click', function () { userPaused = false; start(); });

    // Klik w kadr pauzuje i wznawia — pełnoekranowe wideo nie ma innego sterowania.
    video.addEventListener('click', function () {
      userPaused = !video.paused;
      if (video.paused) start();
      else video.pause();
    });

    // Wyciszone wideo w karcie otwartej w tle zostaje przez przeglądarkę wstrzymane.
    // Po powrocie do karty wznawiamy — chyba że to widz je zatrzymał.
    document.addEventListener('visibilitychange', function () {
      if (closed || userPaused) return;
      if (document.visibilityState === 'visible' && video.paused && !video.ended) start();
    });

    // Widz, który prosi o mniej ruchu, dostaje planszę i sam decyduje o starcie.
    var calmer = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (calmer && calmer.matches) {
      showPlayPrompt();
    } else {
      armStallTimer();
      start();
    }

    // ---- dźwięk -------------------------------------------------------------
    // Start jest wyciszony, bo przeglądarki blokują autoodtwarzanie z dźwiękiem.
    if (soundBtn) {
      var syncSound = function () {
        soundBtn.setAttribute('aria-pressed', String(!video.muted));
        soundBtn.querySelector('.intro-btn-label').textContent = video.muted ? 'Włącz dźwięk' : 'Wycisz';
      };
      soundBtn.addEventListener('click', function () {
        video.muted = !video.muted;
        syncSound();
      });
      syncSound();
    }

    // ---- pasek postępu ------------------------------------------------------
    if (bar) {
      video.addEventListener('timeupdate', function () {
        if (!video.duration) return;
        bar.style.transform = 'scaleX(' + (video.currentTime / video.duration) + ')';
      });
    }

    skipBtn.focus({ preventScroll: true });
  }
})();
