import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const SERVICE = 'dnscrypt-proxy.service';
const HELPER = '/usr/local/libexec/dnscrypt-ui-helper';
const APP_ID = 'io.github.shovon.DNSCryptUI.desktop';
const SYSTEMD = 'org.freedesktop.systemd1';
const RESOLVE1 = 'org.freedesktop.resolve1';
const STUB_ADDRESSES = ['127.0.0.53', '127.0.0.54'];
const MIN_LATENCY_INTERVAL = 10;

async function readText(path, cancellable) {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return new TextDecoder('utf-8').decode(contents);
}

async function busCall(bus, name, path, iface, method, params, cancellable, flags = Gio.DBusCallFlags.NONE) {
    const reply = await bus.call(name, path, iface, method, params, null, flags, -1, cancellable);
    return reply.recursiveUnpack();
}

async function getProperty(bus, name, path, iface, prop, cancellable) {
    const [value] = await busCall(bus, name, path, 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', [iface, prop]), cancellable);
    return value;
}

/** Splits 'ip:port' / '[v6]:port' / 'ip' into [host, port]. */
function splitHostPort(addr) {
    addr = addr.trim();
    let m = addr.match(/^\[(.+)\]:(\d+)$/);
    if (m)
        return [m[1], Number(m[2])];
    m = addr.match(/^([^:]+):(\d+)$/);
    if (m)
        return [m[1], Number(m[2])];
    return [addr, 53];
}

function probeTarget(listenAddresses) {
    let [host, port] = splitHostPort(listenAddresses[0] || '127.0.0.1:53');
    if (host === '0.0.0.0')
        host = '127.0.0.1';
    else if (host === '::')
        host = '::1';
    return [host, port];
}

/** Returns the lines of the TOML root table with comments removed. */
function rootTomlLines(text) {
    const lines = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (/^\[[^\]'"]/.test(line))
            break;
        lines.push(line);
    }
    return lines.join('\n');
}

function tomlStringArray(rootText, key) {
    // Strings may contain ']' (e.g. '[::1]:53'), so match whole string items
    const m = rootText.match(new RegExp(`^${key}\\s*=\\s*\\[((?:\\s*(?:'[^']*'|"[^"]*")\\s*,?)*)\\s*\\]`, 'm'));
    if (!m)
        return null;
    return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] ?? x[2]);
}

function parseRules(text) {
    const rules = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const parts = line.split(/\s+/);
        if (parts.length >= 2)
            rules.push({ domain: parts[0], target: parts[1] });
    }
    return rules;
}

/** GNOME 50 deprecates Gio.DesktopAppInfo in favour of GioUnix; older GNOME only has the former. */
async function desktopAppInfo(id) {
    try {
        const {default: GioUnix} = await import('gi://GioUnix');
        if (GioUnix.DesktopAppInfo)
            return GioUnix.DesktopAppInfo.new(id);
    } catch (e) {
        // GLib < 2.80 has no GioUnix typelib
    }
    return Gio.DesktopAppInfo.new(id);
}

/** DNSCrypt UI's privileged helper, only if installed root-owned and not writable by others. */
async function helperInstalled(cancellable) {
    try {
        const info = await Gio.File.new_for_path(HELPER).query_info_async('unix::uid,unix::mode',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_attribute_uint32('unix::uid') === 0 &&
            (info.get_attribute_uint32('unix::mode') & 0o022) === 0;
    } catch (e) {
        return false;
    }
}

/** Runs `pkexec HELPER command`; GNOME Shell shows the authentication dialog. */
async function runHelper(command, cancellable) {
    const proc = Gio.Subprocess.new(['pkexec', HELPER, command],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    const lines = (stdout ?? '').trim().split('\n');
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        const status = proc.get_exit_status();
        if (status === 126 || status === 127)
            return {ok: false, cancelled: true};
        return {ok: false, message: (stderr ?? '').trim() || `pkexec exited with status ${status}`};
    }
}

let fdAddFull = null;
async function getFdAdd() {
    if (!fdAddFull) {
        try {
            fdAddFull = (await import('gi://GLibUnix')).default.fd_add_full;
        } catch (e) {
            fdAddFull = GLib.unix_fd_add_full;
        }
    }
    return fdAddFull;
}

/**
 * Sends an uncacheable query (random name) to dnscrypt-proxy and resolves with
 * the round-trip time in ms, which includes the encrypted upstream hop.
 */
async function measureUpstreamLatency(host, port, registerCancel) {
    if (typeof Gio.Socket.prototype.receive_bytes !== 'function')
        throw new Error(_('Needs GNOME 46 or newer'));
    const fdAdd = await getFdAdd();

    const v6 = host.includes(':');
    const sock = Gio.Socket.new(v6 ? Gio.SocketFamily.IPV6 : Gio.SocketFamily.IPV4,
        Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
    sock.set_blocking(false);

    const id = Math.floor(Math.random() * 0x10000);
    const label = Math.random().toString(36).slice(2, 14);
    const enc = new TextEncoder();
    const qname = [];
    for (const part of [label, 'example', 'com'])
        qname.push(part.length, ...enc.encode(part));
    const packet = new Uint8Array([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...qname, 0, 0, 1, 0, 1]);

    return new Promise((resolve, reject) => {
        let fdId = 0;
        let timeoutId = 0;
        const t0 = GLib.get_monotonic_time();
        const finish = (err, value) => {
            if (fdId)
                GLib.source_remove(fdId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            fdId = timeoutId = 0;
            registerCancel(null);
            sock.close();
            if (err)
                reject(err);
            else
                resolve(value);
        };
        registerCancel(() => finish(new Error('cancelled')));

        try {
            sock.send_to(Gio.InetSocketAddress.new_from_string(host, port), packet, null);
        } catch (e) {
            finish(e);
            return;
        }
        fdId = fdAdd(GLib.PRIORITY_DEFAULT, sock.get_fd(), GLib.IOCondition.IN, () => {
            try {
                const buf = sock.receive_bytes(4096, 0, null).toArray();
                if (buf.length >= 12 && buf[0] === id >> 8 && buf[1] === (id & 0xff)) {
                    fdId = 0;
                    finish(null, (GLib.get_monotonic_time() - t0) / 1000);
                    return GLib.SOURCE_REMOVE;
                }
            } catch (e) {
                // spurious wakeup or ICMP error; keep waiting until the timeout
            }
            return GLib.SOURCE_CONTINUE;
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            timeoutId = 0;
            finish(new Error(_('Query timed out')));
            return GLib.SOURCE_REMOVE;
        });
    });
}

const DNSCryptIndicator = GObject.registerClass(
class DNSCryptIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'DNSCrypt Indicator', false);

        this._extension = extension;
        this._settings = settings;
        this._bus = Gio.DBus.system;
        this._cancellable = new Gio.Cancellable();
        this._signalSubs = [];
        this._latencyTimerId = 0;
        this._cancelLatency = null;

        this._unitPath = null;
        this._loadState = 'unknown';
        this._activeState = 'unknown';
        this._routing = null; // {protected, problems}
        this._lastLatency = null;
        this._listenAddresses = ['127.0.0.1:53'];
        this._loopbackIndex = 1;
        this._updatingSwitch = false;
        this._busy = false;

        this._buildPanelUI();
        this._buildMenu();

        this._settingsSignals = [
            this._settings.connect('changed::show-latency-in-panel', () => this._restartLatencyTimer()),
            this._settings.connect('changed::refresh-interval', () => this._restartLatencyTimer()),
            this._settings.connect('changed::icon-style', () => this._updatePanel()),
            this._settings.connect('changed::config-dir', () => this._loadConfig()),
        ];

        this._setup().catch(e => this._logError('setup', e));
    }

    _logError(what, e) {
        if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
            console.warn(`DNSCrypt Indicator: ${what}: ${e.message}`);
    }

    // UI

    _buildPanelUI() {
        const box = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        this._icon = new St.Icon({ style_class: 'system-status-icon', icon_name: 'network-offline-symbolic' });
        box.add_child(this._icon);
        this._latencyLabel = new St.Label({
            style_class: 'dnscrypt-panel-latency',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._latencyLabel);
        this.add_child(box);
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem(_('dnscrypt-proxy: checking…'), { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        this._routingItem = new PopupMenu.PopupMenuItem(_('System DNS: checking…'), { reactive: false });
        this._routingItem.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(this._routingItem);

        this._switchItem = new PopupMenu.PopupSwitchMenuItem(_('Encrypted DNS'), false);
        this._switchItem.connect('toggled', (_item, state) => {
            if (!this._updatingSwitch)
                this._toggleEncryptedDns(state);
        });
        this.menu.addMenuItem(this._switchItem);

        this._pingItem = new PopupMenu.PopupMenuItem(_('Test upstream latency'));
        this._pingItem.connect('activate', () => this._measureLatency(true));
        this.menu.addMenuItem(this._pingItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rulesSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Domain rules'));
        this.menu.addMenuItem(this._rulesSubMenu);
        this._resolversSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Upstream resolvers'));
        this.menu.addMenuItem(this._resolversSubMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._restartItem = this.menu.addAction(_('Restart Service'), () => this._unitAction('RestartUnit'));
        this.menu.addAction(_('Open DNSCrypt UI'), () => this._launchApp());
        this.menu.addAction(_('Extension Settings'), () => this._extension.openPreferences());

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._refreshUnit();
                this._refreshRouting();
                this._loadConfig();
            }
        });
    }

    _updatePanel() {
        const active = this._activeState === 'active';
        let icon = 'network-offline-symbolic';
        if (active && this._routing && !this._routing.protected) {
            icon = 'security-low-symbolic';
        } else if (!active && this._routing?.protected) {
            // System DNS points at the proxy, which is not running: nothing resolves
            icon = 'network-error-symbolic';
        } else if (active) {
            icon = {
                network: 'network-server-symbolic',
                lock: 'channel-secure-symbolic',
            }[this._settings.get_string('icon-style')] ?? 'security-high-symbolic';
        }
        this._icon.icon_name = icon;

        const showLatency = this._settings.get_boolean('show-latency-in-panel');
        this._latencyLabel.visible = showLatency && active && this._lastLatency !== null;
        if (this._latencyLabel.visible)
            this._latencyLabel.text = _('%d ms').replace('%d', Math.round(this._lastLatency));
    }

    _updateMenu() {
        const label = this._statusItem.label;
        label.remove_style_class_name('dnscrypt-status-active');
        label.remove_style_class_name('dnscrypt-status-inactive');
        if (this._loadState !== 'loaded') {
            label.text = this._loadState === 'unknown'
                ? _('dnscrypt-proxy: checking…')
                : _('dnscrypt-proxy is not installed');
        } else {
            label.text = {
                active: _('dnscrypt-proxy is running'),
                activating: _('dnscrypt-proxy is starting…'),
                deactivating: _('dnscrypt-proxy is stopping…'),
                reloading: _('dnscrypt-proxy is reloading…'),
                failed: _('dnscrypt-proxy failed'),
            }[this._activeState] ?? _('dnscrypt-proxy is stopped');
            label.add_style_class_name(this._activeState === 'active' ? 'dnscrypt-status-active' : 'dnscrypt-status-inactive');
        }

        const transitioning = ['activating', 'deactivating', 'reloading'].includes(this._activeState);
        if (!transitioning) {
            this._updatingSwitch = true;
            this._switchItem.setToggleState(this._activeState === 'active');
            this._updatingSwitch = false;
        }
        this._switchItem.setSensitive(this._loadState === 'loaded' && !transitioning && !this._busy);
        this._restartItem.setSensitive(['active', 'failed'].includes(this._activeState));

        const active = this._activeState === 'active';
        const rl = this._routingItem.label;
        rl.remove_style_class_name('dnscrypt-status-warning');
        if (!this._routing) {
            rl.text = _('System DNS: checking…');
        } else if (!active && this._routing.protected) {
            rl.text = _('DNS is down: system DNS points at dnscrypt-proxy, which is not running');
            rl.add_style_class_name('dnscrypt-status-warning');
        } else if (!active) {
            rl.text = _('Encrypted DNS is off. Using your network\'s DNS servers');
        } else if (this._routing.protected) {
            rl.text = _('System DNS goes through dnscrypt-proxy');
        } else {
            rl.text = `${_('DNS leaks:')} ${this._routing.problems[0]}`;
            rl.add_style_class_name('dnscrypt-status-warning');
        }
    }

    /**
     * With DNSCrypt UI's helper installed, "off" first gives system DNS back to
     * the network and then stops the proxy ("on" reverses it), so turning
     * encrypted DNS off never leaves the computer without DNS.
     */
    async _toggleEncryptedDns(on) {
        this._busy = true;
        this._updateMenu();
        try {
            if (await helperInstalled(this._cancellable)) {
                const result = await runHelper(on ? 'enable' : 'disable', this._cancellable);
                if (!result.ok && !result.cancelled) {
                    let message = result.message ?? '';
                    if (message.startsWith('Unknown command'))
                        message = _('The installed DNSCrypt UI helper is out of date. Run install.sh in the dnscrypt-ui folder.');
                    Main.notify(_('Encrypted DNS'), message);
                }
            } else {
                await this._unitAction(on ? 'StartUnit' : 'StopUnit');
            }
        } catch (e) {
            this._logError('toggle', e);
        } finally {
            this._busy = false;
        }
        this._refreshUnit();
    }

    // Watching systemd and systemd-resolved

    async _setup() {
        try {
            const idx = await readText('/sys/class/net/lo/ifindex', this._cancellable);
            this._loopbackIndex = Number(idx.trim()) || 1;
        } catch (e) {
            // keep the default
        }

        // systemd only emits PropertiesChanged when some client subscribed
        busCall(this._bus, SYSTEMD, '/org/freedesktop/systemd1', `${SYSTEMD}.Manager`, 'Subscribe',
            null, this._cancellable).catch(e => this._logError('Subscribe', e));

        [this._unitPath] = await busCall(this._bus, SYSTEMD, '/org/freedesktop/systemd1',
            `${SYSTEMD}.Manager`, 'LoadUnit', new GLib.Variant('(s)', [SERVICE]), this._cancellable);

        this._signalSubs.push(this._bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', this._unitPath, `${SYSTEMD}.Unit`, Gio.DBusSignalFlags.NONE,
            () => this._refreshUnit()));
        this._signalSubs.push(this._bus.signal_subscribe(RESOLVE1, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', '/org/freedesktop/resolve1', null, Gio.DBusSignalFlags.NONE,
            () => this._refreshRouting()));

        await this._loadConfig();
        await this._refreshUnit();
    }

    async _refreshUnit() {
        if (!this._unitPath)
            return;
        try {
            const [props] = await busCall(this._bus, SYSTEMD, this._unitPath, 'org.freedesktop.DBus.Properties',
                'GetAll', new GLib.Variant('(s)', [`${SYSTEMD}.Unit`]), this._cancellable);
            const wasActive = this._activeState === 'active';
            this._loadState = props.LoadState;
            this._activeState = props.ActiveState;
            if (!wasActive && this._activeState === 'active')
                this._restartLatencyTimer();
            if (this._activeState !== 'active')
                this._lastLatency = null;
        } catch (e) {
            this._logError('unit state', e);
        }
        this._updateMenu();
        this._updatePanel();
        this._refreshRouting();
    }

    async _refreshRouting() {
        try {
            this._routing = await this._checkRouting();
        } catch (e) {
            this._logError('routing', e);
            this._routing = null;
        }
        this._updateMenu();
        this._updatePanel();
    }

    /** Mirrors ServiceManager.check_routing() in DNSCrypt UI. */
    async _checkRouting() {
        const problems = [];
        const [proxyHost, proxyPort] = probeTarget(this._listenAddresses);
        const listenHosts = this._listenAddresses.map(a => splitHostPort(a)[0]);

        const text = await readText('/etc/resolv.conf', this._cancellable);
        const nameservers = text.split('\n')
            .map(l => l.trim().split(/\s+/))
            .filter(p => p[0] === 'nameserver' && p[1])
            .map(p => p[1]);

        for (const ns of nameservers) {
            if (STUB_ADDRESSES.includes(ns) || (listenHosts.includes(ns) && proxyPort === 53))
                continue;
            problems.push(_('resolv.conf sends queries to %s').replace('%s', ns));
        }

        if (nameservers.some(ns => STUB_ADDRESSES.includes(ns))) {
            const servers = await getProperty(this._bus, RESOLVE1, '/org/freedesktop/resolve1',
                `${RESOLVE1}.Manager`, 'DNSEx', this._cancellable);
            let globalOk = false;
            const links = new Map();
            for (const [ifindex, family, raw, port] of servers) {
                const ip = Gio.InetAddress.new_from_bytes(raw, family === 10 ? Gio.SocketFamily.IPV6 : Gio.SocketFamily.IPV4).to_string();
                if (ifindex === 0 || ifindex === this._loopbackIndex) {
                    const proxyIp = Gio.InetAddress.new_from_string(proxyHost)?.to_string();
                    if (ip === proxyIp && (port || 53) === proxyPort)
                        globalOk = true;
                } else {
                    links.set(ifindex, [...links.get(ifindex) ?? [], ip]);
                }
            }
            if (!globalOk)
                problems.push(_('systemd-resolved does not use dnscrypt-proxy'));

            for (const [ifindex, addrs] of links) {
                const [linkPath] = await busCall(this._bus, RESOLVE1, '/org/freedesktop/resolve1',
                    `${RESOLVE1}.Manager`, 'GetLink', new GLib.Variant('(i)', [ifindex]), this._cancellable);
                const defaultRoute = await getProperty(this._bus, RESOLVE1, linkPath,
                    `${RESOLVE1}.Link`, 'DefaultRoute', this._cancellable);
                if (defaultRoute)
                    problems.push(_('a network also uses %s').replace('%s', addrs.join(', ')));
            }
        }
        return { protected: problems.length === 0, problems };
    }

    async _unitAction(method) {
        try {
            await busCall(this._bus, SYSTEMD, '/org/freedesktop/systemd1', `${SYSTEMD}.Manager`, method,
                new GLib.Variant('(ss)', [SERVICE, 'replace']), this._cancellable,
                Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION);
        } catch (e) {
            this._logError(method, e);
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                Main.notify(_('dnscrypt-proxy'), _('Could not change the service: %s').replace('%s', e.message));
        }
        this._refreshUnit();
    }

    // Configuration

    async _loadConfig() {
        const configDir = this._settings.get_string('config-dir') || '/etc/dnscrypt-proxy';
        let root = '';
        try {
            root = rootTomlLines(await readText(`${configDir}/dnscrypt-proxy.toml`, this._cancellable));
        } catch (e) {
            this._logError('reading dnscrypt-proxy.toml', e);
        }

        this._listenAddresses = tomlStringArray(root, 'listen_addresses') ?? ['127.0.0.1:53'];
        const servers = tomlStringArray(root, 'server_names') ?? [];
        this._resolversSubMenu.label.text = _('Upstream resolvers (%d)').replace('%d', servers.length);
        this._resolversSubMenu.menu.removeAll();
        if (servers.length === 0)
            this._resolversSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Automatic'), { reactive: false }));
        for (const s of servers)
            this._resolversSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(s, { reactive: false }));

        const rulesMatch = root.match(/^forwarding_rules\s*=\s*['"]([^'"]+)['"]/m);
        let rules = [];
        if (rulesMatch) {
            const file = rulesMatch[1].startsWith('/') ? rulesMatch[1] : `${configDir}/${rulesMatch[1]}`;
            try {
                rules = parseRules(await readText(file, this._cancellable));
            } catch (e) {
                this._logError('reading forwarding rules', e);
            }
        }
        this._rulesSubMenu.label.text = _('Domain rules (%d)').replace('%d', rules.length);
        this._rulesSubMenu.menu.removeAll();
        if (rules.length === 0)
            this._rulesSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('No active rules'), { reactive: false }));
        for (const r of rules.slice(0, 10))
            this._rulesSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(`${r.domain} → ${r.target}`, { reactive: false }));
        if (rules.length > 10) {
            this._rulesSubMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('…and %d more').replace('%d', rules.length - 10), { reactive: false }));
        }
    }

    // Latency

    _restartLatencyTimer() {
        if (this._latencyTimerId) {
            GLib.source_remove(this._latencyTimerId);
            this._latencyTimerId = 0;
        }
        if (!this._settings.get_boolean('show-latency-in-panel')) {
            this._lastLatency = null;
            this._updatePanel();
            return;
        }
        const interval = Math.max(MIN_LATENCY_INTERVAL, this._settings.get_int('refresh-interval'));
        this._measureLatency(false);
        this._latencyTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (this._activeState === 'active')
                this._measureLatency(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _measureLatency(notify) {
        if (this._activeState !== 'active' || this._cancelLatency)
            return;
        const [host, port] = probeTarget(this._listenAddresses);
        try {
            const ms = await measureUpstreamLatency(host, port, cancel => {
                this._cancelLatency = cancel;
            });
            this._lastLatency = ms;
            this._pingItem.label.text = _('Upstream latency: %s ms').replace('%s', ms.toFixed(1));
            if (notify)
                Main.notify(_('DNS latency'), _('Uncached query answered in %s ms').replace('%s', ms.toFixed(1)));
        } catch (e) {
            if (e.message === 'cancelled')
                return;
            this._lastLatency = null;
            this._pingItem.label.text = _('Latency test failed: %s').replace('%s', e.message);
        }
        this._updatePanel();
    }

    async _launchApp() {
        const appInfo = await desktopAppInfo(APP_ID);
        try {
            if (appInfo) {
                appInfo.launch([], global.create_app_launch_context(0, -1));
                return;
            }
            const homeBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'dnscrypt-ui']);
            const bin = GLib.file_test(homeBin, GLib.FileTest.IS_EXECUTABLE) ? homeBin : 'dnscrypt-ui';
            Gio.Subprocess.new([bin], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._logError('launch', e);
            Main.notify(_('DNSCrypt Indicator'), _('Could not start DNSCrypt UI. Is it installed?'));
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._cancelLatency?.();
        if (this._latencyTimerId) {
            GLib.source_remove(this._latencyTimerId);
            this._latencyTimerId = 0;
        }
        for (const id of this._signalSubs)
            this._bus.signal_unsubscribe(id);
        this._signalSubs = [];
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
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
