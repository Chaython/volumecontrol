document.querySelector("#volume-slider").focus();

function listenForEvents() {
	function err(error) {
		console.error(`Volume Control: Error: ${error}`);
	}

	function setSlider(dB) {
		document.querySelector("#volume-slider").value = dB;
		var text = document.querySelector("#volume-text");
		text.textContent = "";
		if (dB >= 0) {
			text.textContent = "+";
		}
		text.textContent += dB + " dB";
	}

	function getVolume(tabs) {
		browser.tabs.sendMessage(tabs[0].id, {
			command: "getVolume"
		}).then((message) => {
				setSlider(message.response);
		}).catch(err);
	}
	browser.tabs.query({active:true, currentWindow:true})
		.then(getVolume)
		.catch(err);

	document.addEventListener("input", (e) => {
		function sendVolume(tabs) {
			setSlider(e.target.value);
			browser.tabs.sendMessage(tabs[0].id, {
				command: "setVolume",
				dB: e.target.value
			});
		}

		if (e.target.id == "volume-slider") {
			browser.tabs.query({active:true, currentWindow:true})
				.then(sendVolume)
				.catch(err);
		}
	});

	function getMono(tabs) {
		browser.tabs.sendMessage(tabs[0].id, {
			command: "getMono"
		}).then((message) => {
			document.querySelector("#mono-checkbox").checked = message.response;
		}).catch(err);
	}
	browser.tabs.query({active:true, currentWindow:true})
		.then(getMono)
		.catch(err);

	document.addEventListener("change", (e) => {
		function sendMono(tabs) {
			browser.tabs.sendMessage(tabs[0].id, {
				command: "setMono",
				mono: e.target.checked
			});
		}

		if (e.target.id == "mono-checkbox") {
			browser.tabs.query({active:true, currentWindow:true})
				.then(sendMono)
				.catch(err);
		}
	});
}

function showError(error) {
	document.querySelector("#popup-content").classList.add("hidden");
	document.querySelector("#error-content").classList.remove("hidden");
	console.error(`Volume Control: Error: ${error.message}`);
}

browser.tabs.query({active:true, currentWindow:true, audible:true})
	.then(function(tabs) {
		if (tabs.length != 0) {
			browser.tabs.executeScript({file: "cs.js"})
			.then(listenForEvents)
			.catch(showError);
		} else {
			showError("No audio playing.");
		}
	})
	.catch(showError);
