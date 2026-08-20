/**
 * Settings -> Clipboard Bridge. Cross-Device Clipboard Bridge: off by
 * default, syncs the OS clipboard between BetterClaude instances through a
 * relay (self-hosted reference implementation: scripts/clipboard-relay-
 * server.js, or any HTTP endpoint speaking the same tiny put/pull
 * protocol). Everything is end-to-end encrypted client-side from a shared
 * passphrase (core/clipboard-bridge.js) before it ever reaches the relay —
 * the relay only ever sees ciphertext. Connection status is polled live by
 * electron/main.js and mirrored here, never silent.
 */

const { el, toggleField, textField, rangeField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

const STATUS_LABELS = {
  idle: { dot: "#6b7280", text: "Disconnected" },
  connecting: { dot: "#f59e0b", text: "Connecting…" },
  connected: { dot: "#22c55e", text: "Connected" },
  error: { dot: "#ef4444", text: "Error" },
};

module.exports = {
  _renderClipboardBridge() {
    const { settings } = this;
    const cb = settings.clipboardBridge;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Clipboard Bridge" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default. Copy something on one device and it's paste-ready on another within a short TTL — "
        + "synced through a relay you point at yourself (self-hosted or any endpoint speaking the same protocol; "
        + "see scripts/clipboard-relay-server.js for a minimal reference server). Everything is encrypted on this "
        + "device before it's ever sent, using a key derived from the passphrase below — the relay only ever sees "
        + "ciphertext, never your clipboard contents or the passphrase itself. Nothing syncs until you enable this "
        + "and fill in both fields.",
    }));

    wrap.appendChild(toggleField("Enable Clipboard Bridge", cb.enabled, (v) => this._set("clipboardBridge.enabled", v)));

    const statusBox = el("div", { class: "bc-master-toggle" });
    wrap.appendChild(statusBox);
    this._renderClipboardBridgeStatus(statusBox);
    if (this.host.onClipboardBridgeStatus) {
      this.host.onClipboardBridgeStatus(() => {
        if (this.activeSection === "Clipboard Bridge") this._renderClipboardBridgeStatus(statusBox);
      });
    }

    wrap.appendChild(textField(
      "Relay URL",
      cb.relayUrl,
      (v) => this._set("clipboardBridge.relayUrl", v.trim()),
      { placeholder: "https://your-relay.example.com" }
    ));
    wrap.appendChild(textField(
      "Passphrase",
      cb.passphrase,
      (v) => this._set("clipboardBridge.passphrase", v),
      { placeholder: "Shared secret — never sent to the relay, only used to derive the encryption key" }
    ));
    wrap.appendChild(textField(
      "Device name",
      cb.deviceName,
      (v) => this._set("clipboardBridge.deviceName", v.trim()),
      { placeholder: "Shown in sync notifications on other devices (defaults to hostname)" }
    ));

    wrap.appendChild(rangeField("Poll interval", {
      min: 3, max: 60, step: 1, value: cb.pollIntervalSeconds,
      format: (v) => `${v}s`,
      onInput: (v) => this._set("clipboardBridge.pollIntervalSeconds", v),
    }));
    wrap.appendChild(rangeField("Item TTL on relay", {
      min: 1, max: 60, step: 1, value: cb.ttlMinutes,
      format: (v) => `${v}m`,
      onInput: (v) => this._set("clipboardBridge.ttlMinutes", v),
    }));

    const actions = el("div", { class: "bc-theme-toolbar" });
    const testBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Test connection",
      onclick: async () => {
        testBtn.disabled = true;
        testBtn.textContent = "Testing…";
        try {
          await this.host.testClipboardBridgeConnection();
          this.host.notify && this.host.notify("Relay reachable.");
        } catch (err) {
          this.host.notify && this.host.notify(`Test failed: ${err.message}`);
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = "Test connection";
        }
      },
    });
    const pushBtn = el("button", {
      class: "bc-btn",
      text: "Push clipboard now",
      onclick: async () => {
        pushBtn.disabled = true;
        try {
          await this.host.pushClipboardNow();
        } catch (err) {
          this.host.notify && this.host.notify(`Push failed: ${err.message}`);
        } finally {
          pushBtn.disabled = false;
        }
      },
    });
    actions.appendChild(testBtn);
    actions.appendChild(pushBtn);
    wrap.appendChild(actions);

    this.contentEl.appendChild(wrap);
  },

  _renderClipboardBridgeStatus(box) {
    if (!this.host.getClipboardBridgeStatus) return;
    const status = this.host.getClipboardBridgeStatus();
    const meta = STATUS_LABELS[status.state] || STATUS_LABELS.idle;
    box.innerHTML = "";
    const info = el("div", {});
    const dot = el("span", {});
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${meta.dot};margin-right:6px;`;
    const headline = el("strong", {}, [dot, el("span", { text: meta.text })]);
    info.appendChild(headline);
    info.appendChild(el("span", {
      text: status.state === "error"
        ? `Last error: ${status.lastError} — last synced ${formatWhen(status.lastSyncedAt)}`
        : `Last synced: ${formatWhen(status.lastSyncedAt)}`,
    }));
    box.appendChild(info);
  },
};
