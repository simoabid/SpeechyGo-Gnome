import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function bindEntry(settings, key, entry) {
    entry.set_text(settings.get_string(key));
    entry.connect('changed', widget => {
        settings.set_string(key, widget.get_text());
    });
}

function bindDropDown(settings, key, dropdown, options) {
    const initialValue = settings.get_string(key);
    const initialIndex = Math.max(0, options.indexOf(initialValue));
    dropdown.set_selected(initialIndex);

    dropdown.connect('notify::selected', widget => {
        const index = widget.get_selected();
        if (index >= 0 && index < options.length) {
            settings.set_string(key, options[index]);
        }
    });
}

function bindStrvEntry(settings, key, entry) {
    const current = settings.get_strv(key);
    entry.set_text(current.length > 0 ? current[0] : '');
    entry.connect('changed', widget => {
        const value = widget.get_text().trim();
        settings.set_strv(key, value ? [value] : []);
    });
}

function createEntryRow(title, subtitle = '') {
    const row = new Adw.ActionRow({
        title,
        subtitle,
    });

    const entry = new Gtk.Entry({
        hexpand: true,
    });

    row.add_suffix(entry);
    row.activatable_widget = entry;

    return {row, entry};
}

function createPasswordRow(title, subtitle = '') {
    const row = new Adw.ActionRow({
        title,
        subtitle,
    });

    const entry = new Gtk.PasswordEntry({
        hexpand: true,
        show_peek_icon: true,
    });

    row.add_suffix(entry);
    row.activatable_widget = entry;

    return {row, entry};
}

export default class SpeechyGoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(760, 720);

        const page = new Adw.PreferencesPage({
            title: 'Speechy Go',
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(page);

        const apiGroup = new Adw.PreferencesGroup({
            title: 'API Keys',
            description: 'Configure your external AI service credentials.',
        });
        page.add(apiGroup);

        const deepgram = createPasswordRow('Deepgram API Key', 'Required for speech-to-text transcription.');
        bindEntry(settings, 'deepgram-api-key', deepgram.entry);
        apiGroup.add(deepgram.row);

        const gemini = createPasswordRow('Gemini API Key', 'Required for text enhancement features.');
        bindEntry(settings, 'gemini-api-key', gemini.entry);
        apiGroup.add(gemini.row);

        const aiGroup = new Adw.PreferencesGroup({
            title: 'AI Behavior',
            description: 'Control Gemini enhancement for speech and standalone text.',
        });
        page.add(aiGroup);

        const enableGeminiRow = new Adw.SwitchRow({
            title: 'Enable Gemini for Speech Results',
            subtitle: 'When enabled, speech transcriptions are post-processed with Gemini.',
        });
        settings.bind('enable-gemini', enableGeminiRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        aiGroup.add(enableGeminiRow);

        const model = createEntryRow('Gemini Model', 'Example: gemini-3-flash-preview');
        bindEntry(settings, 'gemini-model', model.entry);
        aiGroup.add(model.row);

        const sttPrompt = createEntryRow('Speech Enhancement Prompt', 'Prompt used after transcription.');
        bindEntry(settings, 'gemini-prompt', sttPrompt.entry);
        aiGroup.add(sttPrompt.row);

        const enhancePrompt = createEntryRow('Standalone Enhancer Prompt', 'Prompt used for Enhance Clipboard Text action.');
        bindEntry(settings, 'enhance-prompt', enhancePrompt.entry);
        aiGroup.add(enhancePrompt.row);

        const recordingGroup = new Adw.PreferencesGroup({
            title: 'Recording',
            description: 'Select the recording backend used by the companion service.',
        });
        page.add(recordingGroup);

        const backendRow = new Adw.ActionRow({
            title: 'Recording Backend',
            subtitle: 'Auto selects GStreamer, then parecord, then arecord.',
        });
        const backendOptions = ['auto', 'gstreamer', 'parecord', 'arecord'];
        const backendModel = Gtk.StringList.new(backendOptions);
        const backendDropDown = new Gtk.DropDown({
            model: backendModel,
            hexpand: true,
        });
        bindDropDown(settings, 'recording-backend', backendDropDown, backendOptions);
        backendRow.add_suffix(backendDropDown);
        backendRow.activatable_widget = backendDropDown;
        recordingGroup.add(backendRow);

        const shortcut = createEntryRow('Activation Shortcut', 'Default: <Ctrl><Shift>h. Press to start/stop recording.');
        shortcut.entry.set_placeholder_text('<Ctrl><Shift>h');
        bindStrvEntry(settings, 'activation-shortcut', shortcut.entry);
        recordingGroup.add(shortcut.row);

        const autoPasteRow = new Adw.SwitchRow({
            title: 'Auto-paste Transcription',
            subtitle: 'After transcription, restore previous app focus and send Ctrl+V automatically.',
        });
        settings.bind('auto-paste-enabled', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        recordingGroup.add(autoPasteRow);

        const autoPasteDelayRow = new Adw.SpinRow({
            title: 'Auto-paste Delay (ms)',
            subtitle: 'Wait time before synthetic paste after refocusing the target app.',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 2000,
                step_increment: 20,
                page_increment: 100,
                value: settings.get_uint('auto-paste-delay-ms'),
            }),
        });
        autoPasteDelayRow.connect('notify::value', widget => {
            settings.set_uint('auto-paste-delay-ms', Math.floor(widget.value));
        });
        recordingGroup.add(autoPasteDelayRow);

        const liveGroup = new Adw.PreferencesGroup({
            title: 'Live Dictation (Streaming)',
            description: 'Real-time transcription settings for Deepgram WebSocket streaming.',
        });
        page.add(liveGroup);

        const liveShortcut = createEntryRow('Live Dictation Shortcut', 'Default: <Ctrl><Shift>l. Press to start/stop live dictation.');
        liveShortcut.entry.set_placeholder_text('<Ctrl><Shift>l');
        bindStrvEntry(settings, 'live-dictation-shortcut', liveShortcut.entry);
        liveGroup.add(liveShortcut.row);

        const liveModel = createEntryRow('Live Streaming Model', 'Default: nova-2');
        bindEntry(settings, 'live-streaming-model', liveModel.entry);
        liveGroup.add(liveModel.row);

        const liveChunk = new Adw.SpinRow({
            title: 'Streaming Chunk Size (ms)',
            subtitle: 'Audio packet size sent to Deepgram in live mode.',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 500,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_uint('live-streaming-chunk-ms'),
            }),
        });
        liveChunk.connect('notify::value', widget => {
            settings.set_uint('live-streaming-chunk-ms', Math.floor(widget.value));
        });
        liveGroup.add(liveChunk);

        const liveInterimRow = new Adw.SwitchRow({
            title: 'Insert Interim Streaming Results',
            subtitle: 'Shows and updates partial text while speaking (macOS-like behavior).',
        });
        settings.bind('live-streaming-interim-enabled', liveInterimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        liveGroup.add(liveInterimRow);

        const historyGroup = new Adw.PreferencesGroup({
            title: 'History and Notifications',
            description: 'Initial controls for shell UX behavior.',
        });
        page.add(historyGroup);

        const historyRow = new Adw.SpinRow({
            title: 'History Limit',
            subtitle: 'Maximum number of history entries to retain.',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_uint('history-limit'),
            }),
        });
        historyRow.connect('notify::value', widget => {
            settings.set_uint('history-limit', Math.floor(widget.value));
        });
        historyGroup.add(historyRow);

        const notification = createEntryRow('Notification Mode', "Set to 'all', 'errors-only', or 'off'.");
        bindEntry(settings, 'notification-mode', notification.entry);
        historyGroup.add(notification.row);

        const debugRow = new Adw.SwitchRow({
            title: 'Enable Debug Logging',
            subtitle: 'Logs technical diagnostics in GNOME Shell logs. Secrets are never logged.',
        });
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(debugRow);
    }
}
