# DNSCrypt Indicator (GNOME Shell Extension)

A dedicated, lightweight **GNOME Shell top-bar extension** for **`dnscrypt-proxy`** on GNOME 45, 46, 47, 48, 49, and 50+.

It pairs with the standalone **DNSCrypt UI** application, giving you instant glanceability and quick toggles from the GNOME top bar.

---

## Features

- **Top-Bar Status Icon**:
  - Automatically updates icon color and shape based on `dnscrypt-proxy` service state (Active / Inactive).
  - Customizable icon style: Shield, Network Server, or System Lock.
- **Optional Panel Latency Display**:
  - Glance at your resolution ping (e.g. `14ms`) directly in the top panel.
- **Quick Service Toggle**:
  - One-click switch to start or stop `dnscrypt-proxy.service` via PolicyKit.
- **Instant DNS Ping / Benchmark**:
  - Click "Test Latency (127.0.0.1:53)" to measure resolution latency to local proxy in real time.
- **Split-DNS Domain Rules Submenu**:
  - Inspect your active domain forwarding rules (YogaDNS split-DNS rules) directly from the panel.
- **Active Resolvers Submenu**:
  - See which encrypted upstream DoH or DNSCrypt resolvers are currently in use.
- **Service Restart**:
  - 1-click service restart from the menu.
- **App Launcher**:
  - Shortcut to launch the full standalone **DNSCrypt UI** (`dnscrypt-ui`) to edit domain rules and inspect live logs.

---

## Installation

### 1. Install Extension
From this directory, run:
```bash
./install.sh
```

This compiles the GSettings schema and installs files to `~/.local/share/gnome-shell/extensions/dnscrypt-indicator@local`.

### 2. Activate in GNOME Shell
- **On Fedora Wayland**: Log out and log back in (or restart your session) so GNOME Shell discovers the newly installed extension.
- **On X11**: Press `Alt + F2`, type `r`, and press Enter.

Then enable it via terminal:
```bash
gnome-extensions enable dnscrypt-indicator@local
```
Or open the **Extensions** / **Extension Manager** app and toggle on **DNSCrypt Indicator**.

---

## Extension Preferences

Open the extension preferences via:
- The popup menu item **Extension Settings...**
- Or from terminal:
  ```bash
  gnome-extensions prefs dnscrypt-indicator@local
  ```

Settings available:
- **Show DNS Latency in Top Bar**: Display resolution milliseconds next to the panel icon.
- **Panel Icon Style**: Choose between Security Shield, Network Server, or System Lock.
- **Refresh Interval**: Customize polling frequency (2 to 60 seconds).
- **Configuration Directory**: Path to `dnscrypt-proxy.toml` and `forwarding-rules.txt` (default `/etc/dnscrypt-proxy`).
