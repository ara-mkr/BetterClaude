/**
 * In-app update banner — DOM-only, no Node/Electron APIs, so a browser
 * extension could mount it against a different transport unchanged (same
 * contract as core/skill-marketplace.js and core/prompt-picker.js).
 *
 * The host supplies every side effect:
 *   onDownload()        -> begin downloading the pending update
 *   onInstall()         -> quit + install the downloaded update
 *   onDismiss(version)  -> remember "Later" for THIS version
 *   onOpenReleases()    -> open the GitHub Releases page (error fallback)
 *
 * Deliberately NOT a native dialog: main.js keeps electron-updater silent
 * and broadcasts state instead, and this is the only surface that
 * interrupts — so an update never yanks focus with an OS-level modal.
 */

const BANNER_ID = "betterclaude-update-banner";

class UpdateBanner {
  constructor({ onDownload, onInstall, onDismiss, onOpenReleases } = {}) {
    this.onDownload = onDownload || (() => {});
    this.onInstall = onInstall || (() => {});
    this.onDismiss = onDismiss || (() => {});
    this.onOpenReleases = onOpenReleases || (() => {});
    this.el = null;
    // Set only while the user is looking at a check they triggered by hand:
    // a background check that quietly fails must never raise the banner.
    this.showErrors = false;
    this.status = { state: "idle" };
    this.dismissedVersion = null;
  }

  mount() {
    if (this.el) return this.el;
    const node = document.createElement("div");
    node.id = BANNER_ID;
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
    this.el = node;
    return node;
  }

  destroy() {
    if (this.el) this.el.remove();
    this.el = null;
  }

  // Called on every betterclaude:update-status broadcast, and again
  // whenever settings change (dismissedVersion may have moved).
  update(status, { dismissedVersion = null } = {}) {
    this.status = status || { state: "idle" };
    this.dismissedVersion = dismissedVersion;
    this.render();
  }

  // A manual "Check now" opts this session into seeing failures inline;
  // background checks stay silent so a flaky network can't nag.
  setShowErrors(value) {
    this.showErrors = !!value;
  }

  _shouldShow() {
    const { state, version } = this.status;
    if (state === "available") return version !== this.dismissedVersion;
    if (state === "downloading" || state === "downloaded") return true;
    if (state === "error") return this.showErrors;
    return false;
  }

  render() {
    if (!this.el) return;
    if (!this._shouldShow()) {
      this.el.classList.remove("bc-open");
      this.el.innerHTML = "";
      return;
    }

    const { state, version, notes, percent, error } = this.status;
    this.el.innerHTML = "";
    this.el.classList.add("bc-open");

    const text = document.createElement("div");
    text.className = "bc-update-text";

    const title = document.createElement("strong");
    const blurb = document.createElement("span");
    blurb.className = "bc-update-blurb";

    if (state === "error") {
      title.textContent = "Update check failed";
      blurb.textContent = error || "Couldn't reach the update server.";
    } else if (state === "downloaded") {
      title.textContent = `Version ${version || ""} ready`.trim();
      blurb.textContent = "Restart to finish installing.";
    } else if (state === "downloading") {
      title.textContent = `Downloading v${version || ""}`.trim();
      blurb.textContent = `${percent || 0}%`;
    } else {
      title.textContent = `Update available: v${version}`;
      // textContent, never innerHTML — `notes` is a GitHub release body,
      // i.e. text this app does not author.
      blurb.textContent = notes || "New version available";
    }

    text.appendChild(title);
    text.appendChild(blurb);
    this.el.appendChild(text);

    if (state === "downloading") {
      const track = document.createElement("div");
      track.className = "bc-update-progress";
      const fill = document.createElement("div");
      fill.className = "bc-update-progress-fill";
      fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
      track.appendChild(fill);
      this.el.appendChild(track);
    }

    const actions = document.createElement("div");
    actions.className = "bc-update-actions";

    if (state === "available") {
      actions.appendChild(this._button("Download & Install", "bc-update-primary", () => this.onDownload()));
      actions.appendChild(this._button("Later", "bc-update-ghost", () => {
        this.onDismiss(version);
        this.dismissedVersion = version;
        this.render();
      }));
    } else if (state === "downloaded") {
      actions.appendChild(this._button("Restart & Install", "bc-update-primary", () => this.onInstall()));
      actions.appendChild(this._button("Later", "bc-update-ghost", () => {
        // A downloaded update applies on the next manual restart anyway, so
        // "Later" here only needs to hide the banner for this session.
        this.status = { state: "idle" };
        this.render();
      }));
    } else if (state === "error") {
      actions.appendChild(this._button("Open Releases", "bc-update-primary", () => this.onOpenReleases()));
      actions.appendChild(this._button("Dismiss", "bc-update-ghost", () => {
        this.showErrors = false;
        this.render();
      }));
    }

    if (actions.childNodes.length) this.el.appendChild(actions);
  }

  _button(label, className, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `bc-update-btn ${className}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }
}

module.exports = { UpdateBanner, BANNER_ID };
