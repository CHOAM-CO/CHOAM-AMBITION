// Voice: Chrome Web Speech API (STT, ko-KR, continuous + interim, auto-restart) and speechSynthesis (TTS).
// Recognition is paused while the agent speaks so it does not transcribe itself.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voice {
  /** @param {{onState:(s:string)=>void, onInterim:(t:string)=>void, onSpeechStart:()=>void, onFinal:(t:string)=>void}} h */
  constructor(h) {
    this.h = h; this.state = SR ? 'off' : 'unsupported'; this.wanted = false; this.paused = false;
    this.rec = null; this.fails = 0; this.speaking = false; this.inSpeech = false; this.voice = null;
    h.onState(this.state);
    if ('speechSynthesis' in window) {
      const pick = () => { this.voice = Voice.pickVoice(speechSynthesis.getVoices()); };
      pick(); speechSynthesis.addEventListener('voiceschanged', pick);
    }
  }

  static pickVoice(voices) {
    const ko = voices.filter((v) => /^ko/i.test(v.lang));
    const score = (v) => (/premium|enhanced|neural|natural/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0) + (/yuna|sora|heami|sun-hi|seoyeon/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
    return ko.sort((a, b) => score(b) - score(a))[0] || null;
  }

  _set(s) { if (s !== this.state) { this.state = s; this.h.onState(s); } }

  /** call from a user gesture (the start click) so the mic permission prompt is allowed */
  start() {
    if (!SR) return;
    this.wanted = true; this._launch();
  }

  _launch() {
    if (!this.wanted || this.paused || this.rec) return;
    const r = this.rec = new SR();
    r.lang = 'ko-KR'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onstart = () => { this.fails = 0; this._set('on'); };
    r.onspeechstart = () => this._speechStart();
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = res[0].transcript;
        if (res.isFinal) { this.inSpeech = false; this.h.onFinal(t.trim()); }
        else { interim += t; this._speechStart(); }
      }
      if (interim) this.h.onInterim(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.wanted = false; this._set('error'); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') { this.fails++; if (this.fails > 5) { this.wanted = false; this._set('error'); } }
    };
    r.onend = () => {
      this.rec = null; this.inSpeech = false;
      if (this.wanted && !this.paused) setTimeout(() => this._launch(), 250 + this.fails * 500); // auto-restart
    };
    try { r.start(); } catch { this.rec = null; }
  }

  /** pause/resume recognition (webspeech mode) while the agent talks or the mic is muted */
  hold(on) { if (on) this._pause(); else this._resume(); }
  mute(on) { if (on) { this.wanted = false; this._pause(); this._set('off'); } else { this.wanted = true; this.paused = false; this._launch(); } }

  _speechStart() { if (!this.inSpeech) { this.inSpeech = true; this.h.onSpeechStart(); } }

  _pause() { this.paused = true; if (this.rec) { try { this.rec.abort(); } catch {} } }
  _resume() { this.paused = false; setTimeout(() => this._launch(), 300); }

  /** speak with the best ko-KR voice; resolves when done. Recognition is off meanwhile. */
  speak(text) {
    if (!('speechSynthesis' in window) || !text) return Promise.resolve();
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1.05;
      if (this.voice) u.voice = this.voice;
      const done = () => { clearTimeout(guard); this.speaking = false; this._resume(); resolve(); };
      const guard = setTimeout(done, 30000 + text.length * 120); // never hang if onend is lost
      u.onend = done; u.onerror = done;
      this.speaking = true; this._pause();
      speechSynthesis.speak(u);
    });
  }
}
