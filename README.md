# DNSCrypt Indicator (GNOME Shell Extension)

A top-bar indicator for **`dnscrypt-proxy`** on GNOME 45–50, companion to the [**DNSCrypt UI**](https://github.com/ajshovon/dnscrypt-ui) app.

## Features

- **Status that means something**: the icon shows whether dnscrypt-proxy is running *and* whether system DNS actually goes through it.
  - Running and protected: shield, server, or lock icon (your choice).
  - Running, but queries leak to other DNS servers: `security-low` warning icon, and the menu says where they leak.
  - Stopped, with system DNS pointing at it (nothing resolves): `network-error` icon.
  - Off, using your network's DNS: offline icon.
- **No polling**: service state comes from systemd and routing from systemd-resolved over D-Bus change signals. Nothing is spawned in the background.
- **Encrypted DNS switch**: with DNSCrypt UI's helper installed, off gives system DNS back to your network and then stops dnscrypt-proxy; on starts it and restores routing once it answers. Without the helper it starts and stops the service through systemd.
- **Knows when DNS is down**: if system DNS points at dnscrypt-proxy but it is not running, the icon and menu say so.
- **Restart** through systemd's D-Bus API with the normal GNOME authentication dialog.
- **Upstream latency**: sends an uncached query and measures the real encrypted round trip, not a cache hit. It can be shown in the panel (GNOME 46+).
- **Domain rules and resolvers** submenus, read from the active configuration only (commented examples are ignored).
- **Open DNSCrypt UI** for editing rules, resolvers, and fixing DNS leaks.

## Install

```bash
git clone https://github.com/ajshovon/gnome-dnscrypt-indicator.git
cd gnome-dnscrypt-indicator
./install.sh
```

On Wayland, log out and back in the first time, then:

```bash
gnome-extensions enable dnscrypt-indicator@local
```

## Preferences

`gnome-extensions prefs dnscrypt-indicator@local`, or **Extension Settings** in the menu:

- **Show DNS latency in top bar**
- **Latency refresh interval**: 10–600 seconds (only used for the panel latency)
- **Panel icon style**: shield, server, or lock
- **Config directory**: where `dnscrypt-proxy.toml` lives (default `/etc/dnscrypt-proxy`)

## License

[GPL-3.0-or-later](LICENSE)
