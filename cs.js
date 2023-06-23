(function() {
  if (window.hasRun) {
    return;
  }
  window.hasRun = true;

  var dB = 0;
  var mono = false;

  var videoElements = document.querySelectorAll("video");
  var audioElements = document.querySelectorAll("audio");
  if (videoElements.length == 0 && audioElements.length == 0) {
    return;
  }
  var audioCtx = new AudioContext();
  var gainNode = audioCtx.createGain();
  gainNode.channelInterpretation = 'speakers';

  function connectOutput(element) {
    audioCtx.createMediaElementSource(element).connect(gainNode);
    gainNode.connect(audioCtx.destination);
  }
  videoElements.forEach(connectOutput);
  audioElements.forEach(connectOutput);

  function setVolume(dB) {
    gainNode.gain.value = Math.pow(10, dB/20);
  }

  function enableMono() {
    mono = true;
    gainNode.channelCountMode = 'explicit';
    gainNode.channelCount = 1;
  }

  function disableMono() {
    mono = false;
    gainNode.channelCountMode = 'max';
    gainNode.channelCount = 2;
  }

  browser.runtime.onMessage.addListener((message) => {
    switch (message.command) {
      case "setVolume":
        dB = message.dB;
        setVolume(dB);
        break;
      case "getVolume":
        return Promise.resolve({response: dB});
        break;
      case "setMono":
        if (message.mono) {
          enableMono();
        } else {
          disableMono();
        }
        break;
      case "getMono":
        return Promise.resolve({response: mono});
        break;
    }
  });
})();
