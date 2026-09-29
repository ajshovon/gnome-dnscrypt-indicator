import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

export default class DNSCryptIndicatorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('DNSCrypt Indicator Settings'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        // 1. Panel Appearance Group
        const panelGroup = new Adw.PreferencesGroup({
            title: _('Panel & Appearance'),
            description: _('Configure top bar display options'),
        });
        page.add(panelGroup);

        // Show Latency Switch
        const latencyRow = new Adw.SwitchRow({
            title: _('Show DNS Latency in Top Bar'),
            subtitle: _('Measures an uncached query through dnscrypt-proxy and shows the round trip next to the icon'),
        });
        panelGroup.add(latencyRow);
        settings.bind('show-latency-in-panel', latencyRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Icon Style Selector
        const iconValues = ['shield', 'network', 'lock'];
        const iconRow = new Adw.ComboRow({
            title: _('Panel Icon Style'),
            subtitle: _('Shown while DNS is protected. A warning icon replaces it when DNS leaks'),
            model: new Gtk.StringList({
                strings: [
                    _('Security Shield (security-high-symbolic)'),
                    _('Network Server (network-server-symbolic)'),
                    _('System Lock (channel-secure-symbolic)'),
                ],
            }),
        });
        const currentIcon = settings.get_string('icon-style') || 'shield';
        const iconIdx = iconValues.indexOf(currentIcon);
        iconRow.selected = iconIdx >= 0 ? iconIdx : 0;
        iconRow.connect('notify::selected', () => {
            settings.set_string('icon-style', iconValues[iconRow.selected]);
        });
        panelGroup.add(iconRow);

        // Poll Interval
        const intervalRow = new Adw.SpinRow({
            title: _('Latency Refresh Interval (seconds)'),
            subtitle: _('Service state updates instantly; this only controls the panel latency'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        panelGroup.add(intervalRow);
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // 2. Configuration Paths Group
        const pathGroup = new Adw.PreferencesGroup({
            title: _('Configuration Path'),
            description: _('Directory where dnscrypt-proxy.toml and forwarding-rules.txt reside'),
        });
        page.add(pathGroup);

        const configDirRow = new Adw.EntryRow({
            title: _('Config Directory'),
            text: settings.get_string('config-dir') || '/etc/dnscrypt-proxy',
            show_apply_button: true,
        });
        // Save on apply, not on every keystroke (each change re-reads the config)
        configDirRow.connect('apply', () => {
            const val = configDirRow.get_text().trim();
            if (val.startsWith('/'))
                settings.set_string('config-dir', val);
        });
        pathGroup.add(configDirRow);

        // 3. Standalone App Integration Group
        const appGroup = new Adw.PreferencesGroup({
            title: _('Full Management Application'),
            description: _('Manage domain rules, DoH upstreams, and live query logs'),
        });
        page.add(appGroup);

        const launchRow = new Adw.ActionRow({
            title: _('Launch DNSCrypt UI Desktop App'),
            subtitle: _('Open the full YogaDNS-style configuration interface'),
        });
        const launchBtn = new Gtk.Button({
            label: _('Open UI'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        launchBtn.connect('clicked', async () => {
            const appInfo = await desktopAppInfo('io.github.shovon.DNSCryptUI.desktop');
            try {
                if (appInfo) {
                    appInfo.launch([], null);
                    return;
                }
                const homeBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'dnscrypt-ui']);
                const bin = GLib.file_test(homeBin, GLib.FileTest.IS_EXECUTABLE) ? homeBin : 'dnscrypt-ui';
                Gio.Subprocess.new([bin], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error('DNSCrypt Indicator: failed to launch dnscrypt-ui:', e.message);
            }
        });
        launchRow.add_suffix(launchBtn);
        appGroup.add(launchRow);
    }
}
