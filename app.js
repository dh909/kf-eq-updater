import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.6.0/bundle.js";

const PORT_FILTERS = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523 },
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 },
];

const NORMAL_BOOT_RESET_SEQUENCE = "D0|R1|W100|D0|R0|W500|D0";

const releaseList = document.querySelector("#release-list");
const browserStatus = document.querySelector("#browser-status");
const deviceTitle = document.querySelector("#device-section-title");
const deviceMeta = document.querySelector("#device-meta");
const selectDeviceButton = document.querySelector("#select-device");
const flashButton = document.querySelector("#flash-button");
const flashButtonVersion = document.querySelector("#flash-button-version");
const flashMessage = document.querySelector("#flash-message");
const installModal = document.querySelector("#install-modal");
const installModalTitle = document.querySelector("#install-modal-title");
const installModalMessage = document.querySelector("#install-modal-message");
const installModalPercent = document.querySelector("#install-modal-percent");
const installProgressBar = document.querySelector("#install-progress-bar");
const installModalClose = document.querySelector("#install-modal-close");
const notesModal = document.querySelector("#release-notes-modal");
const notesModalTitle = document.querySelector("#notes-modal-title");
const notesModalContent = document.querySelector("#notes-modal-content");
const notesModalClose = document.querySelector("#notes-modal-close");
const notesModalBackdrop = document.querySelector("#notes-modal-backdrop");

let releases = [];
let selectedRelease = null;
let selectedPort = null;
let isFlashing = false;

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function appendArray(left, right) {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function patchTransportRead() {
  if (Transport.prototype.eqPressureToolReadPatch) {
    return;
  }

  Transport.prototype.eqPressureToolReadPatch = true;

  Transport.prototype.read = async function read(timeout) {
    let partialPacket = null;
    let isEscaping = false;

    while (true) {
      const startedAt = Date.now();
      let readBytes = new Uint8Array(0);

      while (Date.now() - startedAt < timeout) {
        if (this.buffer.length > 0) {
          readBytes = this.buffer;
          this.buffer = new Uint8Array(0);
          break;
        }

        await delay(1);
      }

      if (readBytes.length === 0) {
        const message = partialPacket === null
          ? "Serial data stream stopped."
          : "No serial data received.";
        if (this.tracing) {
          this.trace(message);
        }
        throw new Error(message);
      }

      if (this.tracing) {
        this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
      }

      for (let index = 0; index < readBytes.length; index += 1) {
        const byte = readBytes[index];

        if (partialPacket === null) {
          if (byte === this.SLIP_END) {
            partialPacket = new Uint8Array(0);
          } else {
            const skippedStart = index;
            while (index + 1 < readBytes.length && readBytes[index + 1] !== this.SLIP_END) {
              index += 1;
            }
            const skippedBytes = readBytes.slice(skippedStart, index + 1);
            if (this.tracing) {
              this.trace(`Skipped non-SLIP serial data: ${this.hexConvert(skippedBytes)}`);
            }
            this.detectPanicHandler(skippedBytes);
          }
        } else if (isEscaping) {
          isEscaping = false;
          if (byte === this.SLIP_ESC_END) {
            partialPacket = appendArray(partialPacket, new Uint8Array([this.SLIP_END]));
          } else if (byte === this.SLIP_ESC_ESC) {
            partialPacket = appendArray(partialPacket, new Uint8Array([this.SLIP_ESC]));
          } else {
            throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
          }
        } else if (byte === this.SLIP_ESC) {
          isEscaping = true;
        } else if (byte === this.SLIP_END) {
          if (index + 1 < readBytes.length) {
            this.buffer = appendArray(readBytes.slice(index + 1), this.buffer);
          }
          return partialPacket;
        } else {
          partialPacket = appendArray(partialPacket, new Uint8Array([byte]));
        }
      }
    }
  };
}

function setBrowserStatus() {
  if (!window.isSecureContext) {
    browserStatus.hidden = false;
    browserStatus.textContent = "Use HTTPS or localhost";
    browserStatus.dataset.state = "warning";
    return false;
  }

  if (!("serial" in navigator)) {
    browserStatus.hidden = false;
    browserStatus.textContent = "Use Chrome or Edge";
    browserStatus.dataset.state = "warning";
    return false;
  }

  browserStatus.hidden = true;
  browserStatus.textContent = "";
  browserStatus.dataset.state = "ready";
  return true;
}

function renderEmpty(message) {
  releaseList.innerHTML = "";
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  releaseList.append(empty);
}

function releaseTitle(release) {
  return release.version || release.title || "Firmware";
}

function releaseMeta(release) {
  if (!release.date) {
    return "";
  }

  const parts = String(release.date).split("-");
  if (parts.length !== 3) {
    return release.date;
  }

  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function releaseNotes(release) {
  if (Array.isArray(release.notes)) {
    return release.notes.filter(Boolean);
  }

  if (typeof release.notes === "string" && release.notes.trim()) {
    return release.notes
      .split(/\n{2,}/)
      .map((note) => note.trim())
      .filter(Boolean);
  }

  return [];
}

function getReleaseNotesContent(release) {
  const notes = releaseNotes(release);

  if (notes.length === 0) {
    return ["No release notes for this build."];
  }

  return notes;
}

function openReleaseNotes(release) {
  notesModalTitle.textContent = releaseTitle(release);
  notesModalContent.innerHTML = "";

  for (const note of getReleaseNotesContent(release)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = note;
    notesModalContent.append(paragraph);
  }

  notesModal.hidden = false;
  notesModalClose.focus();
}

function closeReleaseNotes() {
  notesModal.hidden = true;
}

function expandDemoReleases(nextReleases) {
  const requestedCount = Number.parseInt(new URLSearchParams(window.location.search).get("demo") || "", 10);
  if (!Number.isFinite(requestedCount) || requestedCount < 1 || nextReleases.length === 0) {
    return nextReleases;
  }

  const releaseCount = Math.min(requestedCount, 50);
  return Array.from({ length: releaseCount }, (_item, index) => {
    const source = nextReleases[index % nextReleases.length];
    const suffix = String(index + 1).padStart(2, "0");
    const version = index < nextReleases.length
      ? source.version
      : `${source.version}-preview-${suffix}`;

    return {
      ...source,
      version,
      title: version,
      recommended: index === 0,
      notes: `${source.notes || "Preview release."}\n\nLong-list preview row ${suffix}.`,
    };
  });
}

function setFlashMessage(message, state = "idle") {
  flashMessage.textContent = message;
  flashMessage.dataset.state = state;
  flashMessage.parentElement.hidden = !message || state === "idle" || state === "success";
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  installProgressBar.style.width = `${value}%`;
  installModalPercent.textContent = `${Math.round(value)}%`;
}

function showInstallModal(release) {
  installModalTitle.textContent = releaseTitle(release);
  installModalMessage.textContent = "Preparing firmware...";
  installModalClose.hidden = true;
  setProgress(0);
  installModal.hidden = false;
}

function updateInstallModal(message) {
  installModalMessage.textContent = message;
}

function finishInstallModal(message) {
  installModalMessage.textContent = message;
  installModalClose.hidden = false;
  installModalClose.focus();
}

function closeInstallModal() {
  installModal.hidden = true;
}

function getPortLabel(port) {
  const info = port.getInfo();
  if (info.usbVendorId === 0x1a86 && info.usbProductId === 0x7523) {
    return "EQ Pressure Tool (USB Serial)";
  }
  if (info.usbVendorId === 0x1a86 && info.usbProductId === 0x55d4) {
    return "EQ Pressure Tool (USB Serial)";
  }
  if (info.usbVendorId && info.usbProductId) {
    return `USB Serial (${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)})`;
  }
  return "USB Serial";
}

function matchesKnownDevice(port) {
  const info = port.getInfo();
  return PORT_FILTERS.some((filter) => (
    filter.usbVendorId === info.usbVendorId &&
    (!filter.usbProductId || filter.usbProductId === info.usbProductId)
  ));
}

function updateDeviceUi() {
  if (selectedPort) {
    deviceTitle.textContent = "Device selected";
    deviceMeta.textContent = getPortLabel(selectedPort);
    selectDeviceButton.textContent = "Change device";
  } else {
    deviceTitle.textContent = "No device selected";
    deviceMeta.textContent = "Select the USB device once.";
    selectDeviceButton.textContent = "Select device";
  }

  updateButtons();
}

function updateButtons() {
  const canUseSerial = "serial" in navigator && window.isSecureContext;
  selectDeviceButton.disabled = isFlashing || !canUseSerial;
  flashButton.disabled = isFlashing || !canUseSerial || !selectedRelease;
  flashButtonVersion.textContent = selectedRelease ? releaseTitle(selectedRelease) : "";
}

function selectRelease(release, row) {
  selectedRelease = release;

  for (const item of releaseList.querySelectorAll(".release-item")) {
    item.dataset.selected = "false";
    item.querySelector(".release-select")?.setAttribute("aria-pressed", "false");
  }

  row.dataset.selected = "true";
  row.querySelector(".release-select")?.setAttribute("aria-pressed", "true");
  updateButtons();
}

function renderReleases(nextReleases) {
  releases = expandDemoReleases(nextReleases);
  releaseList.innerHTML = "";

  for (const [index, release] of releases.entries()) {
    const row = document.createElement("article");
    row.className = "release-item";
    row.dataset.selected = "false";

    const line = document.createElement("div");
    line.className = "release-line";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "release-select";
    button.setAttribute("aria-pressed", "false");

    const copy = document.createElement("span");
    copy.className = "release-copy";

    const title = document.createElement("strong");
    title.className = "release-title";
    title.textContent = releaseTitle(release);

    const metaText = releaseMeta(release);
    copy.append(title);
    if (metaText) {
      const meta = document.createElement("span");
      meta.className = "release-meta";
      meta.textContent = metaText;
      copy.append(meta);
    }
    button.append(copy);

    const side = document.createElement("div");
    side.className = "release-side";

    const notesButton = document.createElement("button");
    notesButton.type = "button";
    notesButton.className = "notes-toggle";
    notesButton.textContent = "Notes";
    notesButton.addEventListener("click", () => {
      openReleaseNotes(release);
    });

    side.append(notesButton);
    button.addEventListener("click", () => selectRelease(release, row));
    line.append(button, side);
    row.append(line);
    releaseList.append(row);
  }

  const recommended = releases.find((release) => release.recommended) || releases[0];
  if (recommended) {
    const index = releases.indexOf(recommended);
    selectRelease(recommended, releaseList.querySelectorAll(".release-item")[index]);
  }
}

async function loadReleases() {
  try {
    const response = await fetch("releases.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Release list request failed with ${response.status}`);
    }

    const data = await response.json();
    const nextReleases = Array.isArray(data.releases) ? data.releases : [];

    if (nextReleases.length === 0) {
      renderEmpty("No firmware releases are configured for this flasher yet.");
      return;
    }

    renderReleases(nextReleases);
  } catch (error) {
    renderEmpty("Could not load the firmware release list.");
    console.error(error);
  }
}

async function scanRememberedDevice() {
  if (!("serial" in navigator)) {
    return;
  }

  const ports = await navigator.serial.getPorts();
  selectedPort = ports.find(matchesKnownDevice) || ports[0] || null;
  updateDeviceUi();

  if (selectedPort) {
    setFlashMessage("");
  }
}

async function selectDevice() {
  if (!("serial" in navigator)) {
    return;
  }

  try {
    selectedPort = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    updateDeviceUi();
    setFlashMessage("");
  } catch (error) {
    if (error?.name === "NotFoundError") {
      setFlashMessage("No device was selected.", "warning");
      return;
    }
    setFlashMessage(`Device selection failed: ${error.message || error}`, "error");
  }
}

async function loadManifest(release) {
  const manifestUrl = new URL(release.manifest, window.location.href);
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Manifest request failed with ${response.status}`);
  }

  const manifest = await response.json();
  const build = manifest.builds?.find((item) => item.chipFamily === "ESP32") || manifest.builds?.[0];
  if (!build?.parts?.length) {
    throw new Error("The selected release has no ESP32 firmware parts.");
  }

  return { manifest, manifestUrl, build };
}

async function loadFirmwareParts(release) {
  const { manifest, manifestUrl, build } = await loadManifest(release);
  const baseUrl = new URL(".", manifestUrl);
  const fileArray = [];

  for (const part of build.parts) {
    const partUrl = new URL(part.path, baseUrl);
    setFlashMessage(`Loading ${part.path}...`);
    updateInstallModal(`Loading ${part.path}...`);
    const response = await fetch(partUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${part.path} request failed with ${response.status}`);
    }

    fileArray.push({
      address: Number(part.offset),
      data: new Uint8Array(await response.arrayBuffer()),
    });
  }

  return { manifest, build, fileArray };
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  return error.message || String(error);
}

async function safeDisconnect(transport) {
  if (!transport) {
    return;
  }

  try {
    await transport.disconnect();
  } catch (error) {
    console.warn("Serial disconnect cleanup failed", error);
  }
}

async function flashFirmware() {
  if (isFlashing || !selectedRelease) {
    return;
  }

  if (!selectedPort) {
    await selectDevice();
    if (!selectedPort) {
      return;
    }
  }

  isFlashing = true;
  updateButtons();
  showInstallModal(selectedRelease);
  setProgress(0);
  setFlashMessage("Preparing firmware...");

  let transport = null;

  try {
    const { fileArray } = await loadFirmwareParts(selectedRelease);

    setFlashMessage("Connecting to device...");
    updateInstallModal("Connecting to device...");
    patchTransportRead();
    transport = new Transport(selectedPort, false);
    transport.setDeviceLostCallback(() => {
      setFlashMessage("Device disconnected.", "error");
    });

    const terminal = {
      clean() {},
      writeLine(message) {
        console.debug(message);
      },
      write(message) {
        console.debug(message);
      },
    };

    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal,
      debugLogging: false,
    });

    const chipName = await loader.main();
    setFlashMessage(`Connected to ${chipName}. Flashing...`);
    updateInstallModal(`Connected to ${chipName}. Flashing...`);

    await loader.writeFlash({
      fileArray,
      flashSize: "4MB",
      flashMode: "dio",
      flashFreq: "40m",
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        setProgress((written / total) * 100);
        updateInstallModal("Flashing firmware...");
      },
    });

    setFlashMessage("Resetting device...");
    updateInstallModal("Resetting device...");
    await loader.after("custom_reset", undefined, NORMAL_BOOT_RESET_SEQUENCE);
    setProgress(100);
    setFlashMessage("Firmware installed.", "success");
    finishInstallModal("Firmware installed.");
  } catch (error) {
    console.error(error);
    setFlashMessage(`Installation failed: ${formatError(error)}`, "error");
    finishInstallModal(`Installation failed: ${formatError(error)}`);
  } finally {
    await safeDisconnect(transport);
    isFlashing = false;
    updateButtons();
  }
}

selectDeviceButton.addEventListener("click", selectDevice);
flashButton.addEventListener("click", flashFirmware);
installModalClose.addEventListener("click", closeInstallModal);
notesModalClose.addEventListener("click", closeReleaseNotes);
notesModalBackdrop.addEventListener("click", closeReleaseNotes);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !installModal.hidden && !installModalClose.hidden) {
    closeInstallModal();
  }

  if (event.key === "Escape" && !notesModal.hidden) {
    closeReleaseNotes();
  }
});

setBrowserStatus();
updateDeviceUi();
loadReleases();
scanRememberedDevice().catch((error) => console.warn("Device scan failed", error));
