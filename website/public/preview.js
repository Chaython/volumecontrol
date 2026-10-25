(() => {
  const $ = id => document.getElementById(id);
  const slider = $('volume-slider');
  const volumeText = $('volume-text');
  const muteButton = $('mute-btn');
  const muteLabel = muteButton && muteButton.querySelector('.mute-label');
  const banner = $('preview-banner');
  const originalBanner = banner ? banner.textContent : '';
  const normalize = $('normalizer-checkbox');
  const normalizeDetails = $('normalizer-details');
  const normalizeGain = $('normalizer-gain');
  const peakFill = $('peak-meter-fill');
  const peakText = $('peak-meter-text');
  let muted = false;
  let normalizeOn = false;

  function setSwitch(id, value) {
    const el = $(id);
    if (el) el.checked = Boolean(value);
  }
  function getDb() {
    const n = Number(slider.value);
    return Math.max(-32, Math.min(32, Number.isFinite(n) ? Math.round(n) : 0));
  }
  function displayDb() {
    const db = getDb();
    volumeText.value = db > 0 ? '+' + db : String(db);
    slider.value = String(db);
    $('volume-boost-warning').classList.toggle('hidden', db < 6);
    updateMeter();
  }
  function updateMeter() {
    if (!normalizeOn) return;
    const db = getDb();
    const simulatedGain = Math.max(-18, Math.min(12, -db * .25));
    normalizeGain.textContent = 'Gain ' + (simulatedGain >= 0 ? '+' : '') + simulatedGain.toFixed(1) + ' dB';
    const peak = muted ? -60 : Math.min(0, -12 + db * .35);
    peakText.textContent = muted ? '−∞ dBFS' : (peak <= -59 ? '−∞' : peak.toFixed(1)) + ' dBFS';
    const pct = muted ? 0 : Math.max(0, Math.min(100, (peak + 60) / 60 * 100));
    peakFill.style.width = pct + '%';
    const meter = peakFill.parentElement;
    meter.setAttribute('aria-valuenow', String(peak));
  }
  function updateMute() {
    muteButton.setAttribute('aria-pressed', String(muted));
    muteButton.classList.toggle('muted', muted);
    if (muteLabel) muteLabel.textContent = muted ? 'Unmute' : 'Mute';
    if ($('volume-limit-note')) $('volume-limit-note').classList.toggle('hidden', false);
    updateMeter();
  }
  slider.addEventListener('input', displayDb);
  volumeText.addEventListener('change', () => {
    const value = volumeText.value.trim();
    if (!/^[+-]?\d+$/.test(value)) { displayDb(); return; }
    slider.value = String(Math.max(-32, Math.min(32, Number(value))));
    displayDb();
  });
  muteButton.addEventListener('click', () => { muted = !muted; updateMute(); });
  normalize.addEventListener('change', () => {
    normalizeOn = normalize.checked;
    if (normalizeDetails) normalizeDetails.hidden = !normalizeOn;
    if (banner) banner.textContent = normalizeOn ? 'Preview mode · Normalize enabled (display is simulated; no site audio)' : originalBanner;
    updateMeter();
  });
  $('mono-checkbox').addEventListener('change', event => {
    if (banner) banner.textContent = 'Preview mode · Mono ' + (event.target.checked ? 'enabled' : 'disabled') + ' (simulated)';
  });
  $('remember-checkbox').addEventListener('change', event => {
    if (banner) banner.textContent = 'Preview mode · Remember ' + (event.target.checked ? 'enabled' : 'disabled') + ' (not saved)';
  });
  $('enable-checkbox').addEventListener('change', event => {
    const active = event.target.checked;
    $('popup-content').style.opacity = active ? '1' : '.55';
    if (banner) banner.textContent = active ? originalBanner : 'Preview mode · extension disabled for this simulated site';
  });
  $('settings').addEventListener('click', () => {
    if (banner) banner.textContent = 'Options are available in the installed extension; this website cannot open extension settings.';
  });
  displayDb();
  updateMute();
})();
