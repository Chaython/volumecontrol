function listenForEvents() {
  let currentVolume = 0;

  function err(error) {
    console.error(`Volume Control: Error: ${error}`);
  }

  function formatValue(dB) {
    return `${dB >= 0 ? '+' : ''}${dB} dB`;
  }

  function setVolume(dB) {
    const slider = document.querySelector("#volume-slider");
    const text = document.querySelector("#volume-text");
    slider.value = dB;
    text.value = formatValue(dB);
    currentVolume = dB;
    browser.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        browser.tabs.sendMessage(tabs[0].id, { command: "setVolume", dB });
      })
      .catch(err);
  }

  function updateVolume() {
    const slider = document.querySelector("#volume-slider");
    const text = document.querySelector("#volume-text");
    text.value = formatValue(slider.value);
  }

  function updateVolumeFromText() {
    const text = document.querySelector("#volume-text");
    const dB = text.value.match(/-?\d+/)?.[0];
    if (dB !== undefined) {
      const slider = document.querySelector("#volume-slider");
      slider.value = dB;
      updateVolume();
      setVolume(dB);
      text.setSelectionRange(text.selectionStart, text.selectionEnd);
    }
  }

  function updateVolumeFromSlider() {
    const slider = document.querySelector("#volume-slider");
    updateVolume();
    setVolume(slider.value);
  }

  function toggleMono() {
    const monoCheckbox = document.querySelector("#mono-checkbox");
    const mono = monoCheckbox.checked;
    browser.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        browser.tabs.sendMessage(tabs[0].id, { command: "setMono", mono });
      })
      .catch(err);
  }

  function handleInputChange(event) {
    if (event.target.id === "volume-text") {
      updateVolumeFromText();
    } else if (event.target.id === "volume-slider") {
      updateVolumeFromSlider();
    } else if (event.target.id === "mono-checkbox") {
      toggleMono();
    }
  }

  function showError(error) {
    const popupContent = document.querySelector("#popup-content");
    const errorContent = document.querySelector("#error-content");
    popupContent.classList.add("hidden");
    errorContent.classList.remove("hidden");
    console.error(`Volume Control: Error: ${error.message}`);
  }

  browser.tabs.query({ active: true, currentWindow: true })
    .then(tabs => {
      if (tabs.length === 0) {
        showError("No audio playing.");
        return;
      }
      browser.tabs.executeScript({ file: "cs.js" })
        .then(() => {
          const volumeSlider = document.querySelector("#volume-slider");
          const volumeText = document.querySelector("#volume-text");
          const monoCheckbox = document.querySelector("#mono-checkbox");

          volumeSlider.addEventListener("input", updateVolumeFromSlider);
          volumeSlider.addEventListener("change", updateVolumeFromSlider);
          volumeText.addEventListener("input", updateVolumeFromText);
          monoCheckbox.addEventListener("change", toggleMono);
          document.addEventListener("change", handleInputChange);

          volumeSlider.focus();

          browser.tabs.sendMessage(tabs[0].id, { command: "getVolume" })
            .then(response => {
              setVolume(response.response);
            })
            .catch(err);

          browser.tabs.sendMessage(tabs[0].id, { command: "getMono" })
            .then(response => {
              monoCheckbox.checked = response.response;
            })
            .catch(err);
        })
        .catch(showError);
    })
    .catch(showError);
}

document.addEventListener("DOMContentLoaded", listenForEvents);
