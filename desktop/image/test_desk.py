import importlib.machinery
import importlib.util
import io
import json
import os
import threading
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('desktop_control', str(Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-control'))
spec = importlib.util.spec_from_loader(loader.name, loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)

DESK_DIR = Path(__file__).parents[1] / 'rootfs/usr/share/omarchy/octo-desktop/desk'
DEFAULT_NOTE = 'This is my computer. Watch me work here, or take the controls whenever you like.'
CONTROL_CALLER = {'Content-Type': 'application/json'}


def entry(directory, name, **fields):
    body = {'Type': 'Application', 'Name': name, 'Exec': name.lower(), 'Categories': 'Office;', **fields}
    (directory / f'{name.lower()}.desktop').write_text('[Desktop Entry]\n' + ''.join(f'{k}={v}\n' for k, v in body.items()) + '[Desktop Action new]\nName=Hidden action\n')


class Fixture:
    def __init__(self, stack):
        self.root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        self.system_apps = self.root / 'usr/share/applications'
        self.user_apps = self.root / 'home/.local/share/applications'
        self.icons = self.root / 'usr/share/icons'
        self.pixmaps = self.root / 'usr/share/pixmaps'
        self.config = self.root / 'home/.config/octogee'
        for d in (self.system_apps, self.user_apps, self.icons, self.pixmaps):
            d.mkdir(parents=True)
        stack.enter_context(patch.dict(os.environ, {
            'HOME': str(self.root / 'home'),
            'XDG_CONFIG_HOME': str(self.root / 'home/.config'),
            'XDG_DATA_HOME': str(self.root / 'home/.local/share'),
            'OCTO_APPLICATION_DIRS': str(self.system_apps),
            'OCTO_ICON_DIRS': f'{self.icons}:{self.pixmaps}',
            'OCTO_DESK_DIR': str(DESK_DIR),
        }))


class DesktopEntryTest(unittest.TestCase):
    def test_lists_visible_applications_and_lets_user_entries_override_system_ones(self):
        with _stack() as stack:
            fx = Fixture(stack)
            entry(fx.system_apps, 'Chromium', Icon='chromium', Comment='Browse the web')
            entry(fx.system_apps, 'Hidden', NoDisplay='true')
            entry(fx.system_apps, 'Shell Tool', Terminal='true')
            entry(fx.system_apps, 'Gone', Hidden='true')
            entry(fx.system_apps, 'Settings', Icon='prefs')
            (fx.system_apps / 'notes.txt').write_text('ignored')
            (fx.system_apps / 'broken.desktop').write_text('garbage')
            (fx.system_apps / 'service.desktop').write_text('[Desktop Entry]\nType=Service\nName=Svc\n')
            entry(fx.user_apps, 'Settings', Icon='mine', Comment='My settings')
            entry(fx.user_apps, 'Gmail', Icon='/nonexistent/gmail.png')
            apps = control.desktop_entries()
            self.assertEqual([a['id'] for a in apps], ['chromium', 'gmail', 'settings'])
            self.assertEqual(apps[0], {'id': 'chromium', 'name': 'Chromium', 'comment': 'Browse the web', 'icon': 'chromium'})
            self.assertEqual(apps[2]['comment'], 'My settings')
            self.assertEqual(apps[2]['icon'], 'mine')

    def test_curates_the_live_omarchy_grid_to_real_applications_with_dock_pins_first(self):
        with _stack() as stack:
            fx = Fixture(stack)
            live = [
                ('chromium', 'Chromium', 'Network;WebBrowser;'),
                ('org.gnome.Nautilus', 'Files', 'GNOME;GTK;System;FileTools;FileManager;Utility;Core;'),
                ('omawrite', 'Omawrite', 'Utility;'),
                ('libreoffice-writer', 'LibreOffice Writer', 'Office;WordProcessor;'),
                ('obsidian', 'Obsidian', 'Office;'),
                ('aether', 'Aether', 'Utility;Settings;'),
                ('bssh', 'Avahi SSH Server Browser', 'Network;RemoteAccess;GTK;'),
                ('bvnc', 'Avahi VNC Server Browser', 'Network;RemoteAccess;GTK;'),
                ('avahi-discover', 'Avahi Zeroconf Browser', 'Network;GTK;'),
                ('discord', 'Discord', 'Network;InstantMessaging;'),
                ('org.gnome.DiskUtility', 'Disks', 'GNOME;GTK;System;Settings;HardwareSettings;'),
                ('org.gnome.Papers', 'Document Viewer', 'GNOME;GTK;Office;Viewer;'),
                ('foot', 'Foot', 'System;TerminalEmulator;'),
                ('foot-client', 'Foot Client', 'System;TerminalEmulator;'),
                ('foot-server', 'Foot Server', 'System;TerminalEmulator;'),
                ('lstopo', 'Hardware Locality lstopo', 'System;Monitor;'),
                ('org.gnome.Loupe', 'Image Viewer', 'GNOME;GTK;Graphics;Viewer;'),
                ('org.kde.kdenlive', 'Kdenlive', 'Qt;KDE;AudioVideo;Video;AudioVideoEditing;'),
                ('libreoffice-startcenter', 'LibreOffice', 'Office;'),
                ('libreoffice-base', 'LibreOffice Base', 'Office;Database;'),
                ('libreoffice-calc', 'LibreOffice Calc', 'Office;Spreadsheet;'),
                ('libreoffice-draw', 'LibreOffice Draw', 'Office;Graphics;'),
                ('libreoffice-impress', 'LibreOffice Impress', 'Office;Presentation;'),
                ('libreoffice-math', 'LibreOffice Math', 'Office;Science;'),
                ('limine-snapper-restore', 'Limine-snapper-restore', 'System;'),
                ('org.localsend.localsend_app', 'LocalSend', 'Network;Utility;'),
                ('cups', 'Manage Printing', 'System;Printing;HardwareSettings;'),
                ('mpv', 'Media Player', 'AudioVideo;Audio;Video;Player;TV;'),
                ('com.moonlight_stream.Moonlight', 'Moonlight', 'Game;'),
                ('com.obsproject.Studio', 'OBS Studio', 'AudioVideo;Recorder;'),
                ('omacalc', 'Omacalc', 'Utility;Calculator;'),
                ('omacut', 'Omacut', 'AudioVideo;Video;AudioVideoEditing;'),
                ('pinta', 'Pinta', 'Graphics;RasterGraphics;'),
                ('system-config-printer', 'Print Settings', 'GNOME;GTK;System;Settings;HardwareSettings;Printing;'),
                ('qv4l2', 'Qt V4L2 test Utility', 'AudioVideo;Video;Qt;'),
                ('qvidcap', 'Qt V4L2 video capture utility', 'AudioVideo;Video;Qt;'),
                ('dev.tensaku.Tensaku', 'Tensaku', 'Utility;Graphics;'),
                ('uuctl', 'uuctl', 'Utility;'),
                ('x11vnc', 'X11VNC Server', 'Network;RemoteAccess;'),
                ('com.github.xournalpp.xournalpp', 'Xournal++', 'Office;Graphics;'),
            ]
            for entry_id, name, categories in live:
                (fx.system_apps / f'{entry_id}.desktop').write_text(f'[Desktop Entry]\nType=Application\nName={name}\nExec={entry_id}\nCategories={categories}\n')
            for entry_id, name, url in [('basecamp', 'Basecamp', 'https://basecamp.com'), ('whatsapp', 'WhatsApp', 'https://web.whatsapp.com'), ('X', 'X', 'https://x.com/'), ('youtube', 'YouTube', 'https://youtube.com')]:
                (fx.user_apps / f'{entry_id}.desktop').write_text(f'[Desktop Entry]\nType=Application\nName={name}\nExec=omarchy-launch-webapp "{url}"\nTerminal=false\n')
            self.assertEqual([a['name'] for a in control.desktop_entries()], [
                'Chromium', 'Files', 'Omawrite', 'LibreOffice Writer', 'Obsidian',
                'Basecamp', 'Discord', 'Document Viewer', 'Image Viewer', 'Kdenlive',
                'LibreOffice', 'LibreOffice Base', 'LibreOffice Calc', 'LibreOffice Draw', 'LibreOffice Impress', 'LibreOffice Math',
                'LocalSend', 'Media Player', 'Moonlight', 'OBS Studio', 'Omacalc', 'Omacut', 'Pinta', 'Tensaku', 'WhatsApp', 'X', 'Xournal++', 'YouTube',
            ])

    def test_drops_hidden_terminal_and_other_desktop_entries_before_the_category_rules(self):
        with _stack() as stack:
            fx = Fixture(stack)
            entry(fx.system_apps, 'Shown', Categories='Office;')
            entry(fx.system_apps, 'Hidden', Categories='Office;', NoDisplay='true')
            entry(fx.system_apps, 'Gone', Categories='Office;', Hidden='true')
            entry(fx.system_apps, 'Shell', Categories='Office;', Terminal='true')
            entry(fx.system_apps, 'Gnomeonly', Categories='Office;', OnlyShowIn='GNOME;')
            entry(fx.system_apps, 'Nothypr', Categories='Office;', NotShowIn='Hyprland;')
            entry(fx.system_apps, 'Hyprok', Categories='Office;', OnlyShowIn='Hyprland;KDE;')
            self.assertEqual([a['name'] for a in control.desktop_entries()], ['Hyprok', 'Shown'])

    def test_pins_follow_the_users_own_dock_configuration(self):
        with _stack() as stack:
            fx = Fixture(stack)
            for name in ('Alpha', 'Chromium', 'Obsidian'):
                entry(fx.system_apps, name, Categories='Office;')
            (fx.root / 'home/.config/omarchy').mkdir(parents=True)
            (fx.root / 'home/.config/omarchy/shell.json').write_text(json.dumps({'plugins': [{'id': 'rdf.dock', 'items': [{'desktop': 'obsidian'}, {'exec': 'omarchy menu'}, {'desktop': 'missing'}]}]}))
            self.assertEqual([a['id'] for a in control.desktop_entries()], ['obsidian', 'alpha', 'chromium'])
            (fx.root / 'home/.config/omarchy/shell.json').write_text('not json')
            self.assertEqual([a['id'] for a in control.desktop_entries()], ['chromium', 'obsidian', 'alpha'])

    def test_platform_pins_replace_dock_configuration_and_admit_utility_entries(self):
        with _stack() as stack:
            fx = Fixture(stack)
            for name in ('Alpha', 'Chromium', 'Obsidian'):
                entry(fx.system_apps, name, Categories='Office;')
            entry(fx.system_apps, 'Terminal', Categories='System;TerminalEmulator;')
            entry(fx.system_apps, 'Sakura', Categories='System;TerminalEmulator;')
            (fx.root / 'home/.config/omarchy').mkdir(parents=True)
            (fx.root / 'home/.config/omarchy/shell.json').write_text(json.dumps({'plugins': [{'id': 'rdf.dock', 'items': [{'desktop': 'obsidian'}]}]}))
            with patch.dict(os.environ, {'OCTO_PINNED_APPS': 'chromium:terminal:../etc:missing'}):
                self.assertEqual([a['id'] for a in control.desktop_entries()], ['chromium', 'terminal', 'alpha', 'obsidian'])

    def test_icons_resolve_absolute_paths_then_scalable_then_largest_then_pixmaps(self):
        with _stack() as stack:
            fx = Fixture(stack)
            absolute = fx.root / 'logo.png'
            absolute.write_bytes(b'png')
            self.assertEqual(control.icon_path(str(absolute)), str(absolute))
            self.assertIsNone(control.icon_path('/nonexistent/logo.png'))
            for size in ('16x16', '48x48', '128x128'):
                (fx.icons / 'Yaru' / size / 'apps').mkdir(parents=True)
                (fx.icons / 'Yaru' / size / 'apps/chromium.png').write_bytes(b'png')
            (fx.icons / 'hicolor/scalable/apps').mkdir(parents=True)
            (fx.icons / 'hicolor/scalable/apps/obsidian.svg').write_text('<svg/>')
            (fx.pixmaps / 'legacy.xpm').write_text('xpm')
            self.assertEqual(control.icon_path('chromium'), str(fx.icons / 'Yaru/128x128/apps/chromium.png'))
            self.assertEqual(control.icon_path('obsidian'), str(fx.icons / 'hicolor/scalable/apps/obsidian.svg'))
            self.assertEqual(control.icon_path('legacy'), str(fx.pixmaps / 'legacy.xpm'))
            self.assertIsNone(control.icon_path('missing'))
            self.assertIsNone(control.icon_path('../etc/passwd'))
            self.assertIsNone(control.icon_path(''))

    def test_launch_runs_only_listed_entries_the_way_the_dock_does(self):
        with _stack() as stack:
            fx = Fixture(stack)
            entry(fx.system_apps, 'Chromium')
            with patch.object(control.subprocess, 'Popen') as popen:
                self.assertEqual(control.launch('chromium'), {'launched': 'chromium'})
                popen.assert_called_once()
                self.assertEqual(popen.call_args.args[0], ['uwsm-app', '--', 'gtk-launch', '--', 'chromium.desktop'])
                self.assertTrue(popen.call_args.kwargs['start_new_session'])
            for bad in ('missing', '../chromium', 'chromium;rm', 'chromium\n', '', 42, None):
                with self.subTest(bad=bad), patch.object(control.subprocess, 'Popen') as popen:
                    with self.assertRaises(ValueError):
                        control.launch(bad)
                    popen.assert_not_called()


class DeskStateTest(unittest.TestCase):
    def test_missing_desk_file_yields_defaults_and_the_shipped_character(self):
        with _stack() as stack:
            Fixture(stack)
            state = control.desk_state()
            self.assertEqual(state['note'], DEFAULT_NOTE)
            self.assertEqual(state['look'], {'style': 'octo', 'color': '#e74e3c'})
            self.assertEqual(state['builderName'], '')
            self.assertEqual(state['agentName'], '')
            self.assertIsNone(state['timeZone'])
            self.assertEqual(state['characterSvg'], (DESK_DIR / 'character.svg').read_text())
            self.assertEqual(state['apps'], [])

    def test_reads_the_agent_written_desk_and_rejects_malformed_fields(self):
        with _stack() as stack:
            fx = Fixture(stack)
            fx.config.mkdir(parents=True)
            (fx.config / 'desk.json').write_text(json.dumps({
                'builderName': 'Chris Eckert', 'agentName': 'Scout', 'look': {'style': 'kit', 'color': '#0ea5e9'},
                'note': 'Back soon.', 'timeZone': 'America/Chicago',
            }))
            (fx.config / 'desk.svg').write_text('<svg data-look="kit"/>')
            state = control.desk_state()
            self.assertEqual(state['builderName'], 'Chris Eckert')
            self.assertEqual(state['agentName'], 'Scout')
            self.assertEqual(state['look'], {'style': 'kit', 'color': '#0ea5e9'})
            self.assertEqual(state['note'], 'Back soon.')
            self.assertEqual(state['timeZone'], 'America/Chicago')
            self.assertEqual(state['characterSvg'], '<svg data-look="kit"/>')
            (fx.config / 'desk.json').write_text(json.dumps({'builderName': 7, 'look': {'style': 'dragon', 'color': 'red'}, 'note': '', 'timeZone': 3}))
            state = control.desk_state()
            self.assertEqual(state['builderName'], '')
            self.assertEqual(state['look'], {'style': 'octo', 'color': '#e74e3c'})
            self.assertEqual(state['note'], DEFAULT_NOTE)
            self.assertIsNone(state['timeZone'])
            (fx.config / 'desk.json').write_text('not json')
            self.assertEqual(control.desk_state()['note'], DEFAULT_NOTE)

    def test_set_note_validates_trims_and_keeps_the_other_fields(self):
        with _stack() as stack:
            fx = Fixture(stack)
            fx.config.mkdir(parents=True)
            (fx.config / 'desk.json').write_text(json.dumps({'builderName': 'Chris', 'look': {'style': 'blob', 'color': '#65a30d'}}))
            self.assertEqual(control.set_note('  Deploying the site.  '), {'note': 'Deploying the site.'})
            saved = json.loads((fx.config / 'desk.json').read_text())
            self.assertEqual(saved, {'builderName': 'Chris', 'look': {'style': 'blob', 'color': '#65a30d'}, 'note': 'Deploying the site.'})
            for bad in ('', '   ', 'x' * 501, 7, None, ['a']):
                with self.subTest(bad=bad):
                    with self.assertRaises(ValueError):
                        control.set_note(bad)
            self.assertEqual(json.loads((fx.config / 'desk.json').read_text())['note'], 'Deploying the site.')

    def test_set_note_creates_the_config_directory_on_a_fresh_home(self):
        with _stack() as stack:
            fx = Fixture(stack)
            control.set_note('Hello')
            self.assertEqual(json.loads((fx.config / 'desk.json').read_text()), {'note': 'Hello'})


class StyleTest(unittest.TestCase):
    def test_hobby_style_is_explicitly_unsupported_without_calling_the_proxy(self):
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run') as run:
            with self.assertRaises(NotImplementedError):
                control.set_style('familiar', '#0ea5e9')
            run.assert_not_called()

    def test_hobby_style_http_response_does_not_reenter_the_action_lock(self):
        h = handler('/style', {'style': 'familiar'}, CONTROL_CALLER)
        with patch.object(control, 'COMPOSITOR', 'openbox'), patch.object(control, 'run') as run, patch.object(h, '_send') as send:
            h.do_POST()
        self.assertEqual(send.call_args.args[0], 501)
        run.assert_not_called()

    def test_runs_octo_desktop_style_with_a_validated_accent(self):
        with patch.object(control, 'run') as run:
            run.return_value.returncode = 0
            self.assertEqual(control.set_style('familiar', '#0ea5e9'), {'style': 'familiar', 'accent': '#0ea5e9'})
            self.assertEqual(run.call_args.args[0], ['octo-desktop-style', 'familiar', '--accent', '#0ea5e9'])
            self.assertEqual(control.set_style('omarchy', None), {'style': 'omarchy', 'accent': None})
            self.assertEqual(run.call_args.args[0], ['octo-desktop-style', 'omarchy'])

    def test_rejects_unknown_styles_and_malformed_accents_before_running(self):
        for style, accent in [('mac', None), ('', None), (None, None), ('familiar', 'blue'), ('familiar', '#FFF'), ('familiar', '#0EA5E9'), ('omarchy', '#0ea5e9')]:
            with self.subTest(style=style, accent=accent), patch.object(control, 'run') as run:
                with self.assertRaises(ValueError):
                    control.set_style(style, accent)
                run.assert_not_called()

    def test_surfaces_a_failed_style_change(self):
        with patch.object(control, 'run') as run:
            run.return_value.returncode = 1
            run.return_value.stderr = b'octo-desktop-style: could not update shell.json'
            with self.assertRaises(RuntimeError) as failure:
                control.set_style('familiar', None)
            self.assertIn('could not update shell.json', str(failure.exception))


class TimeZoneTest(unittest.TestCase):
    def test_sets_a_known_zone_through_timedatectl_and_reports_the_current_one(self):
        with patch.object(control, 'available_timezones', return_value={'America/Chicago'}):
            with patch.object(control, 'run') as run:
                run.return_value.returncode = 0
                self.assertEqual(control.set_time_zone('America/Chicago'), {'timeZone': 'America/Chicago'})
                self.assertEqual(run.call_args.args[0], ['sudo', '-n', '--', 'timedatectl', '--', 'set-timezone', 'America/Chicago'])
                run.return_value.stdout = b'America/Chicago\n'
                self.assertEqual(control.current_time_zone(), {'timeZone': 'America/Chicago'})
                self.assertEqual(run.call_args.args[0], ['timedatectl', 'show', '-p', 'Timezone', '--value'])
            for bad in ('Mars/Olympus', '../etc/passwd', 'America/Chicago; reboot', 'America/Chicago\n', '', 7, None, 'x' * 65, 'America'):
                with self.subTest(bad=bad), patch.object(control, 'run') as run:
                    with self.assertRaises(ValueError):
                        control.set_time_zone(bad)
                    run.assert_not_called()
            with patch.object(control, 'run') as run:
                run.return_value.returncode = 1
                run.return_value.stderr = b'Failed to set time zone: Access denied'
                with self.assertRaises(RuntimeError) as failure:
                    control.set_time_zone('America/Chicago')
                self.assertIn('Access denied', str(failure.exception))


class EgressModeTest(unittest.TestCase):
    def test_records_the_mode_and_restarts_chromium_only_when_the_mode_changes(self):
        with _stack() as stack:
            fx = Fixture(stack)
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            recorded = fx.root / 'home/.config/octogee/egress-mode'
            with patch.object(control.os, 'kill') as kill:
                self.assertEqual(control.set_egress_mode('cloud'), {'mode': 'cloud', 'restarted': False})
                kill.assert_not_called()
                self.assertEqual(recorded.read_text(), 'cloud\n')
                self.assertEqual(control.set_egress_mode('desktop'), {'mode': 'desktop', 'restarted': True})
                kill.assert_called_once_with(4242, control.signal.SIGUSR1)
                self.assertEqual(recorded.read_text(), 'desktop\n')
                kill.reset_mock()
                self.assertEqual(control.set_egress_mode('desktop'), {'mode': 'desktop', 'restarted': False})
                kill.assert_not_called()
                self.assertEqual(control.set_egress_mode('cloud'), {'mode': 'cloud', 'restarted': True})
                kill.assert_called_once_with(4242, control.signal.SIGUSR1)

    def test_leaves_the_recorded_mode_untouched_when_the_gateway_repeats_it(self):
        with _stack() as stack:
            fx = Fixture(stack)
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            recorded = fx.root / 'home/.config/octogee/egress-mode'
            with patch.object(control.os, 'kill'):
                control.set_egress_mode('desktop')
            os.utime(recorded, (1_000_000, 1_000_000))
            with patch.object(control.os, 'kill') as kill:
                self.assertEqual(control.set_egress_mode('desktop'), {'mode': 'desktop', 'restarted': False})
                kill.assert_not_called()
            self.assertEqual(recorded.stat().st_mtime, 1_000_000)

    def test_refuses_an_unknown_mode_and_a_missing_supervisor_without_recording_anything(self):
        with _stack() as stack:
            fx = Fixture(stack)
            recorded = fx.root / 'home/.config/octogee/egress-mode'
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            for bad in ('tor', '', None, 7):
                with self.subTest(bad=bad), patch.object(control.os, 'kill') as kill:
                    with self.assertRaises(ValueError):
                        control.set_egress_mode(bad)
                    kill.assert_not_called()
            os.environ.pop('OCTO_SUPERVISOR_PID')
            with self.assertRaises(RuntimeError):
                control.set_egress_mode('desktop')
            self.assertFalse(recorded.exists())

    def test_keeps_the_previous_mode_when_the_supervisor_cannot_be_signalled_so_a_retry_still_restarts(self):
        with _stack() as stack:
            fx = Fixture(stack)
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            recorded = fx.root / 'home/.config/octogee/egress-mode'
            with patch.object(control.os, 'kill', side_effect=ProcessLookupError(3, 'No such process')):
                with self.assertRaises(RuntimeError):
                    control.set_egress_mode('desktop')
            self.assertFalse(recorded.exists())
            with patch.object(control.os, 'kill'):
                control.set_egress_mode('cloud')
            with patch.object(control.os, 'kill', side_effect=PermissionError(1, 'Operation not permitted')):
                with self.assertRaises(RuntimeError):
                    control.set_egress_mode('desktop')
            self.assertEqual(recorded.read_text(), 'cloud\n')
            with patch.object(control.os, 'kill') as kill:
                self.assertEqual(control.set_egress_mode('desktop'), {'mode': 'desktop', 'restarted': True})
                kill.assert_called_once_with(4242, control.signal.SIGUSR1)

    def test_takes_mode_changes_only_from_callers_a_browser_page_cannot_impersonate(self):
        with _stack() as stack:
            fx = Fixture(stack)
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            recorded = fx.root / 'home/.config/octogee/egress-mode'
            gateway = {'Content-Type': 'application/json', 'X-Octogee-Egress-Control': '1'}
            for headers in ({}, {'Content-Type': 'text/plain'}, {'Content-Type': 'application/json'}, {'X-Octogee-Egress-Control': '1', 'Content-Type': 'text/plain;charset=UTF-8'}):
                with self.subTest(headers=headers):
                    h = handler('/egress', {'mode': 'cloud'}, headers)
                    with patch.object(control.os, 'kill') as kill, patch.object(h, '_send') as send:
                        h.do_POST()
                    self.assertEqual(send.call_args.args[0], 403)
                    kill.assert_not_called()
                    self.assertFalse(recorded.exists())
            h = handler('/egress', {'mode': 'desktop'}, gateway)
            with patch.object(control.os, 'kill'), patch.object(h, '_send') as send:
                h.do_POST()
            self.assertEqual(send.call_args.args, (200, {'mode': 'desktop', 'restarted': True}))
            h = handler('/egress', {'mode': 'tor'}, gateway)
            with patch.object(h, '_send') as send:
                h.do_POST()
            self.assertEqual(send.call_args.args[0], 400)

    def test_applies_a_mode_change_while_a_long_desktop_action_holds_the_action_lock(self):
        with _stack() as stack:
            fx = Fixture(stack)
            stack.enter_context(patch.dict(os.environ, {'OCTO_SUPERVISOR_PID': '4242'}))
            h = handler('/egress', {'mode': 'desktop'}, {'Content-Type': 'application/json', 'X-Octogee-Egress-Control': '1'})
            with control.ACTION_LOCK, patch.object(control.os, 'kill'), patch.object(h, '_send') as send:
                worker = threading.Thread(target=h.do_POST, daemon=True)
                worker.start()
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
            self.assertEqual(send.call_args.args, (200, {'mode': 'desktop', 'restarted': True}))
            self.assertEqual((fx.root / 'home/.config/octogee/egress-mode').read_text(), 'desktop\n')


def handler(path, body=None, headers=None):
    h = object.__new__(control.Handler)
    h.path = path
    raw = b'' if body is None else json.dumps(body).encode()
    h.headers = {'Content-Length': str(len(raw)), **(headers or {})}
    h.server = SimpleNamespace(server_address=('0.0.0.0', 7777))
    h.rfile = io.BytesIO(raw)
    return h


class RoutingTest(unittest.TestCase):
    def test_desk_page_assets_and_state_are_served_without_the_compositor(self):
        with _stack() as stack:
            fx = Fixture(stack)
            with patch.object(control, 'windows', side_effect=AssertionError('compositor must not be consulted')):
                for path, content_type, needle in [
                    ('/desk', 'text/html; charset=utf-8', b'<!doctype html>'),
                    ('/desk/', 'text/html; charset=utf-8', b'<!doctype html>'),
                    ('/desk/desk.js', 'text/javascript; charset=utf-8', b'/desk/state'),
                    ('/desk/desk.css', 'text/css; charset=utf-8', b'.desk'),
                ]:
                    with self.subTest(path=path):
                        h = handler(path)
                        with patch.object(h, '_send') as send:
                            h.do_GET()
                        status, payload, *rest = send.call_args.args
                        self.assertEqual(status, 200)
                        self.assertEqual(rest[0], content_type)
                        self.assertIn(needle, payload)
                h = handler('/desk/state?t=1')
                with patch.object(h, '_send') as send:
                    h.do_GET()
                status, state = send.call_args.args[:2]
                self.assertEqual(status, 200)
                self.assertEqual(state['note'], DEFAULT_NOTE)
                self.assertIn('<svg', state['characterSvg'])
                (fx.root / 'private.js').write_text('private')
                with patch.dict(os.environ, {'OCTO_DESK_DIR': str(fx.root)}):
                    h = handler('/desk/private.js')
                    with patch.object(h, '_send') as send:
                        h.do_GET()
                        self.assertEqual(send.call_args.args[0], 404)
                for missing in ('/desk/../../../etc/passwd', '/desk/nope.js', '/desk/%2e%2e/index.html', '/apps/icon/../../etc/passwd'):
                    with self.subTest(missing=missing):
                        h = handler(missing)
                        with patch.object(h, '_send') as send:
                            h.do_GET()
                        self.assertEqual(send.call_args.args[0], 404)

    def test_apps_and_icons(self):
        with _stack() as stack:
            fx = Fixture(stack)
            (fx.icons / 'hicolor/scalable/apps').mkdir(parents=True)
            (fx.icons / 'hicolor/scalable/apps/chromium.svg').write_text('<svg>chromium</svg>')
            entry(fx.system_apps, 'Chromium', Icon='chromium')
            entry(fx.system_apps, 'Plain')
            h = handler('/apps')
            with patch.object(h, '_send') as send:
                h.do_GET()
            self.assertEqual(send.call_args.args[0], 200)
            self.assertEqual(send.call_args.args[1], [
                {'id': 'chromium', 'name': 'Chromium', 'comment': '', 'icon': '/apps/icon/chromium'},
                {'id': 'plain', 'name': 'Plain', 'comment': '', 'icon': None},
            ])
            h = handler('/apps/icon/chromium')
            with patch.object(h, '_send') as send:
                h.do_GET()
            self.assertEqual(send.call_args.args[:3], (200, b'<svg>chromium</svg>', 'image/svg+xml'))
            for missing in ('/apps/icon/plain', '/apps/icon/none'):
                h = handler(missing)
                with patch.object(h, '_send') as send:
                    h.do_GET()
                self.assertEqual(send.call_args.args[0], 404)

    def test_post_routes_validate_bodies_and_dispatch(self):
        with _stack() as stack:
            fx = Fixture(stack)
            entry(fx.system_apps, 'Chromium')
            cases = [
                ('/launch', {'id': 'chromium'}, 200, 'launch', ('chromium',)),
                ('/launch', {'id': 'missing'}, 400, 'launch', None),
                ('/launch', ['chromium'], 400, 'launch', None),
                ('/desk/note', {'note': 'Working on it.'}, 200, 'set_note', ('Working on it.',)),
                ('/desk/note', {'note': ''}, 400, 'set_note', None),
                ('/style', {'style': 'familiar', 'accent': '#0ea5e9'}, 200, 'set_style', ('familiar', '#0ea5e9')),
                ('/style', {'style': 'omarchy'}, 200, 'set_style', ('omarchy', None)),
                ('/style', {'style': 'mac'}, 400, 'set_style', None),
                ('/timezone', {'timeZone': 'Mars/Olympus'}, 400, 'set_time_zone', None),
                ('/nope', {}, 404, None, None),
            ]
            for path, body, expected, target, args in cases:
                with self.subTest(path=path, body=body):
                    h = handler(path, body, CONTROL_CALLER)
                    patched = patch.object(control, target, wraps=getattr(control, target)) if target else patch.object(control, 'resize')
                    with patched as fn, patch.object(control.subprocess, 'Popen'), patch.object(control, 'run') as run, patch.object(h, '_send') as send:
                        run.return_value.returncode = 0
                        h.do_POST()
                    self.assertEqual(send.call_args.args[0], expected, send.call_args.args)
                    if args is not None:
                        fn.assert_called_once_with(*args)
            h = handler('/timezone')
            with patch.object(control, 'current_time_zone', return_value={'timeZone': 'Etc/UTC'}), patch.object(h, '_send') as send:
                h.do_GET()
            self.assertEqual(send.call_args.args[:2], (200, {'timeZone': 'Etc/UTC'}))
            h = handler('/desk/note', None, CONTROL_CALLER)
            h.headers['Content-Length'] = '99999'
            with patch.object(h, '_send') as send:
                h.do_POST()
            self.assertEqual(send.call_args.args[0], 400)

    def test_takes_state_changes_only_as_json_from_local_callers_or_its_own_pages(self):
        json_type = {'Content-Type': 'application/json'}
        refused = [
            {},
            {'Content-Type': 'text/plain;charset=UTF-8'},
            {'Content-Type': 'application/x-www-form-urlencoded'},
            {'Content-Type': 'text/plain', 'Origin': 'http://127.0.0.1:7777'},
            {**json_type, 'Origin': 'https://attacker.example'},
            {**json_type, 'Origin': 'null'},
            {**json_type, 'Origin': 'http://attacker.example:7777'},
            {**json_type, 'Origin': 'http://127.0.0.1:8080'},
            {**json_type, 'Origin': 'https://127.0.0.1:7777'},
            {**json_type, 'Origin': 'http://127.0.0.1'},
        ]
        accepted = [
            {'Content-Type': 'application/json; charset=utf-8'},
            {**json_type, 'Origin': 'http://127.0.0.1:7777'},
            {**json_type, 'Origin': 'http://localhost:7777'},
        ]
        actions = {'/resize': 'resize', '/launch': 'launch', '/desk/note': 'set_note', '/style': 'set_style', '/timezone': 'set_time_zone'}
        bodies = {'/resize': {'width': 800, 'height': 600}, '/launch': {'id': 'chromium'}, '/desk/note': {'note': 'pwned'}, '/style': {'style': 'omarchy'}, '/timezone': {'timeZone': 'Asia/Tokyo'}}
        with _stack() as stack:
            Fixture(stack)
            for path, target in actions.items():
                for headers in refused:
                    with self.subTest(path=path, headers=headers):
                        h = handler(path, bodies[path], headers)
                        with patch.object(control, target) as action, patch.object(h, '_send') as send:
                            h.do_POST()
                        self.assertEqual(send.call_args.args[0], 403)
                        action.assert_not_called()
                for headers in accepted:
                    with self.subTest(path=path, headers=headers):
                        h = handler(path, bodies[path], headers)
                        with patch.object(control, target, return_value={'ok': True}) as action, patch.object(h, '_send') as send:
                            h.do_POST()
                        self.assertEqual(send.call_args.args, (200, {'ok': True}))
                        action.assert_called_once()

def _stack():
    from contextlib import ExitStack
    return ExitStack()


if __name__ == '__main__':
    unittest.main()
