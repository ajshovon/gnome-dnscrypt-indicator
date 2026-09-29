import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

function runCommandAsync(argv) {
    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    const exitCode = p.get_exit_status();
                    resolve({ exitCode, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

const DNSCryptIndicator = GObject.registerClass(
class DNSCryptIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'DNSCrypt Indicator', false);

        this._extension = extension;
        this._settings = settings;
        this._timerId = 0;
        this._isActive = false;
        this._lastLatency = null;
        this._updatingSwitch = false;
        this._destroyed = false;

        this._buildPanelUI();
        this._buildMenu();

        // Connect settings signals
        this._settingsSignals = [
            this._settings.connect('changed::show-latency-in-panel', () => this._updatePanelLabel()),
            this._settings.connect('changed::icon-style', () => this._updatePanelIcon()),
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
        ];

        // Start background polling and load config
        this._checkStatus();
        this._loadConfig();
        this._restartTimer();
    }

    _buildPanelUI() {
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            reactive: true,
        });

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: this._getIconName(false),
        });
        this._panelBox.add_child(this._icon);

        this._latencyLabel = new St.Label({
            style_class: 'dnscrypt-panel-latency',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._latencyLabel);
        this._latencyLabel.visible = false;

        this.add_child(this._panelBox);
    }

    _getIconName(active) {
        const style = this._settings.get_string('icon-style') || 'shield';
        if (!active) {
            return 'network-offline-symbolic';
        }
        switch (style) {
            case 'network':
                return 'network-server-symbolic';
            case 'lock':
                return 'channel-secure-symbolic';
            case 'shield':
            default:
                return 'security-high-symbolic';
        }
    }

    _updatePanelIcon() {
        this._icon.icon_name = this._getIconName(this._isActive);
    }

    _updatePanelLabel() {
        const showLatency = this._settings.get_boolean('show-latency-in-panel');
        if (showLatency && this._isActive && this._lastLatency !== null) {
            this._latencyLabel.text = `${this._lastLatency}ms`;
            this._latencyLabel.visible = true;
        } else {
            this._latencyLabel.visible = false;
        }
    }

    _buildMenu() {
        // 1. Header / Status item
        this._statusItem = new PopupMenu.PopupMenuItem(_('DNSCrypt-Proxy: Checking...'), {
            reactive: false,
        });
        this._statusItem.label.add_style_class_name('dnscrypt-status-inactive');
        this.menu.addMenuItem(this._statusItem);

        // 2. Service Switch
        this._switchItem = new PopupMenu.PopupSwitchMenuItem(_('Encrypted DNS'), false);
        this._switchItem.connect('toggled', (item, state) => {
            if (this._updatingSwitch) {
                return;
            }
            this._onServiceToggled(state);
        });
        this.menu.addMenuItem(this._switchItem);

        // 3. DNS Ping / Latency test
        this._pingItem = new PopupMenu.PopupMenuItem(_('Test Latency (127.0.0.1:53)'));
        this._pingItem.connect('activate', () => {
            this._measureLatency(true);
        });
        this.menu.addMenuItem(this._pingItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 4. Split-DNS Domain Rules Submenu
        this._rulesSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Split-DNS Rules (0)'));
        this.menu.addMenuItem(this._rulesSubMenu);

        // 5. Upstream Resolvers Submenu
        this._resolversSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Upstream Resolvers (0)'));
        this.menu.addMenuItem(this._resolversSubMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 6. Action items
        const restartItem = new PopupMenu.PopupMenuItem(_('Restart Service'));
        restartItem.connect('activate', () => {
            this._restartService();
        });
        this.menu.addMenuItem(restartItem);

        const openUiItem = new PopupMenu.PopupMenuItem(_('Open DNSCrypt UI...'));
        openUiItem.connect('activate', () => {
            this._launchApp();
        });
        this.menu.addMenuItem(openUiItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Extension Settings...'));
        settingsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);

        // Reload config on menu open
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._checkStatus();
                this._loadConfig();
            }
        });
    }

    async _checkStatus() {
        try {
            const { stdout } = await runCommandAsync(['systemctl', 'is-active', 'dnscrypt-proxy']);
            if (this._destroyed) return;

            const active = stdout === 'active';
            this._isActive = active;

            this._updatePanelIcon();

            this._updatingSwitch = true;
            try {
                if (active) {
                    this._statusItem.label.text = _('DNSCrypt-Proxy: Active (Running)');
                    this._statusItem.label.remove_style_class_name('dnscrypt-status-inactive');
                    this._statusItem.label.add_style_class_name('dnscrypt-status-active');
                    this._switchItem.setToggleState(true);

                    // Measure latency if panel display is enabled
                    if (this._settings.get_boolean('show-latency-in-panel')) {
                        this._measureLatency(false);
                    }
                } else {
                    this._statusItem.label.text = _('DNSCrypt-Proxy: Inactive (Stopped)');
                    this._statusItem.label.remove_style_class_name('dnscrypt-status-active');
                    this._statusItem.label.add_style_class_name('dnscrypt-status-inactive');
                    this._switchItem.setToggleState(false);
                    this._lastLatency = null;
                    this._updatePanelLabel();
                }
            } finally {
                this._updatingSwitch = false;
            }
        } catch (e) {
            if (this._destroyed) return;
            this._isActive = false;
            this._updatePanelIcon();
            this._statusItem.label.text = _('DNSCrypt-Proxy: Not Installed / Error');
            this._updatingSwitch = true;
            try {
                this._switchItem.setToggleState(false);
            } finally {
                this._updatingSwitch = false;
            }
        }
    }

    async _onServiceToggled(enable) {
        const action = enable ? 'start' : 'stop';
        try {
            const { exitCode, stderr } = await runCommandAsync(['pkexec', 'systemctl', action, 'dnscrypt-proxy']);
            if (this._destroyed) return;
            if (exitCode !== 0) {
                console.error(`DNSCrypt Indicator: pkexec ${action} failed (code ${exitCode}): ${stderr}`);
            }
            await this._checkStatus();
        } catch (e) {
            if (this._destroyed) return;
            console.error(`DNSCrypt Indicator: Failed to ${action} service:`, e);
            await this._checkStatus();
        }
    }

    async _restartService() {
        try {
            const { exitCode, stderr } = await runCommandAsync(['pkexec', 'systemctl', 'restart', 'dnscrypt-proxy']);
            if (this._destroyed) return;
            if (exitCode === 0) {
                Main.notify(_('DNSCrypt-Proxy'), _('Service restarted successfully.'));
            } else {
                console.error(`DNSCrypt Indicator: restart failed (code ${exitCode}): ${stderr}`);
                Main.notify(_('DNSCrypt-Proxy'), _('Failed to restart service.'));
            }
            await this._checkStatus();
        } catch (e) {
            if (this._destroyed) return;
            console.error('DNSCrypt Indicator: Failed to restart service:', e);
            Main.notify(_('DNSCrypt-Proxy'), _('Failed to restart service.'));
        }
    }

    async _measureLatency(showNotification = false) {
        try {
            const pyScript =
                "import socket, time; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); " +
                "s.settimeout(1.5); t=time.perf_counter(); " +
                "s.sendto(b'\\x12\\x34\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x0acloudflare\\x03com\\x00\\x00\\x01\\x00\\x01', ('127.0.0.1', 53)); " +
                "s.recvfrom(512); print(f'{(time.perf_counter()-t)*1000:.1f}')";

            const { exitCode, stdout } = await runCommandAsync(['python3', '-c', pyScript]);
            if (this._destroyed) return;

            if (exitCode === 0 && stdout) {
                const ms = parseFloat(stdout);
                this._lastLatency = ms;
                this._pingItem.label.text = _(`Ping: ${ms} ms (127.0.0.1:53)`);
                this._updatePanelLabel();
                if (showNotification) {
                    Main.notify(_('DNS Latency Test'), _(`Resolved cloudflare.com in ${ms} ms via 127.0.0.1:53`));
                }
            } else {
                this._pingItem.label.text = _('Ping: Query timed out');
                this._lastLatency = null;
                this._updatePanelLabel();
            }
        } catch (e) {
            if (this._destroyed) return;
            this._pingItem.label.text = _('Ping: Resolution error');
            this._lastLatency = null;
            this._updatePanelLabel();
        }
    }

    async _loadConfig() {
        const configDir = this._settings.get_string('config-dir') || '/etc/dnscrypt-proxy';

        // 1. Read forwarding-rules.txt
        const rulesPath = `${configDir}/forwarding-rules.txt`;
        try {
            const file = Gio.File.new_for_path(rulesPath);
            const [success, contents] = file.load_contents(null);
            if (success) {
                const text = new TextDecoder('utf-8').decode(contents);
                const rules = [];
                for (const line of text.split('\n')) {
                    const l = line.trim();
                    if (!l || l.startsWith('#')) continue;
                    const parts = l.split(/\s+/);
                    if (parts.length >= 2) {
                        rules.push({ domain: parts[0], target: parts[1] });
                    }
                }
                this._rulesSubMenu.label.text = _(`Split-DNS Rules (${rules.length})`);
                this._rulesSubMenu.menu.removeAll();
                if (rules.length === 0) {
                    this._rulesSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('No active rules'), { reactive: false }));
                } else {
                    for (const r of rules.slice(0, 10)) {
                        const item = new PopupMenu.PopupMenuItem(`${r.domain} → ${r.target}`, { reactive: false });
                        this._rulesSubMenu.menu.addMenuItem(item);
                    }
                    if (rules.length > 10) {
                        this._rulesSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(_(`... and ${rules.length - 10} more`), { reactive: false }));
                    }
                }
            }
        } catch (e) {
            console.debug('DNSCrypt Indicator: Could not read forwarding-rules.txt:', e.message);
            this._rulesSubMenu.label.text = _('Split-DNS Rules (0)');
        }

        // 2. Read dnscrypt-proxy.toml for server_names
        const tomlPath = `${configDir}/dnscrypt-proxy.toml`;
        try {
            const file = Gio.File.new_for_path(tomlPath);
            const [success, contents] = file.load_contents(null);
            if (success) {
                const text = new TextDecoder('utf-8').decode(contents);
                const match = text.match(/server_names\s*=\s*\[(.*?)\]/s);
                const servers = [];
                if (match && match[1]) {
                    const raw = match[1];
                    const items = raw.match(/['"](.*?)['"]/g) || [];
                    for (const it of items) {
                        servers.push(it.replace(/['"]/g, ''));
                    }
                }
                this._resolversSubMenu.label.text = _(`Upstream Resolvers (${servers.length})`);
                this._resolversSubMenu.menu.removeAll();
                if (servers.length === 0) {
                    this._resolversSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Automatic / All resolvers'), { reactive: false }));
                } else {
                    for (const s of servers) {
                        this._resolversSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(`• ${s}`, { reactive: false }));
                    }
                }
            }
        } catch (e) {
            this._resolversSubMenu.label.text = _('Upstream Resolvers (0)');
        }
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        const interval = Math.max(2, this._settings.get_int('refresh-interval') || 5);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._checkStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _launchApp() {
        try {
            const appInfo = Gio.DesktopAppInfo.new('io.github.shovon.DNSCryptUI.desktop');
            if (appInfo) {
                appInfo.launch([], null);
                return;
            }
        } catch (e) {
            // fallback below
        }

        try {
            const homeBin = `${GLib.get_home_dir()}/.local/bin/dnscrypt-ui`;
            if (GLib.file_test(homeBin, GLib.FileTest.IS_EXECUTABLE)) {
                GLib.spawn_command_line_async(homeBin);
                return;
            }
            GLib.spawn_command_line_async('dnscrypt-ui');
        } catch (e) {
            console.error('DNSCrypt Indicator: Failed to launch dnscrypt-ui:', e);
            Main.notify(_('DNSCrypt Indicator'), _('Could not launch dnscrypt-ui. Ensure it is in PATH.'));
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        if (this._settingsSignals) {
            for (const id of this._settingsSignals) {
                this._settings.disconnect(id);
            }
            this._settingsSignals = [];
        }

        super.destroy();
    }
});

export default class DNSCryptExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new DNSCryptIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
